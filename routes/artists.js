const express = require("express");
const { isArtistPagesEnabled } = require("./utils/serverConfig");
const { searchRateLimit } = require("./utils/rateLimit");
const { artistDetail, artistReleases, searchArtists } = require("../lib/artists/read");

// Local artist pages. Read-only, public, and backed by the Artist registry and
// AlbumCatalog only; no provider is contacted.
const router = express.Router();

router.use((req, res, next) => {
  if (!isArtistPagesEnabled()) {
    return res.status(503).json({ error: "Artist pages are currently disabled", code: "ARTIST_PAGES_DISABLED" });
  }
  return next();
});

function sendError(res, error, fallback) {
  if (error.status && error.status < 500) return res.status(error.status).json({ error: error.message, code: error.code });
  console.error(error);
  return res.status(500).json({ error: fallback });
}

router.get("/search", searchRateLimit, async (req, res) => {
  try {
    return res.json(await searchArtists(req.query || {}));
  } catch (error) {
    return sendError(res, error, "Failed to search artists");
  }
});

router.get("/:artistId/releases", searchRateLimit, async (req, res) => {
  try {
    return res.json(await artistReleases(req.params.artistId, req.query || {}));
  } catch (error) {
    return sendError(res, error, "Failed to fetch artist releases");
  }
});

router.get("/:artistId", async (req, res) => {
  try {
    return res.json(await artistDetail(req.params.artistId));
  } catch (error) {
    return sendError(res, error, "Failed to fetch artist");
  }
});

module.exports = router;
