const express = require("express");
const { getAuth } = require("@clerk/express");

const { flags } = require("../lib/listening/common");
const {
  catalogSearch,
  detail,
  listCases,
  moderate,
} = require("../lib/listening/moderation");
const { isModerator } = require("./utils/submissions");
const { getAuthenticatedUserRateLimitKey, createRateLimiter, createRateLimitMiddleware } = require("./utils/rateLimit");

const router = express.Router();
const limiter = createRateLimiter({ keyPrefix: "rescened:album-mapping-moderation", points: 120, duration: 10 * 60 });
const mutationRateLimit = createRateLimitMiddleware(limiter, {
  keyGenerator: getAuthenticatedUserRateLimitKey,
  message: "Too many mapping moderation commands. Please try again soon.",
});

function viewer(req) { try { return getAuth(req).userId || ""; } catch { return ""; } }
function authenticate(req, res, next) {
  const id = viewer(req);
  if (!id) return res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED" });
  req.userId = id;
  return next();
}
function moderatorOnly(req, res, next) {
  if (!isModerator(req.userId)) return res.status(403).json({ error: "Moderator access required", code: "MODERATOR_REQUIRED" });
  return next();
}
function moderationEnabled(req, res, next) {
  if (!flags().moderation) return res.status(503).json({ error: "Album mapping moderation is currently disabled", code: "MAPPING_MODERATION_DISABLED" });
  return next();
}
function errorResponse(res, error) {
  const status = Number(error?.status || error?.statusCode) || 500;
  const code = error?.code || "MAPPING_REQUEST_FAILED";
  if (status >= 500) return res.status(status).json({ error: "Album mapping request failed", code });
  return res.status(status).json({ error: code, code });
}
function parseListQuery(req) {
  const allowed = new Set(["status", "priority", "cursor", "limit"]);
  Object.keys(req.query || {}).forEach((key) => { if (!allowed.has(key)) { const error = new Error("INVALID_REQUEST"); error.code = "INVALID_REQUEST"; error.status = 400; throw error; } });
  for (const key of ["status", "priority", "cursor", "limit"]) {
    if (req.query?.[key] !== undefined && typeof req.query[key] !== "string") {
      const error = new Error("INVALID_REQUEST"); error.code = "INVALID_REQUEST"; error.status = 400; throw error;
    }
  }
  const status = req.query?.status || undefined;
  const priority = req.query?.priority || undefined;
  const cursor = req.query?.cursor || undefined;
  if (cursor && cursor.length > 512) { const error = new Error("INVALID_CURSOR"); error.code = "INVALID_CURSOR"; error.status = 400; throw error; }
  if (status && status.length > 32) { const error = new Error("INVALID_STATUS"); error.code = "INVALID_STATUS"; error.status = 400; throw error; }
  if (priority && priority.length > 16) { const error = new Error("INVALID_PRIORITY"); error.code = "INVALID_PRIORITY"; error.status = 400; throw error; }
  const limit = req.query?.limit === undefined ? undefined : Number(req.query.limit);
  return { status, priority, cursor, limit };
}

router.get("/", authenticate, moderatorOnly, async (req, res) => {
  try { return res.json(await listCases(parseListQuery(req))); } catch (error) { return errorResponse(res, error); }
});

router.get("/catalog-search", authenticate, moderatorOnly, async (req, res) => {
  try {
    const allowed = new Set(["q", "limit"]);
    Object.keys(req.query || {}).forEach((key) => { if (!allowed.has(key)) { const error = new Error("INVALID_REQUEST"); error.code = "INVALID_REQUEST"; error.status = 400; throw error; } });
    if (req.query?.q !== undefined && typeof req.query.q !== "string") { const error = new Error("INVALID_QUERY"); error.code = "INVALID_QUERY"; error.status = 400; throw error; }
    if (req.query?.limit !== undefined && typeof req.query.limit !== "string") { const error = new Error("INVALID_LIMIT"); error.code = "INVALID_LIMIT"; error.status = 400; throw error; }
    return res.json(await catalogSearch(req.query?.q, req.query?.limit));
  } catch (error) { return errorResponse(res, error); }
});

router.get("/:caseId", authenticate, moderatorOnly, async (req, res) => {
  try {
    const result = await detail(req.params.caseId);
    if (!result) return res.status(404).json({ error: "Mapping case not found", code: "MAPPING_CASE_NOT_FOUND" });
    return res.json(result);
  } catch (error) { return errorResponse(res, error); }
});

async function command(req, res, action) {
  try { return res.json(await moderate(req.params.caseId, action, req.body, req.userId)); } catch (error) { return errorResponse(res, error); }
}

router.post("/:caseId/approve", authenticate, moderatorOnly, moderationEnabled, mutationRateLimit, (req, res) => command(req, res, "approve"));
router.post("/:caseId/reject", authenticate, moderatorOnly, moderationEnabled, mutationRateLimit, (req, res) => command(req, res, "reject"));
router.post("/:caseId/no-catalog-match", authenticate, moderatorOnly, moderationEnabled, mutationRateLimit, (req, res) => command(req, res, "no-catalog-match"));
router.post("/:caseId/refresh", authenticate, moderatorOnly, moderationEnabled, mutationRateLimit, (req, res) => command(req, res, "refresh"));
router.post("/:caseId/revoke", authenticate, moderatorOnly, moderationEnabled, mutationRateLimit, (req, res) => command(req, res, "revoke"));

module.exports = router;
