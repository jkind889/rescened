const express = require("express");
const AlbumCatalog = require("../models/AlbumCatalog");
const { normalizeCatalogAlbum, toSearchResult } = require("./utils/albumCatalog");
const { buildCatalogSearchQuery, escapeRegex } = require("./utils/catalogSearch");
const {
  MusicBrainzSearchError,
  getSuggestionDraft,
  normalizeLimit: normalizeExternalLimit,
  normalizeSearchQuery,
  searchReleaseGroups,
} = require("../lib/musicBrainzSearch");
const {
  externalSearchRateLimit,
  searchRateLimit,
} = require("./utils/rateLimit");
const { isExternalAlbumSearchEnabled } = require("./utils/serverConfig");

const router = express.Router();
const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 24;

function getLimit(value) {
  const parsed = Number.parseInt(value, 10);
  return Math.min(Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LIMIT, MAX_LIMIT);
}

function queryResult(query) {
  let result = query;
  if (result && typeof result.lean === "function") result = result.lean();
  if (result && typeof result.exec === "function") result = result.exec();
  return result;
}

function catalogReferenceQuery(mbid) {
  return {
    externalReferences: {
      $elemMatch: {
        provider: "musicbrainz",
        entityType: "release-group",
        externalId: { $regex: `^${escapeRegex(mbid)}$`, $options: "i" },
      },
    },
  };
}

async function findCatalogAlbumsByReleaseGroup(mbids) {
  const normalizedMbids = [...new Set(mbids.map((mbid) => String(mbid || "").trim().toLowerCase()).filter(Boolean))];
  if (!normalizedMbids.length) return new Map();

  const rows = await queryResult(AlbumCatalog.find({
    $or: normalizedMbids.map(catalogReferenceQuery),
  }));
  const matches = new Map();
  (rows || []).forEach((album) => {
    const source = typeof album?.toObject === "function" ? album.toObject() : album;
    const normalized = normalizeCatalogAlbum(album);
    (Array.isArray(source?.externalReferences) ? source.externalReferences : []).forEach((reference) => {
      if (
        String(reference?.provider || "").toLowerCase() === "musicbrainz"
        && String(reference?.entityType || "").toLowerCase() === "release-group"
      ) {
        const mbid = String(reference.externalId || "").trim().toLowerCase();
        if (normalizedMbids.includes(mbid) && !matches.has(mbid)) matches.set(mbid, normalized);
      }
    });
  });
  return matches;
}

function externalSearchEnabled(req, res, next) {
  if (!isExternalAlbumSearchEnabled()) {
    return res.status(503).json({
      error: "External album search is currently disabled",
      code: "EXTERNAL_SEARCH_DISABLED",
    });
  }
  return next();
}

function invalidExternalSearch(res, error) {
  return res.status(400).json({
    error: error.message || "External album search request is invalid",
    code: "INVALID_EXTERNAL_SEARCH",
  });
}

function externalSearchUnavailable(res) {
  return res.status(502).json({
    error: "External album search is temporarily unavailable",
    code: "EXTERNAL_SEARCH_UNAVAILABLE",
  });
}

async function findLocal(query, { skip = 0, limit, paginated = false }) {
  const searchQuery = buildCatalogSearchQuery(query);
  // Search exposes only a next-page flag, not a total. One extra row answers
  // that question without counting every match across the catalog.
  const albums = await AlbumCatalog.find(searchQuery)
    .sort({ artistDisplayName: 1, title: 1 }).skip(skip).limit(limit + (paginated ? 1 : 0));
  return { albums: paginated ? albums.slice(0, limit) : albums, hasNextPage: paginated && albums.length > limit };
}

router.get("/search", searchRateLimit, async (req, res) => {
  const query = String(req.query.q || "").trim();
  if (!query) return res.json([]);

  try {
    const limit = getLimit(req.query.limit);
    if (req.query.page !== undefined) {
      const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
      const result = await findLocal(query, { skip: (page - 1) * limit, limit, paginated: true });
      return res.json({
        results: result.albums.map(toSearchResult),
        page,
        limit,
        hasPreviousPage: page > 1,
        hasNextPage: result.hasNextPage,
      });
    }
    const result = await findLocal(query, { limit });
    return res.json(result.albums.map(toSearchResult));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to fetch search results" });
  }
});

router.get("/external", externalSearchEnabled, externalSearchRateLimit, async (req, res) => {
  let query;
  let limit;
  try {
    query = normalizeSearchQuery(req.query?.q);
    limit = normalizeExternalLimit(req.query?.limit);
  } catch (error) {
    return invalidExternalSearch(res, error);
  }

  let candidates;
  try {
    candidates = await searchReleaseGroups(query, limit);
  } catch (error) {
    if (error?.code === "INVALID_EXTERNAL_SEARCH") return invalidExternalSearch(res, error);
    if (!(error instanceof MusicBrainzSearchError)) console.error(error);
    return externalSearchUnavailable(res);
  }

  try {
    const catalogByMbid = await findCatalogAlbumsByReleaseGroup(candidates.map((candidate) => candidate.externalId));
    const catalogMatches = [];
    const remainingCandidates = [];
    candidates.forEach((candidate) => {
      const catalogAlbum = catalogByMbid.get(String(candidate.externalId || "").toLowerCase());
      if (catalogAlbum) catalogMatches.push(catalogAlbum);
      else remainingCandidates.push(candidate);
    });
    return res.json({
      query,
      provider: "musicbrainz",
      catalogMatches,
      candidates: remainingCandidates,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to reconcile external search results" });
  }
});

router.get("/musicbrainz/release-group/:mbid", externalSearchEnabled, externalSearchRateLimit, async (req, res) => {
  const mbid = String(req.params?.mbid || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(mbid)) {
    return invalidExternalSearch(res, new Error("Invalid release-group MBID"));
  }

  try {
    const catalogByMbid = await findCatalogAlbumsByReleaseGroup([mbid]);
    const catalogAlbum = catalogByMbid.get(mbid.toLowerCase());
    if (catalogAlbum) return res.json(catalogAlbum);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to reconcile external album identity" });
  }

  try {
    return res.json(await getSuggestionDraft(mbid));
  } catch (error) {
    if (error?.code === "INVALID_EXTERNAL_SEARCH") return invalidExternalSearch(res, error);
    if (!(error instanceof MusicBrainzSearchError)) console.error(error);
    return externalSearchUnavailable(res);
  }
});

module.exports = router;
