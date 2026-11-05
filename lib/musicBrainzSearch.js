const {
  CatalogFetchError,
  DEFAULT_MUSICBRAINZ_INTERVAL_MS,
  DEFAULT_USER_AGENT: IMPORTER_USER_AGENT,
  createRateGate,
  mapReleaseType,
  normalizeJoinPhrase,
  normalizeMbid,
  normalizeText,
  parsePartialDate,
  requestJson,
} = require("./catalogImport/listenBrainz");
const { canonicalMusicBrainzUrl } = require("./coverArtArchive");

const MUSICBRAINZ_BASE_URL = "https://musicbrainz.org/ws/2";
const COVER_ART_ARCHIVE_BASE_URL = "https://coverartarchive.org";
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 12;
const PROVIDER_LIMIT = 50;
const MAX_QUERY_LENGTH = 200;
const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_CACHE_MAX_ENTRIES = 100;
const DEFAULT_USER_AGENT = IMPORTER_USER_AGENT;

class MusicBrainzSearchError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "MusicBrainzSearchError";
    this.code = options.code || "MUSICBRAINZ_SEARCH_FAILED";
    this.status = options.status;
  }
}

let sharedRateGate;

function getSharedRateGate() {
  if (!sharedRateGate) {
    sharedRateGate = createRateGate({ intervalMs: DEFAULT_MUSICBRAINZ_INTERVAL_MS });
  }
  return sharedRateGate;
}

function normalizeSearchQuery(value) {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new MusicBrainzSearchError("External album search query must be a string", {
      code: "INVALID_EXTERNAL_SEARCH",
      status: 400,
    });
  }
  const query = normalizeText(value);
  if (!query) {
    throw new MusicBrainzSearchError("External album search requires a query", {
      code: "INVALID_EXTERNAL_SEARCH",
      status: 400,
    });
  }
  if (query.length > MAX_QUERY_LENGTH) {
    throw new MusicBrainzSearchError(
      `External album search queries must be ${MAX_QUERY_LENGTH} characters or fewer`,
      { code: "INVALID_EXTERNAL_SEARCH", status: 400 },
    );
  }
  return query;
}

function normalizeLimit(value, { defaultValue = DEFAULT_LIMIT } = {}) {
  if (value === undefined || value === null || value === "") return defaultValue;
  const text = String(value).trim();
  if (!/^\d+$/u.test(text) || Number(text) < 1) {
    throw new MusicBrainzSearchError("External album search limit must be a positive integer", {
      code: "INVALID_EXTERNAL_SEARCH",
      status: 400,
    });
  }
  return Math.min(Number(text), MAX_LIMIT);
}

function escapeLucene(value) {
  // MusicBrainz uses Lucene query syntax. Escape operators and special
  // characters so a user's album title remains a literal search term.
  return String(value).replace(/(\+|-|&&|\|\||!|\(|\)|\{|\}|\[|\]|\^|"|~|\*|\?|:|\\|\/)/gu, "\\$1");
}

function normalizeMatchText(value) {
  return typeof value === "string" ? value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim() : "";
}

const SEARCH_FIELDS = ["releasegroup", "artistname", "artist", "alias"];

function buildSearchUrl(query, baseUrl = MUSICBRAINZ_BASE_URL) {
  const normalizedQuery = normalizeSearchQuery(query);
  const phrase = `"${escapeLucene(normalizedQuery)}"`;
  const boosts = [8, 4, 4, 2];
  const clauses = SEARCH_FIELDS.map((field, index) => `${field}:${phrase}^${boosts[index]}`);
  const tokens = [...new Set(normalizeMatchText(normalizedQuery).split(" ").filter(Boolean))];
  if (tokens.length) {
    // Each token may belong to either the title or artist; no guessed split.
    const crossField = tokens.map((token) => `(${SEARCH_FIELDS
      .map((field) => `${field}:"${escapeLucene(token)}"`).join(" OR ")})`);
    clauses.push(`(${crossField.join(" AND ")})`);
  }
  const url = new URL(`${String(baseUrl).replace(/\/+$/u, "")}/release-group`);
  url.searchParams.set("query", `(${clauses.join(" OR ")})`);
  url.searchParams.set("limit", String(PROVIDER_LIMIT));
  url.searchParams.set("fmt", "json");
  return url.toString();
}

function buildReleaseGroupUrl(mbid, baseUrl = MUSICBRAINZ_BASE_URL) {
  const normalizedMbid = normalizeMbid(mbid);
  if (!normalizedMbid) {
    throw new MusicBrainzSearchError("Invalid release-group MBID", {
      code: "INVALID_EXTERNAL_SEARCH",
      status: 400,
    });
  }
  const url = new URL(`${String(baseUrl).replace(/\/+$/u, "")}/release-group/${normalizedMbid}`);
  url.searchParams.set("inc", "artist-credits");
  url.searchParams.set("fmt", "json");
  return url.toString();
}

function artistCredits(rawCredits) {
  if (!Array.isArray(rawCredits) || rawCredits.length === 0 || rawCredits.length > 64) return null;

  const credits = rawCredits.map((credit) => {
    const name = normalizeText(credit?.name || credit?.artist?.name);
    const joinPhrase = normalizeJoinPhrase(credit?.joinphrase);
    return name ? { name, joinPhrase } : null;
  });
  if (credits.some((credit) => !credit)) return null;

  const artistDisplayName = credits
    .map((credit) => `${credit.name}${credit.joinPhrase}`)
    .join("");
  if (!artistDisplayName || artistDisplayName.length > 500) return null;

  return {
    artistDisplayName,
    artistCredits: credits.map((credit) => ({ name: credit.name, role: "main" })),
  };
}

function baseReleaseGroupMetadata(data) {
  const mbid = normalizeMbid(data?.id);
  const title = normalizeText(data?.title);
  const credits = artistCredits(data?.["artist-credit"]);
  if (!mbid || !title || title.length > 500 || !credits) return null;

  return {
    externalId: mbid,
    title,
    artistDisplayName: credits.artistDisplayName,
    artistCredits: credits.artistCredits,
    releaseType: mapReleaseType(data?.["primary-type"], data?.["secondary-types"]),
    ...parsePartialDate(data?.["first-release-date"]),
    sourceUrl: canonicalMusicBrainzUrl("release-group", mbid),
  };
}

function mapReleaseGroupToCandidate(data) {
  const metadata = baseReleaseGroupMetadata(data);
  if (!metadata) return null;

  return {
    kind: "external",
    provider: "musicbrainz",
    entityType: "release-group",
    externalId: metadata.externalId,
    title: metadata.title,
    artistDisplayName: metadata.artistDisplayName,
    artistCredits: metadata.artistCredits,
    releaseType: metadata.releaseType,
    releaseDate: metadata.releaseDate,
    releaseDatePrecision: metadata.releaseDatePrecision,
    releaseYear: metadata.releaseYear,
    cover: `${COVER_ART_ARCHIVE_BASE_URL}/release-group/${metadata.externalId}/front-250`,
    sourceUrl: metadata.sourceUrl,
  };
}

function mapReleaseGroupToSuggestionDraft(data) {
  const metadata = baseReleaseGroupMetadata(data);
  if (!metadata) {
    throw new MusicBrainzSearchError("MusicBrainz returned an invalid release group", {
      code: "MUSICBRAINZ_INVALID_RELEASE_GROUP",
    });
  }

  return {
    proposedMetadata: {
      title: metadata.title,
      artistDisplayName: metadata.artistDisplayName,
      artistCredits: metadata.artistCredits,
      releaseType: metadata.releaseType,
      releaseDate: metadata.releaseDate,
      releaseDatePrecision: metadata.releaseDatePrecision,
      releaseYear: metadata.releaseYear,
      label: "",
      country: "",
      catalogNumber: "",
      barcode: "",
      tracks: [],
      coverSourceUrl: "",
    },
    supportingSources: [{ type: "musicbrainz", url: metadata.sourceUrl }],
    externalReferences: [{
      provider: "musicbrainz",
      entityType: "release-group",
      externalId: metadata.externalId,
      url: metadata.sourceUrl,
    }],
  };
}

function validateSearchResponse(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data["release-groups"])) {
    throw new MusicBrainzSearchError("MusicBrainz returned an invalid release-group search response", {
      code: "MUSICBRAINZ_INVALID_SEARCH_RESPONSE",
    });
  }
  return data;
}

function validateReleaseGroupResponse(data, expectedMbid) {
  if (!data || typeof data !== "object" || normalizeMbid(data.id) !== expectedMbid) {
    throw new MusicBrainzSearchError("MusicBrainz returned an invalid release-group response", {
      code: "MUSICBRAINZ_INVALID_RELEASE_GROUP",
    });
  }
  return data;
}

function relevanceTier(candidate, group, query, queryTokens) {
  if (!query) return 0;
  const title = normalizeMatchText(candidate.title);
  if (title === query) return 3;
  // Canonical names help match renamed/credited artists but stay internal.
  const artists = [candidate.artistDisplayName, ...candidate.artistCredits.map((credit) => credit.name),
    ...group["artist-credit"].map((credit) => {
      const name = credit?.artist?.name;
      return typeof name === "string" && name.length <= 500 ? name : "";
    })].map(normalizeMatchText).filter(Boolean);
  if (artists.includes(query)) return 2;
  const fieldTokens = new Set([title, ...artists].join(" ").split(" ").filter(Boolean));
  return queryTokens.every((token) => fieldTokens.has(token)) ? 1 : 0;
}

function searchScore(value) {
  if (typeof value !== "number" && !(typeof value === "string" && /^\d+(?:\.\d+)?$/u.test(value))) return 0;
  const score = Number(value);
  return Number.isFinite(score) && score >= 0 && score <= 100 ? score : 0;
}

function orderedCandidates(data, query) {
  const matchQuery = normalizeMatchText(query);
  const queryTokens = matchQuery.split(" ").filter(Boolean);
  const ranked = data["release-groups"]
    .map((group, index) => {
      const candidate = mapReleaseGroupToCandidate(group);
      if (!candidate) return null;
      return {
        candidate,
        tier: relevanceTier(candidate, group, matchQuery, queryTokens),
        score: searchScore(group?.score),
        index,
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.tier - left.tier || right.score - left.score || left.index - right.index);
  const seen = new Set();
  return ranked
    .filter(({ candidate }) => {
      if (seen.has(candidate.externalId)) return false;
      seen.add(candidate.externalId);
      return true;
    })
    .map(({ candidate }) => candidate);
}

function cacheGet(cache, key, nowMs) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= nowMs()) {
    cache.delete(key);
    return null;
  }
  // Refresh insertion order to keep the bounded cache useful for active keys.
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function cacheSet(cache, key, value, nowMs, ttlMs, maxEntries) {
  cache.delete(key);
  while (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
  cache.set(key, { value, expiresAt: nowMs() + ttlMs });
}

function providerError(error, operation) {
  if (error instanceof MusicBrainzSearchError) return error;
  return new MusicBrainzSearchError(`MusicBrainz ${operation} failed`, {
    code: error instanceof CatalogFetchError ? "MUSICBRAINZ_REQUEST_FAILED" : "MUSICBRAINZ_PROVIDER_ERROR",
    status: error?.status,
    cause: error,
  });
}

function createMusicBrainzSearch(options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  if (typeof fetchFn !== "function") throw new TypeError("A fetch implementation is required");

  const userAgent = normalizeText(
    options.userAgent || process.env.MUSICBRAINZ_USER_AGENT || DEFAULT_USER_AGENT,
  );
  if (!userAgent || !/[(/@]/u.test(userAgent)) {
    throw new TypeError("MusicBrainz user agent must identify the application");
  }

  const nowMs = options.nowMs || Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_MUSICBRAINZ_INTERVAL_MS;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const cacheMaxEntries = options.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES;
  if (!Number.isInteger(cacheTtlMs) || cacheTtlMs < 0) throw new TypeError("cacheTtlMs must be a non-negative integer");
  if (!Number.isInteger(cacheMaxEntries) || cacheMaxEntries < 1) throw new TypeError("cacheMaxEntries must be a positive integer");

  const hasInjectedTiming = Boolean(
    options.fetchFn
    || options.nowMs
    || options.sleepFn
    || options.intervalMs !== undefined,
  );
  const rateGate = options.rateGate
    || (options.sharedRateGate || !hasInjectedTiming ? getSharedRateGate() : createRateGate({
      intervalMs,
      nowMs,
      sleepFn: options.sleepFn,
    }));
  const cache = new Map();
  const inFlight = new Map();
  const stats = { cacheHits: 0, cacheMisses: 0, networkRequests: 0 };
  const baseUrl = options.baseUrl || MUSICBRAINZ_BASE_URL;

  async function request(endpoint, operation, validate = (data) => data) {
    const gateStartedAt = nowMs();
    let fetchStartedAt;
    let gateWaitMs = 0;
    let upstreamStatus;
    let signal;
    try {
      const response = await requestJson(endpoint, {
        fetchFn: async (url, init) => {
          signal = init.signal;
          const result = await fetchFn(url, init);
          upstreamStatus = result.status;
          return result;
        },
        headers: { "User-Agent": userAgent },
        timeoutMs,
        retries: 0,
        sleepFn: options.sleepFn,
        nowMs,
        beforeAttempt: async () => {
          await rateGate();
          fetchStartedAt = nowMs();
          gateWaitMs = Math.max(0, fetchStartedAt - gateStartedAt);
          stats.networkRequests += 1;
        },
      });
      return validate(response.data);
    } catch (error) {
      const normalized = providerError(error, operation);
      // Allowlisted metadata only: underlying errors can contain the search URL.
      normalized.diagnostics = {
        category: signal?.aborted || error?.code === "request_timeout" ? "timeout"
          : error?.code === "http_error" ? "upstream_http"
            : error?.code === "invalid_json_response" || error instanceof MusicBrainzSearchError
              ? "invalid_response" : "network",
        ...(Number.isInteger(upstreamStatus) ? { upstreamStatus } : {}),
        gateWaitMs,
        fetchDurationMs: fetchStartedAt === undefined ? 0 : Math.max(0, nowMs() - fetchStartedAt),
      };
      throw normalized;
    }
  }

  function cachedRequest(key, operation) {
    const cached = cacheGet(cache, key, nowMs);
    if (cached !== null) {
      stats.cacheHits += 1;
      return Promise.resolve(cached);
    }
    const pending = inFlight.get(key);
    if (pending) return pending;

    stats.cacheMisses += 1;
    const requestPromise = operation()
      .then((value) => {
        cacheSet(cache, key, value, nowMs, cacheTtlMs, cacheMaxEntries);
        return value;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, requestPromise);
    return requestPromise;
  }

  async function searchReleaseGroups(query, limit = DEFAULT_LIMIT) {
    const normalizedQuery = normalizeSearchQuery(query);
    const normalizedLimit = normalizeLimit(limit);
    const key = `search:${normalizedQuery.toLowerCase()}`;
    const candidates = await cachedRequest(key, async () => {
      const endpoint = buildSearchUrl(normalizedQuery, baseUrl);
      return request(endpoint, "release-group search", (raw) => {
        const data = validateSearchResponse(raw);
        const mapped = orderedCandidates(data, normalizedQuery);
        if (data["release-groups"].length > 0 && mapped.length === 0) {
          throw new MusicBrainzSearchError("MusicBrainz returned no valid release groups", {
            code: "MUSICBRAINZ_INVALID_SEARCH_RESPONSE",
          });
        }
        return mapped;
      });
    });
    return candidates.slice(0, normalizedLimit);
  }

  async function getSuggestionDraft(mbid) {
    const normalizedMbid = normalizeMbid(mbid);
    if (!normalizedMbid) {
      throw new MusicBrainzSearchError("Invalid release-group MBID", {
        code: "INVALID_EXTERNAL_SEARCH",
        status: 400,
      });
    }
    const key = `release-group:${normalizedMbid}`;
    const data = await cachedRequest(key, async () => {
      return request(buildReleaseGroupUrl(normalizedMbid, baseUrl), "release-group lookup",
        (raw) => validateReleaseGroupResponse(raw, normalizedMbid));
    });
    return mapReleaseGroupToSuggestionDraft(data);
  }

  return {
    getSuggestionDraft,
    searchReleaseGroups,
    stats,
  };
}

let defaultSearchClient;

function getDefaultSearchClient() {
  if (!defaultSearchClient) defaultSearchClient = createMusicBrainzSearch();
  return defaultSearchClient;
}

async function searchReleaseGroups(query, limit = DEFAULT_LIMIT) {
  return getDefaultSearchClient().searchReleaseGroups(query, limit);
}

async function getSuggestionDraft(mbid) {
  return getDefaultSearchClient().getSuggestionDraft(mbid);
}

module.exports = {
  COVER_ART_ARCHIVE_BASE_URL,
  DEFAULT_CACHE_MAX_ENTRIES,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_LIMIT,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  MAX_LIMIT,
  MAX_QUERY_LENGTH,
  MUSICBRAINZ_BASE_URL,
  MusicBrainzSearchError,
  buildReleaseGroupUrl,
  buildSearchUrl,
  createMusicBrainzSearch,
  escapeLucene,
  getSuggestionDraft,
  mapReleaseGroupToCandidate,
  mapReleaseGroupToSuggestionDraft,
  normalizeLimit,
  normalizeSearchQuery,
  searchReleaseGroups,
};
