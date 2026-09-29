const express = require("express");
const { getAuth } = require("@clerk/express");

const {
  completeAuthorization,
  enabledFor,
  listEvents,
  mutateConnection,
  serializeConnection,
  startAuthorization,
} = require("../lib/listening/connections");
const { safeError } = require("../lib/listening/common");
const { detectionEnabledFor, listDetections, setTimeZone } = require("../lib/listening/detectionView");
const { getAuthenticatedUserRateLimitKey, createRateLimiter, createRateLimitMiddleware } = require("./utils/rateLimit");

const router = express.Router();
const connectionLimiter = createRateLimiter({ keyPrefix: "rescened:lastfm-connection", points: 30, duration: 10 * 60 });
const connectionRateLimit = createRateLimitMiddleware(connectionLimiter, {
  keyGenerator: getAuthenticatedUserRateLimitKey,
  message: "Too many Last.fm connection attempts. Please try again soon.",
});

function userId(req) {
  try { return getAuth(req).userId || ""; } catch { return ""; }
}

function authenticate(req, res, next) {
  const id = userId(req);
  if (!id) return res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED" });
  req.userId = id;
  return next();
}

function errorResponse(res, error) {
  const status = Number(error?.status || error?.statusCode) || 500;
  const code = error?.code || "LASTFM_REQUEST_FAILED";
  if (status >= 500) return res.status(status).json({ error: "Last.fm connection is unavailable", code });
  return res.status(status).json({ error: code, code });
}

function assertEmptyBody(body) {
  if (body !== undefined && body !== null && (typeof body !== "object" || Array.isArray(body) || Object.keys(body).length)) {
    throw safeError("INVALID_REQUEST", 400);
  }
}

function parseQuery(req) {
  const allowed = new Set(["cursor", "status", "limit"]);
  for (const key of Object.keys(req.query || {})) if (!allowed.has(key)) throw safeError("INVALID_REQUEST", 400);
  const status = req.query?.status ? String(req.query.status) : undefined;
  const cursor = req.query?.cursor ? String(req.query.cursor) : undefined;
  if (req.query?.limit !== undefined && typeof req.query.limit !== "string") throw safeError("INVALID_LIMIT", 400);
  const limit = req.query?.limit === undefined ? 20 : Number(req.query.limit);
  if (req.query?.cursor !== undefined && (typeof req.query.cursor !== "string" || req.query.cursor.length > 512)) throw safeError("INVALID_CURSOR", 400);
  if (req.query?.status !== undefined && (typeof req.query.status !== "string" || req.query.status.length > 32)) throw safeError("INVALID_STATUS", 400);
  return { cursor, status, limit };
}

router.get("/", authenticate, async (req, res) => {
  const state = enabledFor(req.userId);
  try {
    const Model = require("../models/Listening");
    const query = Model.Connection.findOne({ userId: req.userId });
    const connection = await (query?.exec ? query.exec() : query);
    // Keep an existing private connection visible when a rollout flag or pilot
    // allowlist entry is removed so the owner can still pause or disconnect it.
    return res.json({ enabled: state.enabled, pilotAllowed: state.pilotAllowed, detection: detectionEnabledFor(req.userId), connection: serializeConnection(connection) });
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.post("/start", authenticate, connectionRateLimit, async (req, res) => {
  try {
    assertEmptyBody(req.body);
    return res.json(await startAuthorization({ userId: req.userId }));
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.post("/complete", authenticate, connectionRateLimit, async (req, res) => {
  try {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) throw safeError("INVALID_AUTH_CALLBACK", 400);
    const keys = Object.keys(req.body);
    if (keys.some((key) => !["state", "token"].includes(key))) throw safeError("INVALID_AUTH_CALLBACK", 400);
    return res.json(await completeAuthorization({ userId: req.userId, state: req.body.state, token: req.body.token }));
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.post("/pause", authenticate, connectionRateLimit, async (req, res) => {
  try {
    assertEmptyBody(req.body);
    return res.json(await mutateConnection({ userId: req.userId, action: "pause" }));
  } catch (error) { return errorResponse(res, error); }
});

router.post("/resume", authenticate, connectionRateLimit, async (req, res) => {
  try {
    assertEmptyBody(req.body);
    return res.json(await mutateConnection({ userId: req.userId, action: "resume" }));
  } catch (error) { return errorResponse(res, error); }
});

router.delete("/", authenticate, connectionRateLimit, async (req, res) => {
  try {
    assertEmptyBody(req.body);
    return res.json(await mutateConnection({ userId: req.userId, action: "disconnect" }));
  } catch (error) { return errorResponse(res, error); }
});

router.put("/time-zone", authenticate, connectionRateLimit, async (req, res) => {
  try {
    return res.json(await setTimeZone({ userId: req.userId, body: req.body }));
  } catch (error) { return errorResponse(res, error); }
});

router.get("/detections", authenticate, async (req, res) => {
  try {
    const allowed = new Set(["cursor", "coverage", "limit"]);
    for (const key of Object.keys(req.query || {})) if (!allowed.has(key)) throw safeError("INVALID_REQUEST", 400);
    for (const key of allowed) if (req.query?.[key] !== undefined && (typeof req.query[key] !== "string" || req.query[key].length > 512)) throw safeError("INVALID_REQUEST", 400);
    const limit = req.query?.limit === undefined ? 20 : Number(req.query.limit);
    return res.json(await listDetections({ userId: req.userId, cursor: req.query?.cursor, coverage: req.query?.coverage, limit }));
  } catch (error) { return errorResponse(res, error); }
});

router.get("/events", authenticate, async (req, res) => {
  try {
    return res.json(await listEvents({ userId: req.userId, ...parseQuery(req) }));
  } catch (error) { return errorResponse(res, error); }
});

module.exports = router;
module.exports.authenticate = authenticate;
