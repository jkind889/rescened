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
// One provider request per search page. MusicBrainz accepts 1-100.
const PROVIDER_LIMIT = 50;
const MAX_PROVIDER_LIMIT = 100;
// Deepest provider offset a caller may page to, for search and discography.
const MAX_PROVIDER_OFFSET = 1_000;
const MAX_QUERY_LENGTH = 200;
const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_CACHE_MAX_ENTRIES = 100;
// Search rows embed their releases, so a 100-row page can be large (a
// popular artist's 100-row page measured about 1.2 MB). The limit applies to
// decoded body bytes as they are read, not only to Content-Length.
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
// Artist discography pages: one provider request each, cached longer.
const DISCOGRAPHY_PAGE_SIZE = 100;
const DISCOGRAPHY_TIMEOUT_MS = 6_000;
const DISCOGRAPHY_CACHE_TTL_MS = 10 * 60_000;
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

function tooLarge() {
  return new MusicBrainzSearchError("MusicBrainz response is too large", { code: "MUSICBRAINZ_RESPONSE_TOO_LARGE" });
}

// Reads and parses a fetch body while counting decoded bytes, so a missing,
// chunked, or compressed Content-Length cannot bypass the limit. Injected
// test responses without a body or text() fall back to their json().
async function readBoundedJson(response, maxBytes = MAX_RESPONSE_BYTES) {
  let text;
  if (response.body && typeof response.body[Symbol.asyncIterator] === "function") {
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > maxBytes) {
        await response.body.cancel?.().catch?.(() => {});
        throw tooLarge();
      }
      chunks.push(Buffer.from(chunk));
    }
    text = Buffer.concat(chunks).toString("utf8");
  } else if (typeof response.text === "function") {
    text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw tooLarge();
  } else {
    return response.json();
  }
  return JSON.parse(text);
}

function providerWindow({ limit = PROVIDER_LIMIT, offset = 0 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PROVIDER_LIMIT) throw new TypeError(`Provider limit must be 1-${MAX_PROVIDER_LIMIT}`);
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_PROVIDER_OFFSET) throw new TypeError(`Provider offset must be 0-${MAX_PROVIDER_OFFSET}`);
  return { limit, offset };
}

function buildSearchUrl(query, baseUrl = MUSICBRAINZ_BASE_URL, window = {}) {
  const { limit, offset } = providerWindow(window);
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
  url.searchParams.set("limit", String(limit));
  if (offset) url.searchParams.set("offset", String(offset));
  url.searchParams.set("fmt", "json");
  return url.toString();
}

// Artist discography filters. The provider request browses the artist's
// release groups in MusicBrainz's website-default view, which leaves out
// groups whose releases are all promotional, bootleg, or pseudo-releases. It
// is not an official-only filter. "album", "ep", and "single" also send that
// primary type; a local predicate then keeps only rows with no secondary type
// (no live, compilation, remix, soundtrack, demo, DJ-mix, and so on). "other"
// is the complement and "all" keeps every row, both filtered locally.
const PLAIN_PRIMARY = { album: "album", ep: "ep", single: "single" };
const DISCOGRAPHY_FILTERS = ["album", "ep", "single", "other", "all"];

function primaryAndSecondary(group) {
  const primary = normalizeText(group?.["primary-type"]).toLowerCase();
  const secondary = (Array.isArray(group?.["secondary-types"]) ? group["secondary-types"] : [])
    .map((value) => normalizeText(value).toLowerCase()).filter(Boolean);
  return { primary, secondary };
}

function matchesDiscographyFilter(group, filter) {
  if (filter === "all") return true;
  const { primary, secondary } = primaryAndSecondary(group);
  const plain = Object.values(PLAIN_PRIMARY).includes(primary) && secondary.length === 0;
  if (filter === "other") return !plain;
  return plain && primary === PLAIN_PRIMARY[filter];
}

// The search index is not trusted for identity: a row counts only when its
// own artist credit names the requested MusicBrainz artist.
function creditsArtist(group, artistMbid) {
  return (Array.isArray(group?.["artist-credit"]) ? group["artist-credit"] : [])
    .some((credit) => normalizeMbid(credit?.artist?.id) === artistMbid);
}

function buildArtistDiscographyUrl(artistMbid, filter = "album", baseUrl = MUSICBRAINZ_BASE_URL, window = {}) {
  const mbid = normalizeMbid(artistMbid);
  if (!mbid) throw new MusicBrainzSearchError("Invalid artist MBID", { code: "INVALID_EXTERNAL_SEARCH", status: 400 });
  if (!DISCOGRAPHY_FILTERS.includes(filter)) throw new MusicBrainzSearchError("Invalid discography filter", { code: "INVALID_EXTERNAL_SEARCH", status: 400 });
  const { limit, offset } = providerWindow({ limit: DISCOGRAPHY_PAGE_SIZE, ...window });
  const url = new URL(`${String(baseUrl).replace(/\/+$/u, "")}/release-group`);
  // Browsing by artist covers every release group whose artist credit names
  // the artist, so collaborations appear on each credited artist's page.
  url.searchParams.set("artist", mbid);
  if (PLAIN_PRIMARY[filter]) url.searchParams.set("type", PLAIN_PRIMARY[filter]);
  url.searchParams.set("release-group-status", "website-default");
  url.searchParams.set("inc", "artist-credits");
  url.searchParams.set("limit", String(limit));
  if (offset) url.searchParams.set("offset", String(offset));
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
    return name ? { name, joinPhrase, artistMbid: normalizeMbid(credit?.artist?.id) } : null;
  });
  if (credits.some((credit) => !credit)) return null;

  const artistDisplayName = credits
    .map((credit) => `${credit.name}${credit.joinPhrase}`)
    .join("");
  if (!artistDisplayName || artistDisplayName.length > 500) return null;

  return {
    artistDisplayName,
    // The MusicBrainz artist MBID travels with each credit so a suggestion
    // started from this release group can propose that identity; approval
    // resolves it to a Rescened artistId.
    artistCredits: credits.map((credit) => (
      credit.artistMbid ? { name: credit.name, role: "main", artistMbid: credit.artistMbid } : { name: credit.name, role: "main" }
    )),
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

// Search responses report `count`; browse responses `release-group-count`.
function providerTotal(data) {
  const count = Number(data?.count ?? data?.["release-group-count"]);
  return Number.isInteger(count) && count >= 0 ? count : null;
}

// Candidates in display order with their relevance tier (3 exact title,
// 2 exact artist, 1 every token present, 0 other), before de-duplication.
function rankedCandidates(data, query) {
  const matchQuery = normalizeMatchText(query);
  const queryTokens = matchQuery.split(" ").filter(Boolean);
  return data["release-groups"]
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
}

function orderedCandidates(data, query) {
  const ranked = rankedCandidates(data, query);
  const seen = new Set();
  return ranked
    .filter(({ candidate }) => {
      if (seen.has(candidate.externalId)) return false;
      seen.add(candidate.externalId);
      return true;
    })
    .map(({ candidate }) => candidate);
}

// Raw provider paging facts. nextOffset advances by rows MusicBrainz
// returned, so filtering or de-duplication never skips or repeats rows. It is
// null at the end, at the offset cap, or if the provider returns no rows.
function pageResult(data, window, candidates) {
  const returned = data["release-groups"].length;
  const providerCount = providerTotal(data);
  const next = window.offset + returned;
  const more = returned > 0 && (providerCount === null ? returned === window.limit : next < providerCount);
  return {
    candidates,
    providerCount,
    offset: window.offset,
    returned,
    nextOffset: more && next <= MAX_PROVIDER_OFFSET ? next : null,
    truncatedAtOffsetCap: more && next > MAX_PROVIDER_OFFSET,
  };
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
  const discographyTimeoutMs = options.discographyTimeoutMs ?? DISCOGRAPHY_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const discographyCacheTtlMs = options.discographyCacheTtlMs ?? DISCOGRAPHY_CACHE_TTL_MS;

  async function request(endpoint, operation, validate = (data) => data, { timeout = timeoutMs } = {}) {
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
          // Early refusal when a successful response declares an oversized
          // body; the real bound is enforced while the body is read below.
          // Non-OK responses keep their upstream_http classification.
          if (result.ok && Number(result.headers?.get?.("content-length") || 0) > maxResponseBytes) {
            await result.body?.cancel?.();
            throw tooLarge();
          }
          return {
            ok: result.ok,
            status: result.status,
            headers: result.headers,
            json: () => readBoundedJson(result, maxResponseBytes),
          };
        },
        headers: { "User-Agent": userAgent },
        timeoutMs: timeout,
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
            // response.json() can reject for a broken stream as well as bad JSON.
            // A size refusal thrown inside fetch is wrapped as a network error.
            : (error?.code === "invalid_json_response" && error.cause instanceof SyntaxError)
              || error?.cause instanceof MusicBrainzSearchError
              || error instanceof MusicBrainzSearchError
              ? "invalid_response" : "network",
        ...(Number.isInteger(upstreamStatus) ? { upstreamStatus } : {}),
        gateWaitMs,
        fetchDurationMs: fetchStartedAt === undefined ? 0 : Math.max(0, nowMs() - fetchStartedAt),
      };
      throw normalized;
    }
  }

  function cachedRequest(key, operation, ttlMs = cacheTtlMs) {
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
        cacheSet(cache, key, value, nowMs, ttlMs, cacheMaxEntries);
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

  // One provider page of text-search candidates. `offset` is the raw
  // MusicBrainz offset; callers advance it by `returned`, not by how many
  // candidates survived mapping and de-duplication.
  async function searchReleaseGroupPage(query, { offset = 0, providerLimit = PROVIDER_LIMIT } = {}) {
    const normalizedQuery = normalizeSearchQuery(query);
    const window = providerWindow({ limit: providerLimit, offset });
    const key = `search-page:${window.limit}:${window.offset}:${normalizedQuery.toLowerCase()}`;
    return cachedRequest(key, async () => request(buildSearchUrl(normalizedQuery, baseUrl, window), "release-group search", (raw) => {
      const data = validateSearchResponse(raw);
      const candidates = orderedCandidates(data, normalizedQuery);
      if (data["release-groups"].length > 0 && candidates.length === 0) {
        throw new MusicBrainzSearchError("MusicBrainz returned no valid release groups", { code: "MUSICBRAINZ_INVALID_SEARCH_RESPONSE" });
      }
      return pageResult(data, window, candidates);
    }));
  }

  // One provider page of an artist's release groups for a filter. Rows are
  // re-checked against the filter and sorted newest first within the page.
  async function browseArtistDiscography(artistMbid, { filter = "album", offset = 0 } = {}) {
    const endpoint = buildArtistDiscographyUrl(artistMbid, filter, baseUrl, { offset });
    const mbid = normalizeMbid(artistMbid);
    const window = providerWindow({ limit: DISCOGRAPHY_PAGE_SIZE, offset });
    const key = `discography:${mbid}:${filter}:${window.offset}`;
    return cachedRequest(key, async () => request(endpoint, "artist discography", (raw) => {
      const data = validateSearchResponse(raw);
      const seen = new Set();
      let filteredOut = 0;
      const candidates = [];
      for (const group of data["release-groups"]) {
        if (!creditsArtist(group, mbid) || !matchesDiscographyFilter(group, filter)) { filteredOut += 1; continue; }
        const candidate = mapReleaseGroupToCandidate(group);
        if (!candidate) { filteredOut += 1; continue; }
        if (seen.has(candidate.externalId)) continue;
        seen.add(candidate.externalId);
        candidates.push(candidate);
      }
      candidates.sort((left, right) => String(right.releaseDate || "").localeCompare(String(left.releaseDate || ""))
        || left.title.localeCompare(right.title) || left.externalId.localeCompare(right.externalId));
      return { ...pageResult(data, window, candidates), filteredOut };
    }, { timeout: discographyTimeoutMs }), discographyCacheTtlMs);
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
    browseArtistDiscography,
    getSuggestionDraft,
    searchReleaseGroupPage,
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

async function searchReleaseGroupPage(query, options) {
  return getDefaultSearchClient().searchReleaseGroupPage(query, options);
}

async function browseArtistDiscography(artistMbid, options) {
  return getDefaultSearchClient().browseArtistDiscography(artistMbid, options);
}

module.exports = {
  COVER_ART_ARCHIVE_BASE_URL,
  DISCOGRAPHY_FILTERS,
  DISCOGRAPHY_PAGE_SIZE,
  MAX_PROVIDER_LIMIT,
  MAX_PROVIDER_OFFSET,
  PROVIDER_LIMIT,
  browseArtistDiscography,
  buildArtistDiscographyUrl,
  creditsArtist,
  matchesDiscographyFilter,
  readBoundedJson,
  rankedCandidates,
  searchReleaseGroupPage,
  validateSearchResponse,
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
