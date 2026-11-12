const { createHash, randomUUID } = require("node:crypto");
const express = require("express");
const AlbumCatalog = require("../models/AlbumCatalog");
const { toSearchResult } = require("./utils/albumCatalog");
const { buildRankedCatalogSearchPipeline } = require("./utils/catalogSearch");
const { findCatalogAlbumsByReleaseGroup } = require("./utils/catalogReleaseGroups");
const {
  MusicBrainzSearchError,
  getSuggestionDraft,
  normalizeLimit: normalizeExternalLimit,
  MAX_PROVIDER_OFFSET,
  normalizeSearchQuery,
  searchReleaseGroupPage,
} = require("../lib/musicBrainzSearch");
const {
  externalSearchRateLimit,
  searchRateLimit,
} = require("./utils/rateLimit");
const { isArtistPagesEnabled, isExternalAlbumSearchEnabled, isExternalSearchProviderPagingEnabled, isGenresEnabled } = require("./utils/serverConfig");
const { genreFilterIds } = require("../lib/genres/browse");
const { artistIdsForExactQuery } = require("../lib/artists/read");

const router = express.Router();
const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 24;

function getLimit(value) {
  const parsed = Number.parseInt(value, 10);
  return Math.min(Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LIMIT, MAX_LIMIT);
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

// Opaque "show more" cursor for external search, bound to the normalized
// query by `h`, a short SHA-256 fingerprint, so the cursor stays small for
// any accepted query (200 characters of multibyte text included). `o` is the
// raw MusicBrainz offset of a provider page and `s` the
// position within that page's ranked candidates. Paging is best effort: while
// the page stays in the adapter's short-lived cache (60 s by default, bounded
// entries), showing more of it needs no provider request; after expiry or
// eviction the page is fetched again and the provider may rank it
// differently, so a result can be skipped or repeated (clients de-duplicate).
// Moving to the next provider page needs EXTERNAL_SEARCH_PROVIDER_PAGING_ENABLED.
function queryFingerprint(query) {
  return createHash("sha256").update(query.toLowerCase(), "utf8").digest("base64url").slice(0, 22);
}

function encodeExternalCursor(query, offset, start) {
  return Buffer.from(JSON.stringify({ v: 2, h: queryFingerprint(query), o: offset, s: start })).toString("base64url");
}

function decodeExternalCursor(query, cursor) {
  if (cursor === undefined) return { offset: 0, start: 0 };
  try {
    if (typeof cursor !== "string" || !cursor || cursor.length > 512) throw new Error("bad");
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (value?.v !== 2 || value.h !== queryFingerprint(query) || !Number.isInteger(value.o) || value.o < 0
      || value.o > MAX_PROVIDER_OFFSET || !Number.isInteger(value.s) || value.s < 0 || value.s > 100) throw new Error("bad");
    if (value.o > 0 && !isExternalSearchProviderPagingEnabled()) throw new Error("paging off");
    return { offset: value.o, start: value.s };
  } catch {
    throw new MusicBrainzSearchError("External search cursor is invalid", { code: "INVALID_EXTERNAL_SEARCH", status: 400 });
  }
}

function externalSearchUnavailable(res, diagnostic) {
  return res.status(502).json({
    error: "External album search is temporarily unavailable",
    code: "EXTERNAL_SEARCH_UNAVAILABLE",
    ...(diagnostic ? {
      category: diagnostic.category,
      upstreamStatus: diagnostic.upstreamStatus,
      requestId: diagnostic.requestId,
    } : {}),
  });
}

async function findLocal(query, { skip = 0, limit, paginated = false, genreIds = null }) {
  // Search exposes only a next-page flag, not a total. One extra row answers
  // that question without counting every match across the catalog.
  // With artist pages on, an exact artist name or reviewed alias also finds
  // that artist's linked releases under any credited spelling.
  const artistIds = isArtistPagesEnabled() ? await artistIdsForExactQuery(query) : [];
  const albums = await AlbumCatalog.aggregate(buildRankedCatalogSearchPipeline(query, {
    skip, limit: limit + (paginated ? 1 : 0), genreIds, artistIds,
  }));
  return { albums: paginated ? albums.slice(0, limit) : albums, hasNextPage: paginated && albums.length > limit };
}

router.get("/search", searchRateLimit, async (req, res) => {
  const query = String(req.query.q || "").trim();
  if (!query) return res.json([]);

  try {
    // Optional genre filter: the genre (by slug or alias slug) and its
    // sub-genres. Local catalog albums only; external candidates have none.
    let genreFilter = null;
    if (req.query.genre !== undefined) {
      if (!isGenresEnabled()) return res.status(503).json({ error: "Genres are currently disabled", code: "GENRES_DISABLED" });
      if (typeof req.query.genre !== "string") return res.status(400).json({ error: "genre must be a slug", code: "INVALID_GENRE_FILTER" });
      genreFilter = await genreFilterIds(req.query.genre);
      if (!genreFilter) return res.status(404).json({ error: "Genre not found", code: "GENRE_NOT_FOUND" });
    }
    const limit = getLimit(req.query.limit);
    if (req.query.page !== undefined) {
      const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
      const result = await findLocal(query, { skip: (page - 1) * limit, limit, paginated: true, genreIds: genreFilter?.ids });
      return res.json({
        results: result.albums.map(toSearchResult),
        page,
        limit,
        hasPreviousPage: page > 1,
        hasNextPage: result.hasNextPage,
        ...(genreFilter ? { genre: genreFilter.genre } : {}),
      });
    }
    const result = await findLocal(query, { limit, genreIds: genreFilter?.ids });
    return res.json(result.albums.map(toSearchResult));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to fetch search results" });
  }
});

function externalSearchDiagnostic(error, requestId) {
  const diagnostic = error?.diagnostics;
  const categories = ["timeout", "network", "upstream_http", "invalid_response"];
  return {
    category: categories.includes(diagnostic?.category) ? diagnostic.category : "unknown",
    upstreamStatus: Number.isInteger(diagnostic?.upstreamStatus)
      && diagnostic.upstreamStatus >= 100 && diagnostic.upstreamStatus <= 599
      ? diagnostic.upstreamStatus : null,
    requestId,
  };
}

function logExternalSearchFailure(error, diagnostic, operation) {
  const duration = (value) => Number.isFinite(value) && value >= 0 ? value : null;
  console.warn(JSON.stringify({
    event: "external_search_failure",
    timestamp: new Date().toISOString(),
    requestId: diagnostic.requestId,
    provider: "musicbrainz",
    operation,
    category: diagnostic.category,
    upstreamStatus: diagnostic.upstreamStatus,
    gateWaitMs: duration(error?.diagnostics?.gateWaitMs),
    fetchDurationMs: duration(error?.diagnostics?.fetchDurationMs),
  }));
}

router.get("/external", externalSearchEnabled, externalSearchRateLimit, async (req, res) => {
  let query;
  let limit;
  let position;
  try {
    query = normalizeSearchQuery(req.query?.q);
    limit = normalizeExternalLimit(req.query?.limit);
    position = decodeExternalCursor(query, req.query?.cursor);
  } catch (error) {
    return invalidExternalSearch(res, error);
  }

  const requestId = randomUUID();
  res.set("X-Request-ID", requestId);
  let page;
  try {
    page = await searchReleaseGroupPage(query, { offset: position.offset });
  } catch (error) {
    if (error?.code === "INVALID_EXTERNAL_SEARCH") return invalidExternalSearch(res, error);
    const diagnostic = externalSearchDiagnostic(error, requestId);
    logExternalSearchFailure(error, diagnostic, "search");
    return externalSearchUnavailable(res, diagnostic);
  }

  const candidates = page.candidates.slice(position.start, position.start + limit);
  const end = position.start + candidates.length;
  let nextCursor = null;
  if (end < page.candidates.length) nextCursor = encodeExternalCursor(query, page.offset, end);
  else if (page.nextOffset !== null && isExternalSearchProviderPagingEnabled()) nextCursor = encodeExternalCursor(query, page.nextOffset, 0);

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
      // Total MusicBrainz matches for the query (null when not reported),
      // and the cursor for the next slice, or null when there is no more.
      providerCount: page.providerCount,
      nextCursor,
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
