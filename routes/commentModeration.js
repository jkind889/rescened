const express = require("express");
const { getAuth } = require("@clerk/express");
const { commentAuthors } = require("../lib/reviewComments/authors");
const { isModerator } = require("./utils/submissions");
const { moderationMutationRateLimit } = require("./utils/rateLimit");
const { assertCommentId, parseModerationBody } = require("../lib/reviewComments/common");
const { dismissReports, readReportQueue, removeComment } = require("../lib/reviewComments/moderation");

// Mounted at /moderation/comment-reports.
const router = express.Router();

function viewer(req) { try { return getAuth(req).userId || ""; } catch { return ""; } }
function authenticate(req, res, next) {
  const userId = viewer(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED" });
  req.userId = userId;
  return next();
}
function moderatorOnly(req, res, next) {
  if (!isModerator(req.userId)) return res.status(403).json({ error: "Moderator access required", code: "MODERATOR_REQUIRED" });
  return next();
}
function moderationEnabled(req, res, next) {
  if (String(process.env.COMMUNITY_MODERATION_ENABLED || "").trim().toLowerCase() !== "true") {
    return res.status(503).json({ error: "Community moderation is currently disabled", code: "MODERATION_DISABLED" });
  }
  return next();
}
function sendError(res, error, fallback) {
  if (error?.status && error.status < 500) return res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
  if (error?.status === 503) return res.status(503).json({ error: error.message, code: error.code });
  return res.status(500).json({ error: fallback });
}

router.get("/", authenticate, moderatorOnly, async (req, res) => {
  try { res.json(await readReportQueue({ limit: req.query?.limit }, commentAuthors)); }
  catch (error) { sendError(res, error, "Failed to fetch comment reports"); }
});

function command(run, fallback) {
  return async (req, res) => {
    try {
      const commentId = assertCommentId(req.params.commentId);
      const { reason } = parseModerationBody(req.body);
      res.json(await run({ commentId, actorUserId: req.userId, reason }));
    } catch (error) { sendError(res, error, fallback); }
  };
}

router.post("/:commentId/remove", authenticate, moderatorOnly, moderationEnabled, moderationMutationRateLimit, command(removeComment, "Failed to remove comment"));
router.post("/:commentId/dismiss", authenticate, moderatorOnly, moderationEnabled, moderationMutationRateLimit, command(dismissReports, "Failed to dismiss reports"));

module.exports = router;
