const express = require("express");
const { getAuth } = require("@clerk/express");
const AlbumCatalog = require("../models/AlbumCatalog");
const AlbumSubmission = require("../models/AlbumSubmission");
const { isModerator, serializeSubmission } = require("./utils/submissions");
const { approveAlbumSubmission } = require("./utils/approval");
const {
  ModerationConflictError,
  ModerationValidationError,
  decodeModerationCursor,
  encodeModerationCursor,
  moderationCursorFilter,
  normalizeCommandBody,
  parseBooleanFilter,
  parseModeratorLimit,
  parseSubmissionTypeFilter,
  parseStatusFilter,
} = require("./utils/moderation");
const { moderationMutationRateLimit } = require("./utils/rateLimit");

const router = express.Router();

function viewer(req) {
  try {
    return getAuth(req).userId || "";
  } catch {
    return "";
  }
}

function authenticate(req, res, next) {
  const userId = viewer(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED" });
  req.userId = userId;
  return next();
}

function moderatorOnly(req, res, next) {
  if (!isModerator(req.userId)) {
    return res.status(403).json({ error: "Moderator access required", code: "MODERATOR_REQUIRED" });
  }
  return next();
}

function moderationEnabled(req, res, next) {
  if (String(process.env.COMMUNITY_MODERATION_ENABLED || "").trim().toLowerCase() !== "true") {
    return res.status(503).json({ error: "Community moderation is currently disabled", code: "MODERATION_DISABLED" });
  }
  return next();
}

function sendError(res, error, fallback) {
  if (error instanceof ModerationValidationError || error?.code === "INVALID_CURSOR") {
    const body = { error: error.message, code: error.code || "INVALID_MODERATION_REQUEST" };
    if (error.details?.length) body.details = error.details;
    return res.status(400).json(body);
  }
  if (error?.code === "SUGGESTION_NOT_FOUND") {
    return res.status(404).json({ error: error.message, code: error.code });
  }
  if (error instanceof ModerationConflictError || error?.status === 409) {
    const body = { error: error.message, code: error.code || "STATE_CONFLICT" };
    if (error.details?.length) body.details = error.details;
    return res.status(409).json(body);
  }
  if (error?.status === 503) {
    return res.status(503).json({ error: error.message, code: error.code || "APPROVAL_UNAVAILABLE" });
  }
  if (error?.name === "ValidationError" || error?.name === "CastError") {
    return res.status(400).json({ error: "Moderation data is invalid", code: "INVALID_MODERATION_REQUEST" });
  }
  return res.status(500).json({ error: fallback });
}

function asPlain(value) {
  return typeof value?.toObject === "function" ? value.toObject() : value;
}

function querySession(query) {
  return query && typeof query.exec === "function" ? query.exec() : query;
}

async function findDetail(submissionId) {
  let query = AlbumSubmission.findOne({ submissionId });
  if (query && typeof query.populate === "function") {
    query = query
      .populate("candidateAlbumCatalogId")
      .populate("approvedAlbumCatalogId")
      .populate("targetAlbumCatalogId")
      .populate({ path: "duplicateOfSubmissionId", populate: { path: "approvedAlbumCatalogId" } })
      .populate("candidateSubmissionIds");
  }
  return querySession(query);
}

async function rowsForIds(Model, ids) {
  const uniqueIds = [...new Set(ids.filter(Boolean).map((id) => String(id)))];
  if (!uniqueIds.length || typeof Model.find !== "function") return [];
  let query = Model.find({ _id: { $in: uniqueIds } });
  if (Model === AlbumSubmission && query && typeof query.populate === "function") {
    query = query.populate("approvedAlbumCatalogId");
  }
  if (query && typeof query.exec === "function") query = query.exec();
  const rows = (await query) || [];
  return rows.filter((row) => uniqueIds.includes(String(asPlain(row)?._id)));
}

function matchTypesByTarget(signals, field, targetType) {
  const matches = new Map();
  (signals || []).forEach((signal) => {
    if (signal.targetType !== targetType || !signal[field]) return;
    const key = String(signal[field]);
    if (!matches.has(key)) matches.set(key, new Set());
    matches.get(key).add(signal.matchType);
  });
  return matches;
}

async function duplicateCandidates(submission) {
  const source = asPlain(submission) || {};
  const signals = source.duplicateSignals || [];
  const catalogMatchTypes = matchTypesByTarget(signals, "albumCatalogId", "catalog");
  const submissionMatchTypes = matchTypesByTarget(signals, "submissionId", "submission");
  const catalogRefs = [source.candidateAlbumCatalogId, ...catalogMatchTypes.keys()]
    .map((value) => asPlain(value)?._id || value)
    .filter(Boolean);
  const submissionRefs = [source.duplicateOfSubmissionId, ...(source.candidateSubmissionIds || []), ...submissionMatchTypes.keys()]
    .map((value) => asPlain(value)?._id || value)
    .filter(Boolean);
  const [catalogRows, submissionRows] = await Promise.all([
    rowsForIds(AlbumCatalog, catalogRefs),
    rowsForIds(AlbumSubmission, submissionRefs),
  ]);
  const catalogMap = new Map(catalogRows.map((row) => [String(asPlain(row)._id), asPlain(row)]));
  const submissionMap = new Map(submissionRows.map((row) => [String(asPlain(row)._id), asPlain(row)]));
  const populatedCatalog = catalogRefs.map((value) => asPlain(value)).find((value) => value?.albumId);
  if (populatedCatalog) catalogMap.set(String(populatedCatalog._id), populatedCatalog);
  const populatedSubmissions = submissionRefs.map((value) => asPlain(value)).filter((value) => value?.submissionId);
  populatedSubmissions.forEach((value) => submissionMap.set(String(value._id), value));

  const albums = [...catalogMap.values()].map((album) => ({
    albumId: album.albumId,
    title: album.title || "",
    artistDisplayName: album.artistDisplayName || "",
    releaseType: album.releaseType || "album",
    releaseDate: album.releaseDate || "",
    matchTypes: [...(catalogMatchTypes.get(String(album._id)) || [])],
  })).filter((album) => album.albumId);
  const submissions = [...submissionMap.values()].map((candidate) => ({
    submissionId: candidate.submissionId,
    submittedByUserId: candidate.submittedByUserId,
    status: candidate.status,
    proposedMetadata: candidate.proposedMetadata,
    createdAt: candidate.createdAt,
    matchTypes: [...(submissionMatchTypes.get(String(candidate._id)) || [])],
    approvedAlbumId: asPlain(candidate.approvedAlbumCatalogId)?.albumId || undefined,
  })).filter((candidate) => candidate.submissionId);
  return { catalogAlbums: albums, submissions };
}

function moderatorSummary(submission) {
  const serialized = serializeSubmission(submission);
  const source = asPlain(submission) || {};
  return {
    ...serialized,
    sourceCount: Array.isArray(source.supportingSources) ? source.supportingSources.length : 0,
    sourceTypes: [...new Set((source.supportingSources || []).map((sourceItem) => sourceItem.type).filter(Boolean))],
  };
}

async function moderatorDetail(submission) {
  return {
    suggestion: serializeSubmission(submission, { detail: true, moderator: true }),
    duplicateCandidates: await duplicateCandidates(submission),
  };
}

function stateQuery(submissionId, currentRevision) {
  return { submissionId, status: "pending", currentRevision };
}

async function transition(req, res, action) {
  try {
    const body = normalizeCommandBody(req.body || {}, action);
    const historyAction = {
      mark_duplicate: "marked_duplicate",
      reject: "rejected",
    }[action] || action;
    const current = await AlbumSubmission.findOne({ submissionId: req.params.submissionId });
    if (!current) return res.status(404).json({ error: "Suggestion not found", code: "SUGGESTION_NOT_FOUND" });
    if (current.status !== "pending") {
      return res.status(409).json({ error: "Only pending suggestions can be moderated", code: "INVALID_SUBMISSION_STATE" });
    }

    const now = new Date();
    const set = {
      status: action === "request_changes" ? "needs_changes" : action === "reject" ? "rejected" : "duplicate",
      approvedAlbumCatalogId: null,
      duplicateOfSubmissionId: null,
    };
    if (action === "mark_duplicate") {
      const target = await AlbumSubmission.findOne({ submissionId: body.duplicateOfSubmissionId });
      if (!target || target.submissionId === current.submissionId || target.status !== "approved" || !target.approvedAlbumCatalogId) {
        return res.status(409).json({ error: "duplicateOfSubmissionId must reference another approved suggestion", code: "INVALID_DUPLICATE_TARGET" });
      }
      set.duplicateOfSubmissionId = target._id;
    }
    const updated = await AlbumSubmission.findOneAndUpdate(
      stateQuery(req.params.submissionId, current.currentRevision),
      {
        $set: set,
        $push: {
          moderationHistory: {
            actorUserId: req.userId,
            action: historyAction,
            reason: body.reason,
            createdAt: now,
          },
        },
      },
      { returnDocument: "after", runValidators: true },
    );
    if (!updated) return res.status(409).json({ error: "Suggestion changed while it was being moderated", code: "STATE_CONFLICT" });
    const detail = await findDetail(req.params.submissionId);
    return res.json(await moderatorDetail(detail || updated));
  } catch (error) {
    return sendError(res, error, "Failed to apply moderation command");
  }
}

// Tells the signed-in viewer whether they are a moderator, so the UI can hide
// moderation links. It reveals only the caller's own status, never the
// moderator list, and is not an authorization check: every moderation route
// still enforces moderatorOnly itself. Registered before /:submissionId.
router.get("/access", authenticate, (req, res) => {
  res.json({ moderator: isModerator(req.userId) });
});

router.get("/", authenticate, moderatorOnly, async (req, res) => {
  try {
    const statuses = parseStatusFilter(req.query?.status);
    const submissionType = parseSubmissionTypeFilter(req.query?.submissionType);
    const hasPossibleDuplicate = parseBooleanFilter(req.query?.hasPossibleDuplicate, "hasPossibleDuplicate");
    const limit = parseModeratorLimit(req.query?.limit);
    const cursor = decodeModerationCursor(req.query?.cursor);
    const query = {
      status: statuses.length === 1 ? statuses[0] : { $in: statuses },
    };
    if (submissionType) query.submissionType = submissionType;
    const additionalFilters = [];
    const cursorQuery = moderationCursorFilter(cursor);
    if (Object.keys(cursorQuery).length) additionalFilters.push(cursorQuery);
    if (req.query?.submittedByUserId !== undefined) {
      if (typeof req.query.submittedByUserId !== "string" || !req.query.submittedByUserId.trim() || req.query.submittedByUserId.length > 128) {
        throw new ModerationValidationError("submittedByUserId must be a non-empty value of 128 characters or fewer");
      }
      query.submittedByUserId = req.query.submittedByUserId.trim();
    }
    const duplicateConditions = [
      { candidateAlbumCatalogId: { $ne: null } },
      { "candidateSubmissionIds.0": { $exists: true } },
      { "duplicateSignals.0": { $exists: true } },
    ];
    if (hasPossibleDuplicate === true) additionalFilters.push({ $or: duplicateConditions });
    if (hasPossibleDuplicate === false) additionalFilters.push({ $nor: duplicateConditions });
    if (additionalFilters.length) query.$and = additionalFilters;
    let result = AlbumSubmission.find(query);
    if (result && typeof result.populate === "function") result = result.populate("targetAlbumCatalogId");
    if (result && typeof result.sort === "function") result = result.sort({ updatedAt: 1, _id: 1 });
    if (result && typeof result.limit === "function") result = result.limit(limit + 1);
    const rows = (await querySession(result)) || [];
    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return res.json({
      suggestions: page.map(moderatorSummary),
      nextCursor: hasNextPage && last ? encodeModerationCursor(last.updatedAt, last._id) : null,
    });
  } catch (error) {
    return sendError(res, error, "Failed to fetch moderation queue");
  }
});

router.get("/:submissionId", authenticate, moderatorOnly, async (req, res) => {
  try {
    const submission = await findDetail(req.params.submissionId);
    if (!submission) return res.status(404).json({ error: "Suggestion not found", code: "SUGGESTION_NOT_FOUND" });
    return res.json(await moderatorDetail(submission));
  } catch (error) {
    return sendError(res, error, "Failed to fetch moderation detail");
  }
});

router.post("/:submissionId/request-changes", authenticate, moderatorOnly, moderationEnabled, moderationMutationRateLimit, (req, res) => transition(req, res, "request_changes"));
router.post("/:submissionId/reject", authenticate, moderatorOnly, moderationEnabled, moderationMutationRateLimit, (req, res) => transition(req, res, "reject"));
router.post("/:submissionId/mark-duplicate", authenticate, moderatorOnly, moderationEnabled, moderationMutationRateLimit, (req, res) => transition(req, res, "mark_duplicate"));

router.post("/:submissionId/approve", authenticate, moderatorOnly, moderationEnabled, moderationMutationRateLimit, async (req, res) => {
  try {
    const body = normalizeCommandBody(req.body || {}, "approve");
    const result = await approveAlbumSubmission({
      submissionId: req.params.submissionId,
      actorUserId: req.userId,
      ...body,
    });
    return res.json(result);
  } catch (error) {
    return sendError(res, error, "Failed to approve suggestion");
  }
});

module.exports = router;
