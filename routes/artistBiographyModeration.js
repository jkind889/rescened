const express = require("express");
const { getAuth } = require("@clerk/express");
const { isModerator } = require("./utils/submissions");
const { isArtistBiographiesEnabled } = require("./utils/serverConfig");
const { moderationMutationRateLimit } = require("./utils/rateLimit");
const { COMMANDS, moderatorDetail, moderatorQueue, normalizeCommand, runModeratorCommand } = require("../lib/artists/biographies");

// Moderator review of cached artist biographies: a queue by identity state,
// one record with evidence and audit history, and guarded commands. Reads
// need ARTIST_BIOGRAPHIES_ENABLED; commands also need
// COMMUNITY_MODERATION_ENABLED. All routes need a Clerk session in
// MODERATOR_USER_IDS. Nothing here contacts a provider.
const router = express.Router();
const COMMAND_PATHS = Object.fromEntries(COMMANDS.map((command) => [command.replace(/_/g, "-"), command]));

function viewer(req) {
  try { return getAuth(req).userId || ""; } catch { return ""; }
}

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

function biographiesEnabled(req, res, next) {
  if (!isArtistBiographiesEnabled()) return res.status(503).json({ error: "Artist biographies are currently disabled", code: "ARTIST_BIOGRAPHIES_DISABLED" });
  return next();
}

function moderationEnabled(req, res, next) {
  if (String(process.env.COMMUNITY_MODERATION_ENABLED || "").trim().toLowerCase() !== "true") {
    return res.status(503).json({ error: "Community moderation is currently disabled", code: "MODERATION_DISABLED" });
  }
  return next();
}

function sendError(res, error, fallback) {
  const status = Number(error?.status) || 500;
  if (status >= 500) {
    console.error(error);
    return res.status(500).json({ error: fallback });
  }
  return res.status(status).json({ error: error.message, code: error.code || "INVALID_BIOGRAPHY_COMMAND" });
}

router.use(authenticate, moderatorOnly, biographiesEnabled);

router.get("/", async (req, res) => {
  try {
    for (const key of Object.keys(req.query || {})) {
      if (!["state", "limit"].includes(key) || typeof req.query[key] !== "string") {
        return res.status(400).json({ error: `Unsupported query field ${key}`, code: "INVALID_BIOGRAPHY_COMMAND" });
      }
    }
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    return res.json({ biographies: await moderatorQueue({ state: req.query.state || "needs_review", limit }) });
  } catch (error) {
    return sendError(res, error, "Failed to list biographies");
  }
});

router.get("/:artistId", async (req, res) => {
  try {
    return res.json({ biography: await moderatorDetail({ artistId: req.params.artistId }) });
  } catch (error) {
    return sendError(res, error, "Failed to load biography");
  }
});

for (const [path, action] of Object.entries(COMMAND_PATHS)) {
  router.post(`/:artistId/${path}`, moderationEnabled, moderationMutationRateLimit, async (req, res) => {
    try {
      const command = normalizeCommand(action, req.body || {});
      return res.json({ biography: await runModeratorCommand({ artistId: req.params.artistId, command, actorId: req.userId }) });
    } catch (error) {
      return sendError(res, error, "Failed to apply biography command");
    }
  });
}

module.exports = router;
