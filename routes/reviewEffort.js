const express = require("express");
const { getAuth } = require("@clerk/express");

const effort = require("../lib/reviewObservations/effort");
const { isModerator } = require("./utils/submissions");
const { getAuthenticatedUserRateLimitKey, createRateLimiter, createRateLimitMiddleware } = require("./utils/rateLimit");

const router = express.Router();
// Its own budget, so timing a review never spends moderation command points.
const limiter = createRateLimiter({ keyPrefix: "rescened:review-effort", points: 120, duration: 10 * 60 });
const mutationRateLimit = createRateLimitMiddleware(limiter, {
  keyGenerator: getAuthenticatedUserRateLimitKey,
  message: "Too many review timer updates. Please try again soon.",
});

function authenticate(req, res, next) {
  let userId = ""; try { userId = getAuth(req).userId || ""; } catch { userId = ""; }
  if (!userId) return res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED" });
  req.userId = userId; return next();
}
function moderatorOnly(req, res, next) {
  if (!isModerator(req.userId)) return res.status(403).json({ error: "Moderator access required", code: "MODERATOR_REQUIRED" });
  return next();
}
// Checked before the rate limit, like other disabled moderator commands.
function timerEnabled(req, res, next) {
  if (!effort.effortTimerEnabled()) return res.status(503).json({ error: "The review timer is currently disabled", code: "REVIEW_EFFORT_TIMER_DISABLED" });
  return next();
}
function sendError(res, error) {
  const status = Number(error?.status) || 500;
  if (status >= 500 && !(error instanceof effort.EffortError)) return res.status(500).json({ error: "Review timer request failed", code: "REVIEW_EFFORT_REQUEST_FAILED" });
  return res.status(status).json({ error: error.code, code: error.code });
}

router.get("/", authenticate, moderatorOnly, async (req, res) => {
  try { return res.json(await effort.status(req.userId)); } catch (error) { return sendError(res, error); }
});
router.put("/opt-in", authenticate, moderatorOnly, timerEnabled, mutationRateLimit, async (req, res) => {
  try { return res.json(await effort.setOptIn(req.userId, req.body)); } catch (error) { return sendError(res, error); }
});
router.post("/", authenticate, moderatorOnly, timerEnabled, mutationRateLimit, async (req, res) => {
  try { return res.status(201).json(await effort.recordEffort(req.userId, req.body)); } catch (error) { return sendError(res, error); }
});

module.exports = router;
