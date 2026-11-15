const express = require("express");
const { getAuth } = require("@clerk/express");
const ArtistSubmission = require("../models/ArtistSubmission");
const { isModerator } = require("./utils/submissions");
const { isArtistSuggestionsEnabled } = require("./utils/serverConfig");
const { moderationMutationRateLimit } = require("./utils/rateLimit");
const { decodeModerationCursor, encodeModerationCursor, moderationCursorFilter, parseModeratorLimit } = require("./utils/moderation");
const { sendArtistSuggestionError } = require("./utils/artistSuggestionErrors");
const {
  approveArtistSuggestion,
  moderateArtistSuggestion,
  moderatorContext,
  serializeArtistSuggestion,
} = require("./utils/artistSubmissions");
const { ARTIST_SUBMISSION_STATUSES } = require("../models/ArtistSubmission");

// Moderator API for standalone artist suggestions: allowlisted moderators
// only. Reads work with the flags off; commands need
// COMMUNITY_MODERATION_ENABLED and ARTIST_SUGGESTIONS_ENABLED and name the
// reviewed revision.
const router = express.Router();

router.use((req, res, next) => {
  let userId = "";
  try {
    userId = getAuth(req).userId || "";
  } catch {
    userId = "";
  }
  if (!userId) return res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED" });
  if (!isModerator(userId)) return res.status(403).json({ error: "Moderator access required", code: "MODERATOR_REQUIRED" });
  req.userId = userId;
  return next();
});

function commandsEnabled(req, res, next) {
  if (String(process.env.COMMUNITY_MODERATION_ENABLED || "").trim().toLowerCase() !== "true") {
    return res.status(503).json({ error: "Community moderation is currently disabled", code: "MODERATION_DISABLED" });
  }
  if (!isArtistSuggestionsEnabled()) return res.status(503).json({ error: "Artist suggestions are currently disabled", code: "ARTIST_SUGGESTIONS_DISABLED" });
  return next();
}

function parseStatuses(value) {
  if (value === undefined || value === "") return ["pending"];
  const statuses = [...new Set(String(value).split(",").map((item) => item.trim()).filter(Boolean))];
  if (!statuses.length || statuses.some((status) => !ARTIST_SUBMISSION_STATUSES.includes(status))) {
    throw Object.assign(new Error("status contains an invalid artist suggestion state"), { status: 400, code: "INVALID_MODERATION_REQUEST" });
  }
  return statuses;
}

router.get("/", async (req, res) => {
  try {
    const statuses = parseStatuses(req.query?.status);
    const limit = parseModeratorLimit(req.query?.limit);
    const cursor = decodeModerationCursor(req.query?.cursor);
    const rows = await ArtistSubmission.find({ status: { $in: statuses }, ...moderationCursorFilter(cursor) })
      .sort({ updatedAt: 1, _id: 1 })
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return res.json({
      suggestions: page.map((row) => serializeArtistSuggestion(row)),
      nextCursor: rows.length > limit && last ? encodeModerationCursor(last.updatedAt, last._id) : null,
    });
  } catch (error) {
    return sendArtistSuggestionError(res, error, "Failed to fetch artist suggestions");
  }
});

async function detail(row) {
  return { suggestion: serializeArtistSuggestion(row, { detail: true }), context: await moderatorContext(row) };
}

router.get("/:submissionId", async (req, res) => {
  try {
    const row = await ArtistSubmission.findOne({ submissionId: String(req.params.submissionId || "").toLowerCase() });
    if (!row) return res.status(404).json({ error: "Artist suggestion not found", code: "ARTIST_SUGGESTION_NOT_FOUND" });
    return res.json(await detail(row));
  } catch (error) {
    return sendArtistSuggestionError(res, error, "Failed to fetch artist suggestion");
  }
});

router.post("/:submissionId/approve", commandsEnabled, moderationMutationRateLimit, async (req, res) => {
  try {
    const { submission, idempotent } = await approveArtistSuggestion({ submissionId: req.params.submissionId, actorUserId: req.userId, body: req.body });
    return res.json({ ...(await detail(submission)), idempotent });
  } catch (error) {
    return sendArtistSuggestionError(res, error, "Failed to approve artist suggestion");
  }
});

for (const [path, action] of [["request-changes", "request_changes"], ["reject", "reject"], ["mark-duplicate", "mark_duplicate"]]) {
  router.post(`/:submissionId/${path}`, commandsEnabled, moderationMutationRateLimit, async (req, res) => {
    try {
      const updated = await moderateArtistSuggestion({ submissionId: req.params.submissionId, actorUserId: req.userId, action, body: req.body });
      return res.json(await detail(updated));
    } catch (error) {
      return sendArtistSuggestionError(res, error, "Failed to apply the moderation decision");
    }
  });
}

module.exports = router;
