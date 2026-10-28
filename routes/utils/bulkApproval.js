// Bulk approval of community suggestions. Each item is approved on its own,
// one after another, through the same transactional approval as a single
// approve, so every item commits or fails alone and reports its own result.
// Bulk only approves "as proposed": the server derives each item's approval
// body, and items that need a moderator's call are refused per item with
// BULK_REVIEW_REQUIRED instead of being guessed at.

const AlbumSubmission = require("../../models/AlbumSubmission");
const { Genre } = require("../../models/Genre");
const BaselineModels = require("../../models/AlbumBaseline");
const { approveAlbumSubmission } = require("./approval");
const { CORRECTION_FIELD_GROUPS } = require("./submissions");
const {
  ApprovalUnavailableError,
  ModerationValidationError,
  publicUuid,
} = require("./moderation");

const MAX_BULK_APPROVALS = 20;
const ITEM_KEYS = new Set(["submissionId", "expectedRevision"]);

// Why an item can't be approved in bulk. Reported in error details and in
// the queue's bulkApproval summary.
const REVIEW_REASONS = {
  possibleDuplicate: "possible_duplicate",
  unmatchedGenreName: "unmatched_genre_name",
  staleBaselineSelection: "stale_baseline_selection",
  noProposedFields: "no_proposed_fields",
};

function plain(value) {
  return typeof value?.toObject === "function" ? value.toObject() : value;
}

function fail(message, code) {
  throw new ModerationValidationError(message, code);
}

function optionalReason(value) {
  if (value === undefined) return "";
  if (typeof value !== "string") fail("reason must be a string");
  const reason = value.trim();
  if (reason.length > 1000) fail("reason must be 1000 characters or fewer");
  return reason;
}

function normalizeBulkApprovalBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) fail("request body must be an object");
  Object.keys(body).forEach((key) => {
    if (!["items", "reason"].includes(key)) fail(`request body.${key} is not allowed`);
  });
  if (!Array.isArray(body.items) || !body.items.length) fail("items must contain at least one suggestion");
  if (body.items.length > MAX_BULK_APPROVALS) {
    fail(`At most ${MAX_BULK_APPROVALS} suggestions can be approved at once`, "BULK_LIMIT_EXCEEDED");
  }
  const seen = new Set();
  const items = body.items.map((item, index) => {
    const path = `items[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) fail(`${path} must be an object`);
    Object.keys(item).forEach((key) => {
      if (!ITEM_KEYS.has(key)) fail(`${path}.${key} is not allowed`);
    });
    const submissionId = publicUuid(item.submissionId, `${path}.submissionId`);
    if (seen.has(submissionId)) fail(`${path}.submissionId is listed more than once`);
    seen.add(submissionId);
    if (!Number.isSafeInteger(item.expectedRevision) || item.expectedRevision < 1) {
      fail(`${path}.expectedRevision must be a positive integer`);
    }
    return { submissionId, expectedRevision: item.expectedRevision };
  });
  return { items, reason: optionalReason(body.reason) };
}

function hasDuplicateSignals(source) {
  return Boolean(
    source.candidateAlbumCatalogId
    || (source.candidateSubmissionIds || []).length
    || (source.duplicateSignals || []).length,
  );
}

function newGenreNames(source) {
  return (source.genreChanges?.additions || [])
    .filter((entry) => entry.newGenre)
    .map((entry) => entry.newGenre.normalizedName);
}

// Active genres whose name or alias exactly matches one of the keys, by key.
async function activeGenresByName(keys) {
  const unique = [...new Set(keys)];
  if (!unique.length) return new Map();
  const rows = await Genre.find({
    status: "active",
    $or: [{ normalizedName: { $in: unique } }, { "aliases.normalizedName": { $in: unique } }],
  }).select("genreId normalizedName aliases").lean();
  const byName = new Map();
  rows.forEach((genre) => {
    [genre.normalizedName, ...(genre.aliases || []).map((alias) => alias.normalizedName)]
      .filter((key) => unique.includes(key))
      .forEach((key) => byName.set(key, genre));
  });
  return byName;
}

// Submission ids whose reviewed tracklist baseline was chosen for an older
// revision. Single approval would skip publishing it, so bulk asks for review.
async function staleBaselineSelections(submissions) {
  const revisions = new Map(submissions.map((source) => [source.submissionId, source.currentRevision]));
  if (!revisions.size) return new Set();
  const heads = await BaselineModels.Head.find({
    targetKind: "submissions",
    targetId: { $in: [...revisions.keys()] },
    status: "reviewed",
  }).select("targetId targetRevision").lean();
  return new Set(heads
    .filter((head) => Number(head.targetRevision) !== revisions.get(head.targetId))
    .map((head) => head.targetId));
}

function genreDecisionsAsProposed(source, genresByName) {
  const changes = source.genreChanges || {};
  const add = [];
  for (const entry of changes.additions || []) {
    if (!entry.newGenre) {
      add.push({ decision: "apply" });
      continue;
    }
    const match = genresByName.get(entry.newGenre.normalizedName);
    if (!match) return null;
    add.push({ decision: "apply", resolution: { action: "map", genreId: match.genreId } });
  }
  const decisions = { add, remove: (changes.removals || []).map(() => ({ decision: "apply" })) };
  if (changes.primary) decisions.primary = "apply";
  return decisions;
}

function correctionFieldsAsProposed(source) {
  const proposed = new Set(Object.keys(source.proposedChanges || {}));
  return CORRECTION_FIELD_GROUPS.filter((field) => proposed.has(field));
}

// Works out, for each pending suggestion, the approval body bulk would send
// or why it needs a moderator's review. Looks up genres and baselines once
// for the whole list. Returns a Map keyed by submissionId.
async function bulkApprovalPlans(values) {
  const pending = values.map(plain).filter((source) => source?.status === "pending");
  const [genresByName, staleBaselines] = await Promise.all([
    activeGenresByName(pending.filter((source) => source.submissionType === "genre_suggestion").flatMap(newGenreNames)),
    staleBaselineSelections(pending.filter((source) => (source.submissionType || "new_album") === "new_album")),
  ]);
  const plans = new Map();
  pending.forEach((source) => {
    const type = source.submissionType || "new_album";
    let plan;
    if (type === "genre_suggestion") {
      const genreDecisions = genreDecisionsAsProposed(source, genresByName);
      plan = genreDecisions
        ? { eligible: true, body: { genreDecisions } }
        : { eligible: false, reason: REVIEW_REASONS.unmatchedGenreName };
    } else if (type === "catalog_correction") {
      const applyFields = correctionFieldsAsProposed(source);
      plan = applyFields.length
        ? { eligible: true, body: { applyFields } }
        : { eligible: false, reason: REVIEW_REASONS.noProposedFields };
    } else if (hasDuplicateSignals(source)) {
      plan = { eligible: false, reason: REVIEW_REASONS.possibleDuplicate };
    } else if (staleBaselines.has(source.submissionId)) {
      plan = { eligible: false, reason: REVIEW_REASONS.staleBaselineSelection };
    } else {
      plan = { eligible: true, body: {} };
    }
    plans.set(source.submissionId, plan);
  });
  return plans;
}

// The queue's public view of a plan: eligibility and the reason, never the
// derived body.
async function bulkApprovalSummaries(values) {
  const plans = await bulkApprovalPlans(values);
  return new Map([...plans].map(([submissionId, plan]) => [
    submissionId,
    plan.eligible ? { eligible: true } : { eligible: false, reason: plan.reason },
  ]));
}

function itemError(error) {
  const body = { code: error?.code || "APPROVAL_FAILED", message: error?.message || "Approval failed" };
  if (Array.isArray(error?.details) && error.details.length) body.details = error.details;
  return body;
}

function isItemFailure(error) {
  return error instanceof ModerationValidationError || error?.status === 400 || error?.status === 409
    || error?.code === "SUGGESTION_NOT_FOUND"
    || error?.name === "ValidationError" || error?.name === "CastError";
}

async function approveItem({ item, reason, actorUserId, approve }) {
  const source = plain(await AlbumSubmission.findOne({ submissionId: item.submissionId }));
  if (!source) return { ok: false, error: { code: "SUGGESTION_NOT_FOUND", message: "Suggestion not found" } };
  if (source.status === "pending" && source.currentRevision !== item.expectedRevision) {
    return { ok: false, error: { code: "STATE_CONFLICT", message: "The suggestion was revised after the queue was loaded" } };
  }
  let body = {};
  if (source.status === "pending") {
    const plan = (await bulkApprovalPlans([source])).get(source.submissionId);
    if (!plan.eligible) {
      return {
        ok: false,
        error: { code: "BULK_REVIEW_REQUIRED", message: "This suggestion needs an individual review", details: [plan.reason] },
      };
    }
    body = plan.body;
  }
  // Already-approved and other non-pending suggestions go through the normal
  // approval too, which reports an idempotent success or the state conflict.
  const result = await approve({
    submissionId: item.submissionId,
    actorUserId,
    reason,
    expectedRevision: item.expectedRevision,
    ...body,
  });
  const albumId = result.album?.albumId;
  return { ok: true, idempotent: result.idempotent === true, ...(albumId ? { albumId, albumUrl: result.albumUrl } : {}) };
}

// Approves the items one at a time. A transaction outage stops the run: if
// nothing was approved yet the whole request fails with 503, otherwise the
// remaining items report APPROVAL_UNAVAILABLE.
async function bulkApprove({ items, reason = "", actorUserId, approve = approveAlbumSubmission }) {
  const results = [];
  let unavailable = false;
  for (const item of items) {
    if (unavailable) {
      results.push({ submissionId: item.submissionId, ok: false, error: itemError(new ApprovalUnavailableError()) });
      continue;
    }
    try {
      results.push({ submissionId: item.submissionId, ...await approveItem({ item, reason, actorUserId, approve }) });
    } catch (error) {
      if (error instanceof ApprovalUnavailableError || error?.status === 503) {
        if (!results.some((result) => result.ok)) throw new ApprovalUnavailableError();
        unavailable = true;
        results.push({ submissionId: item.submissionId, ok: false, error: itemError(new ApprovalUnavailableError()) });
        continue;
      }
      if (!isItemFailure(error)) {
        console.error("Bulk approval item failed unexpectedly.", error);
        results.push({ submissionId: item.submissionId, ok: false, error: { code: "APPROVAL_FAILED", message: "Approval failed" } });
        continue;
      }
      results.push({ submissionId: item.submissionId, ok: false, error: itemError(error) });
    }
  }
  const approved = results.filter((result) => result.ok && !result.idempotent).length;
  const alreadyApproved = results.filter((result) => result.ok && result.idempotent).length;
  return {
    results,
    summary: { requested: items.length, approved, alreadyApproved, failed: results.length - approved - alreadyApproved },
  };
}

module.exports = {
  MAX_BULK_APPROVALS,
  REVIEW_REASONS,
  bulkApprovalPlans,
  bulkApprovalSummaries,
  bulkApprove,
  normalizeBulkApprovalBody,
};
