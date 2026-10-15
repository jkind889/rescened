const express = require("express");
const { getAuth } = require("@clerk/express");
const { isModerator } = require("./utils/submissions");
const { isGenresEnabled } = require("./utils/serverConfig");
const { moderationMutationRateLimit } = require("./utils/rateLimit");
const { isGenreId } = require("../lib/genres/vocabulary");
const {
  listVocabulary,
  normalizeVocabularyCommand,
  runVocabularyCommand,
  vocabularyDetail,
} = require("../lib/genres/vocabularyCommands");

const router = express.Router();
const COMMAND_PATHS = { rename: "rename", aliases: "alias_add", parent: "reparent", retire: "retire", restore: "restore" };

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
  if (!isModerator(req.userId)) return res.status(403).json({ error: "Moderator access required", code: "MODERATOR_REQUIRED" });
  return next();
}

function genresEnabled(req, res, next) {
  if (!isGenresEnabled()) return res.status(503).json({ error: "Genres are currently disabled", code: "GENRES_DISABLED" });
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
  if (status >= 500 && status !== 503) return res.status(500).json({ error: fallback });
  const body = { error: error.message, code: error.code || "GENRE_COMMAND_FAILED" };
  if (error.details?.length) body.details = error.details;
  return res.status(status).json(body);
}

function requireGenreId(req, res) {
  if (isGenreId(req.params.genreId)) return req.params.genreId.toLowerCase();
  res.status(400).json({ error: "genreId must be a UUID v4", code: "INVALID_GENRE_COMMAND" });
  return null;
}

router.use(authenticate, moderatorOnly, genresEnabled);

router.get("/", async (req, res) => {
  try {
    for (const key of Object.keys(req.query || {})) {
      if (!["q", "status"].includes(key) || typeof req.query[key] !== "string") {
        return res.status(400).json({ error: `Unsupported query field ${key}`, code: "INVALID_GENRE_COMMAND" });
      }
    }
    return res.json({ genres: await listVocabulary({ q: req.query.q || "", status: req.query.status || "active" }) });
  } catch (error) {
    return sendError(res, error, "Failed to list genres");
  }
});

router.get("/:genreId", async (req, res) => {
  try {
    const genreId = requireGenreId(req, res);
    if (!genreId) return undefined;
    const detail = await vocabularyDetail(genreId);
    if (!detail) return res.status(404).json({ error: "Genre not found", code: "GENRE_NOT_FOUND" });
    return res.json(detail);
  } catch (error) {
    return sendError(res, error, "Failed to load genre");
  }
});

for (const [path, action] of Object.entries(COMMAND_PATHS)) {
  router.post(`/:genreId/${path}`, moderationEnabled, moderationMutationRateLimit, async (req, res) => {
    try {
      const genreId = requireGenreId(req, res);
      if (!genreId) return undefined;
      const command = normalizeVocabularyCommand(action, req.body || {});
      return res.json({ genre: await runVocabularyCommand({ genreId, command, actorUserId: req.userId }) });
    } catch (error) {
      return sendError(res, error, "Failed to apply genre command");
    }
  });
}

module.exports = router;
