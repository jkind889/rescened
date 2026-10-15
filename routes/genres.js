const express = require("express");
const { isGenresEnabled } = require("./utils/serverConfig");
const { searchRateLimit } = require("./utils/rateLimit");
const { genreDetail, listTopLevelGenres, searchGenres } = require("../lib/genres/read");
const { genreAlbums } = require("../lib/genres/browse");

const router = express.Router();

router.use((req, res, next) => {
  if (!isGenresEnabled()) {
    return res.status(503).json({ error: "Genres are currently disabled", code: "GENRES_DISABLED" });
  }
  return next();
});

router.get("/", async (req, res) => {
  try {
    res.json({ results: await listTopLevelGenres() });
  } catch (error) {
    res.status(500).json({ error: "Failed to list genres" });
  }
});

router.get("/search", searchRateLimit, async (req, res) => {
  try {
    res.json({ results: await searchGenres(req.query.q) });
  } catch (error) {
    res.status(500).json({ error: "Failed to search genres" });
  }
});

router.get("/:slug/albums", searchRateLimit, async (req, res) => {
  try {
    return res.json(await genreAlbums(req.params.slug, req.query || {}));
  } catch (error) {
    if (error.status && error.status < 500) return res.status(error.status).json({ error: error.message, code: error.code });
    return res.status(500).json({ error: "Failed to fetch genre albums" });
  }
});

router.get("/:slug", async (req, res) => {
  try {
    const detail = await genreDetail(req.params.slug);
    if (!detail) return res.status(404).json({ error: "Genre not found", code: "GENRE_NOT_FOUND" });
    return res.json(detail);
  } catch (error) {
    return res.status(500).json({ error: "Failed to fetch genre" });
  }
});

module.exports = router;
