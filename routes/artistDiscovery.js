const { randomUUID } = require("node:crypto");
const express = require("express");
const { getAuth } = require("@clerk/express");
const Artist = require("../models/Artist");
const { artistMbidOf, loadArtistsById, loadArtistsByMbid } = require("../lib/artists/identity");
const { parseSearch, searchArtists } = require("../lib/artists/read");
const { MusicBrainzSearchError, artistSearchQuery, searchMusicBrainzArtists } = require("../lib/musicBrainzSearch");
const { isArtistSuggestionsEnabled } = require("./utils/serverConfig");
const { artistDiscoveryLocalRateLimit, artistDiscoveryProviderRateLimit } = require("./utils/rateLimit");

// Artist picker discovery for signed-in contributors and moderators. Two
// independent reads, so the local registry keeps working while MusicBrainz
// is slow, throttled, or down:
//
//   GET /artist-discovery/local?q=        Rescened registry artists
//   GET /artist-discovery/musicbrainz?q=  external MusicBrainz candidates
//
// Gated by ARTIST_SUGGESTIONS_ENABLED only; artist pages may stay off.
// Results are choices for a person to make explicitly. Nothing here links a
// credit, writes, or matches identity by name.

const DIAGNOSTIC_CATEGORIES = ["timeout", "network", "upstream_http", "invalid_response"];

function clerkViewer(req) {
  try {
    return getAuth(req).userId || "";
  } catch {
    return "";
  }
}

function plain(value) {
  return value && typeof value.toObject === "function" ? value.toObject() : value;
}

function createArtistDiscoveryRouter({
  viewer = clerkViewer,
  enabled = isArtistSuggestionsEnabled,
  searchLocal = searchArtists,
  searchProvider = searchMusicBrainzArtists,
  ArtistModel = Artist,
  localRateLimit = artistDiscoveryLocalRateLimit,
  providerRateLimit = artistDiscoveryProviderRateLimit,
  log = console,
} = {}) {
  const router = express.Router();

  // Whether artist linking is on, for signed-in forms. Answers even when the
  // flag is off, so the suggestion form can simply hide the picker.
  router.get("/capabilities", (req, res) => {
    if (!viewer(req)) return res.status(401).json({ error: "Sign in to search for artists", code: "UNAUTHORIZED" });
    return res.json({ enabled: enabled() === true });
  });

  router.use((req, res, next) => {
    const userId = viewer(req);
    if (!userId) return res.status(401).json({ error: "Sign in to search for artists", code: "UNAUTHORIZED" });
    req.userId = userId;
    if (!enabled()) {
      return res.status(503).json({ error: "Artist suggestions are currently disabled", code: "ARTIST_SUGGESTIONS_DISABLED" });
    }
    return next();
  });

  router.get("/local", localRateLimit, async (req, res) => {
    let options;
    try {
      options = parseSearch(req.query || {});
    } catch (error) {
      return res.status(400).json({ error: error.message, code: "INVALID_ARTIST_DISCOVERY" });
    }
    if (!options.q) return res.json({ query: "", results: [] });
    try {
      const { results } = await searchLocal({ q: options.q, limit: String(options.limit) });
      const registry = await loadArtistsById(ArtistModel, results.map((result) => result.artistId));
      return res.json({
        query: options.q,
        results: results.map((result) => ({
          artistId: result.artistId,
          name: result.name,
          artistMbid: artistMbidOf(registry.get(result.artistId)) || "",
          match: result.match || null,
          releaseCount: result.releaseCount || 0,
          knownFor: Array.isArray(result.knownFor) ? result.knownFor : [],
        })),
      });
    } catch (error) {
      log.error("Artist picker local search failed", error?.message || error);
      return res.status(500).json({ error: "Failed to search Rescened artists" });
    }
  });

  router.get("/musicbrainz", providerRateLimit, async (req, res) => {
    let query;
    try {
      const keys = Object.keys(req.query || {});
      if (keys.some((key) => key !== "q") || typeof req.query?.q !== "string") {
        throw new MusicBrainzSearchError("Only a q query string is supported", { code: "INVALID_EXTERNAL_SEARCH", status: 400 });
      }
      query = artistSearchQuery(req.query.q);
    } catch (error) {
      return res.status(400).json({ error: error.message, code: "INVALID_ARTIST_DISCOVERY" });
    }

    let candidates;
    try {
      candidates = await searchProvider(query);
    } catch (error) {
      if (error?.code === "INVALID_EXTERNAL_SEARCH") return res.status(400).json({ error: error.message, code: "INVALID_ARTIST_DISCOVERY" });
      const requestId = randomUUID();
      res.set("X-Request-ID", requestId);
      if (error?.code === "MUSICBRAINZ_THROTTLED" || error?.code === "MUSICBRAINZ_BUSY") {
        const retryAfterSeconds = Number.isInteger(error.retryAfterSeconds) && error.retryAfterSeconds > 0 ? error.retryAfterSeconds : 5;
        res.set("Retry-After", String(retryAfterSeconds));
        log.warn(JSON.stringify({ event: "artist_discovery_throttled", requestId, provider: "musicbrainz", code: error.code, retryAfterSeconds }));
        return res.status(503).json({
          error: "MusicBrainz is busy. Local results still work; try MusicBrainz again shortly.",
          code: "ARTIST_DISCOVERY_THROTTLED",
          retryAfterSeconds,
          requestId,
        });
      }
      if (!(error instanceof MusicBrainzSearchError)) log.error("Artist picker provider search failed", error?.message || error);
      // Allowlisted metadata only: provider errors can contain request URLs.
      const category = DIAGNOSTIC_CATEGORIES.includes(error?.diagnostics?.category) ? error.diagnostics.category : "unknown";
      const upstreamStatus = Number.isInteger(error?.diagnostics?.upstreamStatus) ? error.diagnostics.upstreamStatus : null;
      log.warn(JSON.stringify({ event: "artist_discovery_failure", requestId, provider: "musicbrainz", category, upstreamStatus }));
      return res.status(502).json({
        error: "MusicBrainz artist search is temporarily unavailable. Local results still work.",
        code: "ARTIST_DISCOVERY_UNAVAILABLE",
        category,
        upstreamStatus,
        requestId,
      });
    }

    try {
      // Exact MBID only: a candidate already registered on Rescened says so,
      // so the person can choose the existing artist. Names never match.
      const registered = await loadArtistsByMbid(ArtistModel, candidates.map((candidate) => candidate.artistMbid));
      return res.json({
        query,
        provider: "musicbrainz",
        candidates: candidates.map((candidate) => {
          const registeredArtist = plain(registered.get(candidate.artistMbid));
          return {
            kind: "external",
            provider: "musicbrainz",
            artistMbid: candidate.artistMbid,
            name: candidate.name,
            sortName: candidate.sortName || "",
            disambiguation: candidate.disambiguation || "",
            type: candidate.type || "",
            country: candidate.country || "",
            // The Rescened artist this exact MBID already belongs to, with its
            // registry name, which can differ from the MusicBrainz wording.
            registeredArtistId: registeredArtist?.artistId || null,
            registeredName: registeredArtist?.artistId ? registeredArtist.name || "" : null,
            sourceUrl: `https://musicbrainz.org/artist/${candidate.artistMbid}`,
          };
        }),
      });
    } catch (error) {
      log.error("Artist picker registry reconciliation failed", error?.message || error);
      return res.status(500).json({ error: "Failed to reconcile MusicBrainz artists" });
    }
  });

  return router;
}

module.exports = createArtistDiscoveryRouter();
module.exports.createArtistDiscoveryRouter = createArtistDiscoveryRouter;
