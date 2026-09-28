const express = require("express");
const { getAuth } = require("@clerk/express");
const { isModerator } = require("./utils/submissions");
const { externalSearchRateLimit, moderationMutationRateLimit } = require("./utils/rateLimit");
const service = require("../lib/baselines/service");

const router = express.Router();

function authenticate(req, res, next) {
  let userId = ""; try { userId = getAuth(req).userId || ""; } catch { userId = ""; }
  if (!userId) return res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED" });
  req.userId = userId; return next();
}
function moderatorOnly(req, res, next) {
  if (!isModerator(req.userId)) return res.status(403).json({ error: "Moderator access required", code: "MODERATOR_REQUIRED" });
  return next();
}
function allowedKeys(value, keys, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) { const error = new service.BaselineError(`${path} must be an object`, "INVALID_BASELINE_REQUEST"); throw error; }
  Object.keys(value).forEach((key) => { if (!keys.has(key)) throw new service.BaselineError(`${path}.${key} is not allowed`, "INVALID_BASELINE_REQUEST"); });
}
function sendError(res, error) {
  const status = Number(error?.status || error?.statusCode) || (error?.name === "ValidationError" || error?.name === "CastError" ? 400 : 500);
  const code = error?.code || (status === 500 ? "BASELINE_REQUEST_FAILED" : "INVALID_BASELINE_REQUEST");
  const body = { error: status >= 500 && !error?.code ? "Baseline request failed" : error.message, code };
  if (error?.details?.length) body.details = error.details;
  const retryAfterMs = Number(error?.retryAfterMs);
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) res.set("Retry-After", String(Math.min(Math.ceil(retryAfterMs / 1000), 86400)));
  return res.status(status).json(body);
}
function parseList(query = {}) {
  allowedKeys(query, new Set(["status", "readiness", "limit", "cursor", "q"]), "query");
  for (const key of ["status", "readiness", "limit", "cursor", "q"]) {
    if (query[key] !== undefined && typeof query[key] !== "string") throw new service.BaselineError(`query.${key} must be a string`, "INVALID_BASELINE_REQUEST");
  }
  const status = query.status || "pending";
  const readiness = query.readiness || "all";
  if (!["all", "ready", "unprepared"].includes(readiness)) throw new service.BaselineError("query.readiness is invalid", "INVALID_BASELINE_REQUEST");
  if (readiness !== "all" && status !== "pending") throw new service.BaselineError("query.readiness filters are only valid for pending status", "INVALID_BASELINE_REQUEST");
  return { status, readiness, limit: query.limit === undefined ? 20 : Number(query.limit), cursor: query.cursor, q: query.q || "" };
}

router.get("/", authenticate, moderatorOnly, async (req, res) => { try { return res.json(await service.list(parseList(req.query))); } catch (error) { return sendError(res, error); } });
router.get("/groups", authenticate, moderatorOnly, externalSearchRateLimit, async (req, res) => {
  try {
    allowedKeys(req.query || {}, new Set(["q", "limit"]), "query");
    if (typeof req.query.q !== "string" || (req.query.limit !== undefined && typeof req.query.limit !== "string")) throw new service.BaselineError("query values must be strings", "INVALID_BASELINE_REQUEST");
    return res.json(await service.searchGroups(req.query.q, req.query.limit));
  } catch (error) { return sendError(res, error); }
});
router.get("/:kind/:id", authenticate, moderatorOnly, async (req, res) => { try { return res.json(await service.detail(req.params.kind, req.params.id)); } catch (error) { return sendError(res, error); } });
router.post("/:kind/:id/candidates", authenticate, moderatorOnly, externalSearchRateLimit, async (req, res) => {
  try { allowedKeys(req.body || {}, new Set(["releaseGroupMbid", "offset"]), "request body"); return res.json(await service.candidates(req.params.kind, req.params.id, req.body)); } catch (error) { return sendError(res, error); }
});
router.post("/:kind/:id/preview", authenticate, moderatorOnly, externalSearchRateLimit, async (req, res) => {
  try { allowedKeys(req.body || {}, new Set(["releaseMbid", "releaseGroupMbid"]), "request body"); return res.json(await service.preview(req.params.kind, req.params.id, req.body)); } catch (error) { return sendError(res, error); }
});
async function command(req, res, action) {
  try { return res.json(await service.performCommand({ kind: req.params.kind, id: req.params.id, action, body: req.body || {}, actorUserId: req.userId })); } catch (error) { return sendError(res, error); }
}
["confirm", "replace", "defer", "revoke"].forEach((action) => router.post(`/:kind/:id/${action}`, authenticate, moderatorOnly, moderationMutationRateLimit, (req, res) => command(req, res, action)));

module.exports = router;
