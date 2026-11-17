const express = require("express");
const { getAuth } = require("@clerk/express");
const ArtistSubmission = require("../models/ArtistSubmission");
const { cursorFilter, decodeCursor, encodeCursor, getPageLimit, isModerator, isSubmissionsEnabled } = require("./utils/submissions");
const { isArtistSuggestionsEnabled } = require("./utils/serverConfig");
const { artistSuggestionCreateRateLimit, submissionMutationRateLimit } = require("./utils/rateLimit");
const { sendArtistSuggestionError } = require("./utils/artistSuggestionErrors");
const {
  createArtistSuggestion,
  reviseArtistSuggestion,
  serializeArtistSuggestion,
  withdrawArtistSuggestion,
} = require("./utils/artistSubmissions");

// Contributor API for standalone artist suggestions. Every route needs
// sign-in; mutations also need COMMUNITY_SUBMISSIONS_ENABLED and
// ARTIST_SUGGESTIONS_ENABLED, while reads keep working with either off.
// Another user's suggestion is a 404 unless the viewer is a moderator.
const router = express.Router();

function auth(req, res, next) {
  let userId = "";
  try {
    userId = getAuth(req).userId || "";
  } catch {
    userId = "";
  }
  if (!userId) return res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED" });
  req.userId = userId;
  return next();
}

function mutationsEnabled(req, res, next) {
  if (!isSubmissionsEnabled()) return res.status(503).json({ error: "Community submissions are currently disabled", code: "SUBMISSIONS_DISABLED" });
  if (!isArtistSuggestionsEnabled()) return res.status(503).json({ error: "Artist suggestions are currently disabled", code: "ARTIST_SUGGESTIONS_DISABLED" });
  return next();
}

// The viewer's suggestions, newest first, in pages of at most 50 (20 by
// default). `nextCursor` continues the same owner's list by (createdAt, _id),
// so every older suggestion stays reachable.
router.get("/mine", auth, async (req, res) => {
  try {
    const query = req.query || {};
    for (const key of Object.keys(query)) {
      if (!["cursor", "limit"].includes(key) || typeof query[key] !== "string") {
        return res.status(400).json({ error: `Unsupported query field ${key}`, code: "INVALID_ARTIST_SUGGESTION" });
      }
    }
    const limit = getPageLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    const rows = await ArtistSubmission.find({ submittedByUserId: req.userId, ...cursorFilter(cursor) })
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return res.json({
      suggestions: page.map((row) => serializeArtistSuggestion(row)),
      nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last._id) : null,
    });
  } catch (error) {
    return sendArtistSuggestionError(res, error, "Failed to fetch artist suggestions");
  }
});

router.post("/", auth, mutationsEnabled, artistSuggestionCreateRateLimit, async (req, res) => {
  try {
    const { document, idempotent } = await createArtistSuggestion({ userId: req.userId, body: req.body });
    const body = serializeArtistSuggestion(document, { detail: true });
    return idempotent ? res.status(200).json({ ...body, idempotent: true }) : res.status(201).json(body);
  } catch (error) {
    return sendArtistSuggestionError(res, error, "Failed to create artist suggestion");
  }
});

router.get("/:submissionId", auth, async (req, res) => {
  try {
    const row = await ArtistSubmission.findOne({ submissionId: String(req.params.submissionId || "").toLowerCase() });
    if (!row || (row.submittedByUserId !== req.userId && !isModerator(req.userId))) {
      return res.status(404).json({ error: "Artist suggestion not found", code: "ARTIST_SUGGESTION_NOT_FOUND" });
    }
    return res.json(serializeArtistSuggestion(row, { detail: true }));
  } catch (error) {
    return sendArtistSuggestionError(res, error, "Failed to fetch artist suggestion");
  }
});

router.post("/:submissionId/revise", auth, mutationsEnabled, submissionMutationRateLimit, async (req, res) => {
  try {
    const updated = await reviseArtistSuggestion({ userId: req.userId, submissionId: req.params.submissionId, body: req.body });
    return res.json(serializeArtistSuggestion(updated, { detail: true }));
  } catch (error) {
    return sendArtistSuggestionError(res, error, "Failed to revise artist suggestion");
  }
});

router.post("/:submissionId/withdraw", auth, mutationsEnabled, submissionMutationRateLimit, async (req, res) => {
  try {
    const updated = await withdrawArtistSuggestion({ userId: req.userId, submissionId: req.params.submissionId, body: req.body });
    return res.json(serializeArtistSuggestion(updated, { detail: true }));
  } catch (error) {
    return sendArtistSuggestionError(res, error, "Failed to withdraw artist suggestion");
  }
});

module.exports = router;
