const { randomUUID } = require("node:crypto");
const express = require("express");
const { isArtistBiographiesEnabled, isArtistDiscographyEnabled, isArtistPagesEnabled } = require("./utils/serverConfig");
const { externalSearchRateLimit, searchRateLimit } = require("./utils/rateLimit");
const { artistDetail, artistReleases, searchArtists } = require("../lib/artists/read");
const { artistDiscography } = require("../lib/artists/discography");
const { publicBiography } = require("../lib/artists/biographies");
const { MusicBrainzSearchError } = require("../lib/musicBrainzSearch");

// Local artist pages. Read-only and public. The header, releases, and search
// read only the Artist registry and AlbumCatalog. The separately flagged
// discography route is the only one that contacts MusicBrainz.
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

function discographyEnabled(req, res, next) {
  if (!isArtistDiscographyEnabled()) {
    return res.status(503).json({ error: "Artist discography is currently disabled", code: "ARTIST_DISCOGRAPHY_DISABLED" });
  }
  return next();
}

const DIAGNOSTIC_CATEGORIES = ["timeout", "network", "upstream_http", "invalid_response"];

router.get("/:artistId/discography", discographyEnabled, externalSearchRateLimit, async (req, res) => {
  try {
    return res.json(await artistDiscography(req.params.artistId, req.query || {}));
  } catch (error) {
    if (error.status && error.status < 500 && !(error instanceof MusicBrainzSearchError)) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    if (!(error instanceof MusicBrainzSearchError)) return sendError(res, error, "Failed to fetch artist discography");
    // Allowlisted metadata only; provider errors can contain request URLs.
    const requestId = randomUUID();
    const category = DIAGNOSTIC_CATEGORIES.includes(error.diagnostics?.category) ? error.diagnostics.category : "unknown";
    const upstreamStatus = Number.isInteger(error.diagnostics?.upstreamStatus) ? error.diagnostics.upstreamStatus : null;
    console.warn(JSON.stringify({ event: "external_discography_failure", timestamp: new Date().toISOString(), requestId, provider: "musicbrainz", category, upstreamStatus }));
    res.set("X-Request-ID", requestId);
    return res.status(502).json({
      error: "MusicBrainz discography is temporarily unavailable",
      code: "EXTERNAL_DISCOGRAPHY_UNAVAILABLE",
      category,
      upstreamStatus,
      requestId,
    });
  }
});

// Cached biography only: this route never contacts a provider. An absent,
// suppressed, or unverified biography returns { biography: null }.
router.get("/:artistId/biography", searchRateLimit, async (req, res) => {
  if (!isArtistBiographiesEnabled()) {
    return res.status(503).json({ error: "Artist biographies are currently disabled", code: "ARTIST_BIOGRAPHIES_DISABLED" });
  }
  try {
    return res.json(await publicBiography(req.params.artistId));
  } catch (error) {
    return sendError(res, error, "Failed to fetch artist biography");
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
