const express = require("express");
const { getAuth } = require("@clerk/express");
const AlbumCatalog = require("../models/AlbumCatalog");
const AlbumSubmission = require("../models/AlbumSubmission");
const {
  APPROVAL_PUBLICATION_TYPES,
  approvedCursorFilter,
  SubmissionValidationError,
  cursorFilter,
  decodeApprovedCursor,
  decodeCursor,
  encodeApprovedCursor,
  encodeCursor,
  findDuplicateSignals,
  getPageLimit,
  isModerator,
  isSubmissionsEnabled,
  normalizeCorrectionPayload,
  normalizeSubmissionPayload,
  correctionSnapshot,
  plain,
  serializeApprovedFeedItem,
  serializeSubmission,
  snapshotForSubmission,
} = require("./utils/submissions");
const {
  genreSuggestionRateLimit,
  submissionCreateRateLimit,
  submissionMutationRateLimit,
} = require("./utils/rateLimit");
const { isGenresEnabled } = require("./utils/serverConfig");
const {
  assertNewGenreAllowance,
  genreSuggestionFields,
  genreSuggestionSnapshot,
  normalizeGenreSuggestion,
  openGenreSuggestionKey,
} = require("../lib/genres/suggestions");
const { buildSearchPattern } = require("./utils/catalogSearch");

const router = express.Router();

function viewer(req) {
  try {
    return getAuth(req).userId || "";
  } catch {
    return "";
  }
}

function auth(req, res, next) {
  const userId = viewer(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  req.userId = userId;
  return next();
}

function submissionsEnabled(req, res, next) {
  if (!isSubmissionsEnabled()) {
    return res.status(503).json({ error: "Community submissions are currently disabled", code: "SUBMISSIONS_DISABLED" });
  }
  return next();
}

function sendRouteError(res, error, fallback) {
  if (error instanceof SubmissionValidationError || error?.code === "INVALID_CURSOR") {
    const body = { error: error.message, code: error.code || "INVALID_SUBMISSION" };
    if (error.details?.length) body.details = error.details;
    return res.status(400).json(body);
  }
  if (error?.name === "ValidationError" || error?.name === "CastError") {
    return res.status(400).json({ error: "Submission data is invalid", code: "INVALID_SUBMISSION" });
  }
  if (error?.status && error.status >= 400 && error.status < 500) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  return res.status(500).json({ error: fallback });
}

function genresEnabled(req, res, next) {
  if (!isGenresEnabled()) return res.status(503).json({ error: "Genres are currently disabled", code: "GENRES_DISABLED" });
  return next();
}

function isOpenGenreKeyConflict(error) {
  return error?.code === 11000 && Object.keys(error.keyPattern || error.keyValue || {}).includes("openGenreSuggestionKey");
}

function genreSuggestionExists(res, submissionId) {
  return res.status(409).json({
    error: "You already have an open genre suggestion for this album. Withdraw it, or revise it if a moderator asked for changes.",
    code: "GENRE_SUGGESTION_EXISTS",
    ...(submissionId ? { details: [{ submissionId }] } : {}),
  });
}

async function findSubmission(query) {
  let result = AlbumSubmission.findOne(query);
  if (result && typeof result.populate === "function") {
    result = result
      .populate("candidateAlbumCatalogId")
      .populate("approvedAlbumCatalogId")
      .populate("targetAlbumCatalogId")
      .populate({ path: "duplicateOfSubmissionId", populate: { path: "approvedAlbumCatalogId" } });
  }
  return result;
}

function submissionUpdate(payload, duplicate, revision, status) {
  return {
    proposedMetadata: payload.proposedMetadata,
    supportingSources: payload.supportingSources,
    externalReferences: payload.externalReferences,
    normalizedFingerprint: duplicate.fingerprint,
    candidateAlbumCatalogId: duplicate.candidateAlbumCatalogId || null,
    candidateSubmissionIds: duplicate.candidateSubmissionIds,
    duplicateSignals: duplicate.duplicateSignals,
    currentRevision: revision,
    status,
  };
}

function correctionUpdate(payload, revision, status) {
  return {
    submissionType: "catalog_correction",
    targetAlbumCatalogId: payload.targetAlbumCatalogId,
    baseCatalogRevision: payload.baseCatalogRevision,
    baseValues: payload.baseValues,
    baseProvenance: payload.baseProvenance,
    proposedChanges: payload.proposedChanges,
    supportingSources: payload.supportingSources,
    externalReferences: [],
    normalizedFingerprint: payload.normalizedFingerprint,
    candidateAlbumCatalogId: null,
    candidateSubmissionIds: [],
    duplicateSignals: [],
    currentRevision: revision,
    status,
  };
}

async function queryResult(query) {
  return query && typeof query.exec === "function" ? query.exec() : query;
}

router.post("/", auth, submissionsEnabled, submissionCreateRateLimit, async (req, res) => {
  try {
    const payload = normalizeSubmissionPayload(req.body);
    const duplicate = await findDuplicateSignals(payload);
    const submittedAt = new Date();
    const snapshot = snapshotForSubmission(payload, duplicate, submittedAt, 1);
    const submission = await AlbumSubmission.create({
      submittedByUserId: req.userId,
      submissionType: "new_album",
      ...submissionUpdate(payload, duplicate, 1, "pending"),
      revisions: [snapshot],
      moderationHistory: [{ actorUserId: req.userId, action: "submitted", reason: "", createdAt: submittedAt }],
    });
    return res.status(201).json(serializeSubmission(submission, { detail: true }));
  } catch (error) {
    return sendRouteError(res, error, "Failed to create suggestion");
  }
});

router.post("/corrections", auth, submissionsEnabled, submissionCreateRateLimit, async (req, res) => {
  try {
    const requestedAlbumId = typeof req.body?.albumId === "string" ? req.body.albumId.trim().toLowerCase() : "";
    const album = requestedAlbumId ? await queryResult(AlbumCatalog.findOne({ albumId: requestedAlbumId })) : null;
    if (!album) return res.status(404).json({ error: "Target catalog album not found", code: "CATALOG_TARGET_NOT_FOUND" });
    const payload = normalizeCorrectionPayload(req.body, album);
    const submittedAt = new Date();
    const snapshot = correctionSnapshot(payload, submittedAt, 1);
    const submission = await AlbumSubmission.create({
      submittedByUserId: req.userId,
      ...correctionUpdate(payload, 1, "pending"),
      revisions: [snapshot],
      moderationHistory: [{ actorUserId: req.userId, action: "submitted", reason: "", createdAt: submittedAt }],
    });
    return res.status(201).json(serializeSubmission({ ...plain(submission), targetAlbumCatalogId: album }, { detail: true }));
  } catch (error) {
    return sendRouteError(res, error, "Failed to create catalog correction");
  }
});

// One open genre suggestion per user per album: the stored
// openGenreSuggestionKey is unique while the suggestion is pending or needs
// changes, so a concurrent second create fails on the index as well.
router.post("/genres", auth, submissionsEnabled, genresEnabled, genreSuggestionRateLimit, async (req, res) => {
  try {
    const requestedAlbumId = typeof req.body?.albumId === "string" ? req.body.albumId.trim().toLowerCase() : "";
    const album = requestedAlbumId ? await queryResult(AlbumCatalog.findOne({ albumId: requestedAlbumId })) : null;
    if (!album) return res.status(404).json({ error: "Target catalog album not found", code: "CATALOG_TARGET_NOT_FOUND" });
    const key = openGenreSuggestionKey(req.userId, album);
    const open = await queryResult(AlbumSubmission.findOne({ openGenreSuggestionKey: key }).select("submissionId"));
    if (open) return genreSuggestionExists(res, open.submissionId);
    const payload = await normalizeGenreSuggestion(req.body, album);
    await assertNewGenreAllowance(req.userId, payload);
    const submittedAt = new Date();
    const submission = await AlbumSubmission.create({
      submittedByUserId: req.userId,
      ...genreSuggestionFields(payload, 1, "pending"),
      openGenreSuggestionKey: key,
      revisions: [genreSuggestionSnapshot(payload, submittedAt, 1)],
      moderationHistory: [{ actorUserId: req.userId, action: "submitted", reason: "", createdAt: submittedAt }],
    });
    return res.status(201).json({
      ...serializeSubmission({ ...plain(submission), targetAlbumCatalogId: album }, { detail: true }),
      resolvedNewGenres: payload.resolvedNewGenres,
    });
  } catch (error) {
    if (isOpenGenreKeyConflict(error)) return genreSuggestionExists(res);
    return sendRouteError(res, error, "Failed to create genre suggestion");
  }
});

// The viewer's own open genre suggestion for an album, if any, so the album
// page can show "Suggestion pending" without listing everything they made.
router.get("/genres/open", auth, genresEnabled, async (req, res) => {
  try {
    const albumId = typeof req.query?.albumId === "string" ? req.query.albumId.trim().toLowerCase() : "";
    const album = albumId ? await queryResult(AlbumCatalog.findOne({ albumId })) : null;
    if (!album) return res.status(404).json({ error: "Target catalog album not found", code: "CATALOG_TARGET_NOT_FOUND" });
    const open = await findSubmission({ openGenreSuggestionKey: openGenreSuggestionKey(req.userId, album) });
    return res.json({ suggestion: open ? serializeSubmission(open, { detail: true }) : null });
  } catch (error) {
    return sendRouteError(res, error, "Failed to fetch genre suggestion");
  }
});

const MAX_APPROVED_SEARCH_LENGTH = 100;

function approvedSearchText(value) {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new SubmissionValidationError("q must be a string");
  const text = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (text.length > MAX_APPROVED_SEARCH_LENGTH) throw new SubmissionValidationError(`q must be ${MAX_APPROVED_SEARCH_LENGTH} characters or fewer`);
  return text;
}

router.get("/approved", async (req, res) => {
  try {
    const cursor = decodeApprovedCursor(req.query?.cursor);
    const limit = getPageLimit(req.query?.limit);
    const searchText = approvedSearchText(req.query?.q);
    const approvedFilter = {
      status: "approved",
      approvedAlbumCatalogId: { $ne: null },
      approvedAt: { $ne: null },
      approvalPublicationType: { $in: APPROVAL_PUBLICATION_TYPES },
    };
    const query = { ...approvedFilter, ...approvedCursorFilter(cursor) };
    if (searchText) {
      // Search only albums reached through approvals, by their current catalog
      // title and artists, so paging stays on the approval timeline.
      const approvedAlbumIds = await AlbumSubmission.distinct("approvedAlbumCatalogId", approvedFilter);
      const pattern = new RegExp(buildSearchPattern(searchText), "iu");
      const matches = approvedAlbumIds.length
        ? await AlbumCatalog.find({
          _id: { $in: approvedAlbumIds },
          $or: [{ title: pattern }, { artistDisplayName: pattern }, { "artistCredits.name": pattern }],
        }).select("_id").lean()
        : [];
      if (!matches.length) return res.json({ suggestions: [], nextCursor: null });
      query.approvedAlbumCatalogId = { $in: matches.map((album) => album._id) };
    }
    let result = AlbumSubmission.find(query);
    if (result && typeof result.populate === "function") result = result.populate("approvedAlbumCatalogId");
    if (result && typeof result.sort === "function") result = result.sort({ approvedAt: -1, _id: -1 });
    if (result && typeof result.limit === "function") result = result.limit(limit + 1);
    const rows = (await queryResult(result)) || [];
    const hasNextPage = rows.length > limit;
    const inspected = hasNextPage ? rows.slice(0, limit) : rows;
    const suggestions = [];
    inspected.forEach((submission) => {
      const item = serializeApprovedFeedItem(submission);
      if (item) {
        suggestions.push(item);
      } else {
        const source = plain(submission) || {};
        console.error("Approved suggestion feed integrity error", {
          submissionId: source.submissionId || null,
          reason: "approved submission has invalid publication metadata or catalog reference",
        });
      }
    });
    const lastInspected = inspected[inspected.length - 1];
    return res.json({
      suggestions,
      nextCursor: hasNextPage && lastInspected
        ? encodeApprovedCursor(lastInspected.approvedAt, lastInspected._id)
        : null,
    });
  } catch (error) {
    return sendRouteError(res, error, "Failed to fetch approved suggestions");
  }
});

router.get("/mine", auth, async (req, res) => {
  try {
    const queryParams = req.query || {};
    const cursor = decodeCursor(queryParams.cursor);
    const limit = getPageLimit(queryParams.limit);
    const query = { submittedByUserId: req.userId, ...cursorFilter(cursor) };
    let queryRows = AlbumSubmission.find(query);
    if (queryRows && typeof queryRows.populate === "function") queryRows = queryRows.populate("targetAlbumCatalogId");
    const rows = await queryRows.sort({ createdAt: -1, _id: -1 }).limit(limit + 1);
    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return res.json({
      suggestions: page.map((submission) => serializeSubmission(submission)),
      nextCursor: hasNextPage && last ? encodeCursor(last.createdAt, last._id) : null,
    });
  } catch (error) {
    return sendRouteError(res, error, "Failed to fetch suggestions");
  }
});

router.get("/:submissionId", auth, async (req, res) => {
  try {
    const submission = await findSubmission({ submissionId: req.params.submissionId });
    if (!submission) return res.status(404).json({ error: "Suggestion not found" });
    if (submission.submittedByUserId !== req.userId && !isModerator(req.userId)) {
      return res.status(404).json({ error: "Suggestion not found" });
    }
    return res.json(serializeSubmission(submission, { detail: true }));
  } catch (error) {
    return sendRouteError(res, error, "Failed to fetch suggestion");
  }
});

router.post("/:submissionId/revise", auth, submissionsEnabled, submissionMutationRateLimit, async (req, res) => {
  try {
    const current = await AlbumSubmission.findOne({ submissionId: req.params.submissionId });
    if (!current || current.submittedByUserId !== req.userId) return res.status(404).json({ error: "Suggestion not found" });
    if (current.status !== "needs_changes") {
      return res.status(409).json({ error: "Only suggestions needing changes can be revised", code: "INVALID_SUBMISSION_STATE" });
    }
    const revision = current.currentRevision + 1;
    const submittedAt = new Date();
    let update;
    if (current.submissionType === "genre_suggestion") {
      if (!isGenresEnabled()) return res.status(503).json({ error: "Genres are currently disabled", code: "GENRES_DISABLED" });
      const targetId = plain(current.targetAlbumCatalogId)?._id || current.targetAlbumCatalogId;
      const target = await queryResult(AlbumCatalog.findOne({ _id: targetId }));
      if (!target) return res.status(409).json({ error: "The suggestion's album is no longer available", code: "CATALOG_TARGET_MISSING" });
      const body = { ...(req.body || {}), albumId: req.body?.albumId || plain(target).albumId };
      const payload = await normalizeGenreSuggestion(body, target);
      await assertNewGenreAllowance(req.userId, payload, { excludeSubmissionId: current._id });
      update = {
        $set: genreSuggestionFields(payload, revision, "pending"),
        $push: {
          revisions: genreSuggestionSnapshot(payload, submittedAt, revision),
          moderationHistory: { actorUserId: req.userId, action: "revised", reason: "", createdAt: submittedAt },
        },
      };
    } else if ((current.submissionType || "new_album") === "catalog_correction") {
      const targetId = plain(current.targetAlbumCatalogId)?._id || current.targetAlbumCatalogId;
      const target = await queryResult(AlbumCatalog.findOne({ _id: targetId }));
      if (!target) return res.status(409).json({ error: "The correction target album is no longer available", code: "CATALOG_TARGET_MISSING" });
      const body = { ...(req.body || {}), albumId: req.body?.albumId || plain(target).albumId };
      const payload = normalizeCorrectionPayload(body, target);
      update = {
        $set: correctionUpdate(payload, revision, "pending"),
        $push: {
          revisions: correctionSnapshot(payload, submittedAt, revision),
          moderationHistory: { actorUserId: req.userId, action: "revised", reason: "", createdAt: submittedAt },
        },
      };
    } else {
      const payload = normalizeSubmissionPayload(req.body);
      const duplicate = await findDuplicateSignals(payload, { excludeSubmissionId: current._id });
      const snapshot = snapshotForSubmission(payload, duplicate, submittedAt, revision);
      update = {
        $set: submissionUpdate(payload, duplicate, revision, "pending"),
        $push: {
          revisions: snapshot,
          moderationHistory: { actorUserId: req.userId, action: "revised", reason: "", createdAt: submittedAt },
        },
      };
    }
    const updated = await AlbumSubmission.findOneAndUpdate(
      { submissionId: req.params.submissionId, submittedByUserId: req.userId, status: "needs_changes", currentRevision: current.currentRevision },
      update,
      { returnDocument: "after", runValidators: true },
    );
    if (!updated) return res.status(409).json({ error: "Suggestion changed while it was being revised", code: "REVISION_CONFLICT" });
    const responseSubmission = ["catalog_correction", "genre_suggestion"].includes(current.submissionType)
      ? await findSubmission({ submissionId: req.params.submissionId })
      : updated;
    return res.json(serializeSubmission(responseSubmission || updated, { detail: true }));
  } catch (error) {
    return sendRouteError(res, error, "Failed to revise suggestion");
  }
});

router.post("/:submissionId/withdraw", auth, submissionsEnabled, submissionMutationRateLimit, async (req, res) => {
  try {
    const current = await AlbumSubmission.findOne({ submissionId: req.params.submissionId });
    if (!current || current.submittedByUserId !== req.userId) return res.status(404).json({ error: "Suggestion not found" });
    if (!["pending", "needs_changes"].includes(current.status)) {
      return res.status(409).json({ error: "Only active suggestions can be withdrawn", code: "INVALID_SUBMISSION_STATE" });
    }
    const updated = await AlbumSubmission.findOneAndUpdate(
      { submissionId: req.params.submissionId, submittedByUserId: req.userId, status: { $in: ["pending", "needs_changes"] } },
      {
        $set: { status: "withdrawn" },
        $unset: { openGenreSuggestionKey: "" },
        $push: { moderationHistory: { actorUserId: req.userId, action: "withdrawn", reason: "", createdAt: new Date() } },
      },
      { returnDocument: "after", runValidators: true },
    );
    if (!updated) return res.status(409).json({ error: "Suggestion changed while it was being withdrawn", code: "STATE_CONFLICT" });
    return res.json(serializeSubmission(updated, { detail: true }));
  } catch (error) {
    return sendRouteError(res, error, "Failed to withdraw suggestion");
  }
});

module.exports = router;
