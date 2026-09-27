"use strict";

const crypto = require("node:crypto");
const { ProviderBudget, ProviderCache } = require("../../models/Listening");
const { requestSlot } = require("../listening/musicBrainz");

const MUSICBRAINZ_BASE_URL = "https://musicbrainz.org/ws/2";
const MBID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_TRACKS = 200;
const MAX_BROWSE_LIMIT = 50;
const MAX_BROWSE_OFFSET = 10_000;
const MAX_RECOMMEND_PAGES = 1;
const MAX_RECOMMEND_LOOKUPS = 3;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_USER_AGENT = "Rescened/1.0 (https://github.com/jkind889/rescened)";

class BaselineMusicBrainzError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "BaselineMusicBrainzError";
    this.code = options.code || "MUSICBRAINZ_PROVIDER_ERROR";
    this.status = options.status || 502;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

function normalizeMbid(value) {
  const result = typeof value === "string" ? value.trim().toLowerCase() : "";
  return MBID_PATTERN.test(result) ? result : "";
}

function clean(value, max = 500) {
  if (typeof value !== "string") return "";
  const result = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  return result.length <= max ? result : "";
}

function artistCredits(rawCredits) {
  if (!Array.isArray(rawCredits) || rawCredits.length < 1 || rawCredits.length > 64) return "";
  const result = rawCredits.map((credit) => {
    const name = clean(credit?.name || credit?.artist?.name);
    const joinPhrase = typeof credit?.joinphrase === "string" ? credit.joinphrase.normalize("NFC") : "";
    return name && joinPhrase.length <= 32 ? `${name}${joinPhrase}` : "";
  });
  const display = result.join("");
  return display && display.length <= 500 ? display : "";
}

function validDate(value) {
  const date = clean(value, 10);
  if (!date || !/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/u.test(date)) return "";
  const [year, month, day] = date.split("-").map(Number);
  if (year < 1 || (month !== undefined && (month < 1 || month > 12))) return "";
  if (day !== undefined) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (day < 1 || day > days[month - 1]) return "";
  }
  return date;
}

function canonicalUrl(entity, id) {
  return `https://musicbrainz.org/${entity}/${id}`;
}

function parseReleaseId(value) {
  const direct = normalizeMbid(value);
  if (direct) return direct;
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !["musicbrainz.org", "www.musicbrainz.org"].includes(url.hostname)) return "";
    if (url.username || url.password || url.search || url.hash) return "";
    const match = /^\/release\/([0-9a-f-]+)\/?$/iu.exec(url.pathname);
    return match ? normalizeMbid(match[1]) : "";
  } catch {
    return "";
  }
}

function parseRetryAfter(value, nowMs) {
  if (value === null || value === undefined || value === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - nowMs) : null;
}

function normalizeLimit(value, fallback, max) {
  if (value === undefined || value === null || value === "") return fallback;
  if (!/^(?:0|[1-9]\d*)$/u.test(String(value))) throw new BaselineMusicBrainzError("Invalid provider page limit", { code: "INVALID_PROVIDER_INPUT", status: 400 });
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw new BaselineMusicBrainzError("Provider page limit is out of bounds", { code: "INVALID_PROVIDER_INPUT", status: 400 });
  return parsed;
}

function normalizeOffset(value) {
  if (value === undefined || value === null || value === "") return 0;
  if (!/^(?:0|[1-9]\d*)$/u.test(String(value))) throw new BaselineMusicBrainzError("Invalid provider page offset", { code: "INVALID_PROVIDER_INPUT", status: 400 });
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_BROWSE_OFFSET) throw new BaselineMusicBrainzError("Provider page offset is out of bounds", { code: "INVALID_PROVIDER_INPUT", status: 400 });
  return parsed;
}

function normalizeTitle(value) {
  return clean(value, 500).toLowerCase();
}

function escapeLucene(value) {
  return String(value).replace(/(\+|-|&&|\|\||!|\(|\)|\{|\}|\[|\]|\^|"|~|\*|\?|:|\\|\/)/gu, "\\$1");
}

function sourceQueryUrl(pathname, params) {
  const url = new URL(`${MUSICBRAINZ_BASE_URL}/${pathname}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url.toString();
}

async function readBoundedBody(response, maxBytes) {
  const contentLength = Number(response?.headers?.get?.("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new BaselineMusicBrainzError("MusicBrainz response is too large", { code: "MUSICBRAINZ_RESPONSE_TOO_LARGE", status: 502 });
  }
  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        size += chunk.length;
        if (size > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new BaselineMusicBrainzError("MusicBrainz response is too large", { code: "MUSICBRAINZ_RESPONSE_TOO_LARGE", status: 502 });
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock?.();
    }
    return Buffer.concat(chunks, size).toString("utf8");
  }
  if (typeof response?.text === "function") {
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > maxBytes) throw new BaselineMusicBrainzError("MusicBrainz response is too large", { code: "MUSICBRAINZ_RESPONSE_TOO_LARGE", status: 502 });
    return body;
  }
  const data = await response.json();
  const body = JSON.stringify(data);
  if (Buffer.byteLength(body, "utf8") > maxBytes) throw new BaselineMusicBrainzError("MusicBrainz response is too large", { code: "MUSICBRAINZ_RESPONSE_TOO_LARGE", status: 502 });
  return body;
}

function normalizeSearchItem(raw) {
  const releaseGroupMbid = normalizeMbid(raw?.id);
  const title = clean(raw?.title);
  const artistDisplayName = artistCredits(raw?.["artist-credit"]);
  if (!releaseGroupMbid || !title || !artistDisplayName) return null;
  return {
    releaseGroupMbid,
    title,
    artistDisplayName,
    date: validDate(raw?.["first-release-date"]),
    score: Number.isFinite(Number(raw?.score)) ? Number(raw.score) : null,
    sourceUrl: canonicalUrl("release-group", releaseGroupMbid),
  };
}

function normalizeBrowseItem(raw, expectedGroup) {
  const releaseMbid = normalizeMbid(raw?.id);
  const releaseGroupMbid = normalizeMbid(raw?.["release-group"]?.id || raw?.["release-group-mbid"]);
  const title = clean(raw?.title);
  const artistDisplayName = artistCredits(raw?.["artist-credit"]);
  if (!releaseMbid || releaseGroupMbid !== expectedGroup || !title || !artistDisplayName) return null;
  const media = Array.isArray(raw?.media) ? raw.media : [];
  const trackCount = media.reduce((sum, medium) => sum + (Number.isSafeInteger(medium?.["track-count"]) ? medium["track-count"] : 0), 0);
  return {
    releaseMbid,
    releaseGroupMbid,
    title,
    artistDisplayName,
    date: validDate(raw?.date),
    country: clean(raw?.country, 100),
    formats: [...new Set(media.map((medium) => clean(medium?.format || medium?.["format-name"], 100)).filter(Boolean))],
    disambiguation: clean(raw?.disambiguation, 500),
    status: clean(raw?.status, 100),
    trackCount: trackCount > 0 ? trackCount : null,
    sourceUrl: canonicalUrl("release", releaseMbid),
  };
}

function normalizeTrackArtist(rawTrack, releaseArtist) {
  return artistCredits(rawTrack?.["artist-credit"])
    || artistCredits(rawTrack?.recording?.["artist-credit"])
    || releaseArtist;
}

function hashCandidateTracklist(candidate) {
  const hashInput = {
    releaseMbid: candidate?.releaseMbid,
    releaseGroupMbid: candidate?.releaseGroupMbid,
    title: candidate?.title,
    artistDisplayName: candidate?.artistDisplayName,
    tracks: candidate?.tracks?.map(({ discNumber, trackNumber, title, durationMs, artistDisplayName, releaseTrackMbid, recordingMbid }) => ({ discNumber, trackNumber, title, durationMs, artistDisplayName, releaseTrackMbid, recordingMbid })),
  };
  return crypto.createHash("sha256").update(JSON.stringify(hashInput)).digest("hex");
}

function validateNormalizedCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") {
    throw new BaselineMusicBrainzError("Baseline candidate must be an object", { code: "MUSICBRAINZ_INVALID_CANDIDATE", status: 400 });
  }
  const releaseMbid = normalizeMbid(candidate.releaseMbid);
  const releaseGroupMbid = normalizeMbid(candidate.releaseGroupMbid);
  if (!releaseMbid || !releaseGroupMbid || !clean(candidate.title) || !clean(candidate.artistDisplayName)) {
    throw new BaselineMusicBrainzError("Baseline candidate has invalid release identity", { code: "MUSICBRAINZ_INVALID_CANDIDATE", status: 400 });
  }
  if (!Array.isArray(candidate.tracks) || candidate.tracks.length < 1 || candidate.tracks.length > MAX_TRACKS) {
    throw new BaselineMusicBrainzError("Baseline candidate has an invalid track count", { code: "MUSICBRAINZ_INVALID_CANDIDATE", status: 400 });
  }
  const seen = new Set();
  const positionsByDisc = new Map();
  for (const track of candidate.tracks) {
    const discNumber = track?.discNumber;
    const trackNumber = track?.trackNumber;
    if (!Number.isSafeInteger(discNumber) || discNumber < 1 || !Number.isSafeInteger(trackNumber) || trackNumber < 1
      || seen.has(`${discNumber}:${trackNumber}`) || !clean(track?.title)
      || !normalizeMbid(track?.releaseTrackMbid) || !normalizeMbid(track?.recordingMbid)
      || (track.durationMs !== null && track.durationMs !== undefined
        && (!Number.isSafeInteger(track.durationMs) || track.durationMs < 0 || track.durationMs > 86_400_000))) {
      throw new BaselineMusicBrainzError("Baseline candidate has invalid track positions or identities", { code: "MUSICBRAINZ_INVALID_CANDIDATE", status: 400 });
    }
    seen.add(`${discNumber}:${trackNumber}`);
    if (!positionsByDisc.has(discNumber)) positionsByDisc.set(discNumber, []);
    positionsByDisc.get(discNumber).push(trackNumber);
  }
  if ([...positionsByDisc.keys()].sort((a, b) => a - b).some((disc, index) => disc !== index + 1)) {
    throw new BaselineMusicBrainzError("Baseline candidate has incomplete media positions", { code: "MUSICBRAINZ_INVALID_CANDIDATE", status: 400 });
  }
  for (const positions of positionsByDisc.values()) {
    positions.sort((left, right) => left - right);
    if (positions.some((position, index) => position !== index + 1)) {
      throw new BaselineMusicBrainzError("Baseline candidate has incomplete track positions", { code: "MUSICBRAINZ_INVALID_CANDIDATE", status: 400 });
    }
  }
  if (candidate.tracklistHash !== hashCandidateTracklist(candidate)) {
    throw new BaselineMusicBrainzError("Baseline candidate tracklist hash does not match its tracks", { code: "MUSICBRAINZ_CANDIDATE_HASH_MISMATCH", status: 409 });
  }
  return true;
}

function normalizeRelease(data, expectedMbid, retrievedAt) {
  const releaseMbid = normalizeMbid(data?.id);
  const releaseGroupMbid = normalizeMbid(data?.["release-group"]?.id || data?.["release-group-mbid"]);
  const title = clean(data?.title);
  const artistDisplayName = artistCredits(data?.["artist-credit"]);
  if (releaseMbid !== expectedMbid || !releaseGroupMbid || !title || !artistDisplayName) {
    throw new BaselineMusicBrainzError("MusicBrainz returned an invalid release identity", { code: "MUSICBRAINZ_INVALID_RESPONSE", status: 502 });
  }
  const media = data?.media;
  if (!Array.isArray(media) || media.length < 1 || media.length > 50) {
    throw new BaselineMusicBrainzError("MusicBrainz release has incomplete media", { code: "MUSICBRAINZ_INCOMPLETE_TRACKLIST", status: 502 });
  }
  const mediumPositions = media.map((medium) => medium?.position);
  if (mediumPositions.some((position) => !Number.isSafeInteger(position) || position < 1)
    || new Set(mediumPositions).size !== mediumPositions.length
    || [...mediumPositions].sort((a, b) => a - b).some((position, index) => position !== index + 1)) {
    throw new BaselineMusicBrainzError("MusicBrainz release media positions are incomplete", { code: "MUSICBRAINZ_INCOMPLETE_TRACKLIST", status: 502 });
  }
  const tracks = [];
  for (const medium of [...media].sort((a, b) => a.position - b.position)) {
    if (!Array.isArray(medium.tracks) || !Number.isSafeInteger(medium["track-count"]) || medium["track-count"] !== medium.tracks.length || medium.tracks.length < 1) {
      throw new BaselineMusicBrainzError("MusicBrainz release has an incomplete medium", { code: "MUSICBRAINZ_INCOMPLETE_TRACKLIST", status: 502 });
    }
    const positions = medium.tracks.map((track) => track?.position);
    if (positions.some((position) => !Number.isSafeInteger(position) || position < 1)
      || new Set(positions).size !== positions.length
      || [...positions].sort((a, b) => a - b).some((position, index) => position !== index + 1)) {
      throw new BaselineMusicBrainzError("MusicBrainz release track positions are incomplete", { code: "MUSICBRAINZ_INCOMPLETE_TRACKLIST", status: 502 });
    }
    for (const rawTrack of [...medium.tracks].sort((a, b) => a.position - b.position)) {
      const releaseTrackMbid = normalizeMbid(rawTrack?.id);
      const recordingMbid = normalizeMbid(rawTrack?.recording?.id);
      const trackTitle = clean(rawTrack?.title || rawTrack?.recording?.title);
      const trackArtist = normalizeTrackArtist(rawTrack, artistDisplayName);
      const durationValue = rawTrack?.length ?? rawTrack?.recording?.length;
      const durationMs = durationValue === undefined || durationValue === null || durationValue === ""
        ? null : Number(durationValue);
      if (!releaseTrackMbid || !recordingMbid || !trackTitle || !trackArtist
        || (durationMs !== null && (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > 86_400_000))) {
        throw new BaselineMusicBrainzError("MusicBrainz release has an invalid track", { code: "MUSICBRAINZ_INVALID_RESPONSE", status: 502 });
      }
      tracks.push({
        discNumber: medium.position,
        trackNumber: rawTrack.position,
        title: trackTitle,
        durationMs,
        artistDisplayName: trackArtist,
        releaseTrackMbid,
        recordingMbid,
      });
      if (tracks.length > MAX_TRACKS) throw new BaselineMusicBrainzError("MusicBrainz release exceeds the track limit", { code: "MUSICBRAINZ_TRACK_LIMIT_EXCEEDED", status: 502 });
    }
  }
  const date = validDate(data?.date);
  const country = clean(data?.country, 100);
  const formats = [...new Set(media.map((medium) => clean(medium?.format || medium?.["format-name"], 100)).filter(Boolean))];
  const disambiguation = clean(data?.disambiguation, 500);
  const status = clean(data?.status, 100);
  const candidate = {
    releaseMbid,
    releaseGroupMbid,
    title,
    artistDisplayName,
    date,
    country,
    formats,
    disambiguation,
    status,
    tracks,
    retrievedAt,
    sourceUrl: canonicalUrl("release", releaseMbid),
    license: "CC0",
    tracklistHash: "",
  };
  candidate.tracklistHash = hashCandidateTracklist(candidate);
  return candidate;
}

function markerFree(title) {
  return !/\b(?:deluxe|expanded|bonus|anniversary)\b/iu.test(title);
}

function sortableDate(value) {
  return /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/u.test(value || "") ? value : "9999-99-99";
}

function recommendationOrder(item, requestedTitle) {
  const exactTitle = normalizeTitle(item.title) === normalizeTitle(requestedTitle);
  const official = normalizeTitle(item.status) === "official";
  const cleanEdition = markerFree(item.title) && !/\b(?:deluxe|expanded|bonus|anniversary)\b/iu.test(item.disambiguation || "");
  return [official ? 0 : 1, exactTitle ? 0 : 1, cleanEdition ? 0 : 1, sortableDate(item.date), item.releaseMbid];
}

function compareRecommendation(left, right) {
  const a = recommendationOrder(left, left.__requestedTitle);
  const b = recommendationOrder(right, right.__requestedTitle);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] < b[index]) return -1;
    if (a[index] > b[index]) return 1;
  }
  return 0;
}

function qualityKey(item, requestedTitle) {
  const order = recommendationOrder({ ...item, __requestedTitle: requestedTitle }, requestedTitle);
  return order.slice(0, 3).join("|");
}

function createBaselineMusicBrainz(options = {}) {
  const fetchImpl = options.fetch || options.fetchFn || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");
  const clock = options.clock || (() => new Date());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) throw new TypeError("timeoutMs must be between 100 and 30000");
  const userAgent = clean(options.userAgent || process.env.MUSICBRAINZ_USER_AGENT || DEFAULT_USER_AGENT);
  if (!userAgent || !/[(/@]/u.test(userAgent)) throw new TypeError("MusicBrainz user agent must identify the application");
  const gate = options.gate || (() => requestSlot({ clock, sleep: options.sleep }));
  const cache = options.cache === false ? null : (options.cache || ProviderCache);
  const budget = options.budget || (options.gate ? null : ProviderBudget);
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  if (!Number.isSafeInteger(cacheTtlMs) || cacheTtlMs < 0) throw new TypeError("cacheTtlMs must be a non-negative integer");
  const inflight = new Map();

  function nowDate() {
    const result = clock();
    const date = result instanceof Date ? result : new Date(result);
    if (Number.isNaN(date.getTime())) throw new TypeError("clock must return a valid date");
    return date;
  }

  async function cacheGet(key) {
    if (!cache) return null;
    if (typeof cache.get === "function") {
      const result = await cache.get(key);
      if (!result) return null;
      if (result.expiresAt !== undefined && new Date(result.expiresAt).getTime() <= nowDate().getTime()) return null;
      return result.value === undefined ? result : result.value;
    }
    if (typeof cache.findOne !== "function") return null;
    const query = cache.findOne({ key, expiresAt: { $gt: nowDate() } });
    const row = typeof query?.lean === "function" ? await query.lean() : await query;
    return row?.value ?? null;
  }

  async function cacheSet(key, value) {
    if (!cache) return;
    if (typeof cache.set === "function") {
      await cache.set(key, value, cacheTtlMs);
      return;
    }
    if (typeof cache.updateOne === "function") {
      await cache.updateOne({ key }, { $set: { value, expiresAt: new Date(nowDate().getTime() + cacheTtlMs) }, $setOnInsert: { key } }, { upsert: true });
    }
  }

  async function noteRetryAfter(delayMs) {
    if (typeof options.onRetryAfter === "function") {
      await options.onRetryAfter(delayMs);
      return;
    }
    if (!budget || !Number.isFinite(delayMs) || delayMs <= 0 || typeof budget.updateOne !== "function") return;
    const bounded = Math.min(delayMs, 24 * 60 * 60 * 1_000);
    const cooldown = new Date(nowDate().getTime() + bounded);
    await budget.updateOne({ key: "musicbrainz-listening" }, {
      $max: { windowStartedAt: cooldown },
      $setOnInsert: { key: "musicbrainz-listening", used: 1 },
    }, { upsert: true });
  }

  async function request(pathname, key, validate = () => {}) {
    const cached = await cacheGet(key);
    if (cached !== null) { validate(cached); return cached; }
    const pending = inflight.get(key);
    if (pending) return pending;
    const operation = (async () => {
      await gate();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const url = `${MUSICBRAINZ_BASE_URL}/${pathname.replace(/^\/+/, "")}`;
        const response = await fetchImpl(url, { method: "GET", headers: { Accept: "application/json", "User-Agent": userAgent }, signal: controller.signal });
        const retryAfterMs = parseRetryAfter(response.headers?.get?.("retry-after"), nowDate().getTime());
        if (!response.ok) {
          if (retryAfterMs !== null) await noteRetryAfter(retryAfterMs);
          if (response.status === 404) throw new BaselineMusicBrainzError("MusicBrainz release was not found", { code: "MUSICBRAINZ_NOT_FOUND", status: 404, retryAfterMs });
          throw new BaselineMusicBrainzError("MusicBrainz is unavailable", { code: response.status === 429 ? "MUSICBRAINZ_RATE_LIMITED" : "MUSICBRAINZ_UNAVAILABLE", status: response.status === 429 ? 503 : 502, retryAfterMs });
        }
        let data;
        try { data = JSON.parse(await readBoundedBody(response, MAX_RESPONSE_BYTES)); }
        catch (error) {
          if (error instanceof BaselineMusicBrainzError) throw error;
          throw new BaselineMusicBrainzError("MusicBrainz returned malformed JSON", { code: "MUSICBRAINZ_INVALID_RESPONSE", status: 502, cause: error });
        }
        validate(data);
        await cacheSet(key, data);
        return data;
      } catch (error) {
        if (error instanceof BaselineMusicBrainzError) throw error;
        throw new BaselineMusicBrainzError(controller.signal.aborted ? "MusicBrainz request timed out" : "MusicBrainz request failed", { code: controller.signal.aborted ? "MUSICBRAINZ_TIMEOUT" : "MUSICBRAINZ_UNAVAILABLE", status: 503, cause: error });
      } finally { clearTimeout(timer); }
    })();
    inflight.set(key, operation);
    try { return await operation; } finally { inflight.delete(key); }
  }

  async function searchReleaseGroups(query, limit = 12) {
    const normalizedQuery = clean(query, 200);
    if (!normalizedQuery) throw new BaselineMusicBrainzError("A release-group search query is required", { code: "INVALID_PROVIDER_INPUT", status: 400 });
    const boundedLimit = normalizeLimit(limit, 12, 50);
    const url = new URL(sourceQueryUrl("release-group", { query: `releasegroup:"${escapeLucene(normalizedQuery)}"`, limit: 50, fmt: "json" }));
    const data = await request(`release-group${url.search}`, `baseline-mb:search:${normalizedQuery.toLowerCase()}`, (raw) => {
      if (!Array.isArray(raw?.["release-groups"]) || raw["release-groups"].length > 50 || (raw["release-groups"].length && !raw["release-groups"].some(normalizeSearchItem))) throw new BaselineMusicBrainzError("Invalid release-group search", { code: "MUSICBRAINZ_INVALID_RESPONSE", status: 502 });
    });
    if (!data || !Array.isArray(data["release-groups"])) throw new BaselineMusicBrainzError("MusicBrainz returned an invalid release-group search", { code: "MUSICBRAINZ_INVALID_RESPONSE", status: 502 });
    const items = data["release-groups"].map(normalizeSearchItem).filter(Boolean);
    if (data["release-groups"].length > 0 && items.length === 0) throw new BaselineMusicBrainzError("MusicBrainz returned no valid release groups", { code: "MUSICBRAINZ_INVALID_RESPONSE", status: 502 });
    return items.slice(0, boundedLimit);
  }

  async function browseReleases(groupId, optionsForPage = {}) {
    const releaseGroupMbid = normalizeMbid(groupId);
    if (!releaseGroupMbid) throw new BaselineMusicBrainzError("Invalid release-group MBID", { code: "INVALID_PROVIDER_INPUT", status: 400 });
    const offset = normalizeOffset(optionsForPage.offset);
    const limit = normalizeLimit(optionsForPage.limit, 20, MAX_BROWSE_LIMIT);
    const pathname = `release?release-group=${encodeURIComponent(releaseGroupMbid)}&inc=media+artist-credits+release-groups&fmt=json&limit=${limit}&offset=${offset}`;
    const data = await request(pathname, `baseline-mb:browse:${releaseGroupMbid}:${offset}:${limit}`, (raw) => {
      if (!Array.isArray(raw?.releases) || raw.releases.length > limit || !Number.isSafeInteger(raw["release-count"]) || raw["release-count"] < 0) throw new BaselineMusicBrainzError("Invalid release browse", { code: "MUSICBRAINZ_INVALID_RESPONSE", status: 502 });
    });
    const total = Number.isSafeInteger(data?.["release-count"]) && data["release-count"] >= 0 ? data["release-count"] : null;
    if (!data || !Array.isArray(data.releases) || total === null) throw new BaselineMusicBrainzError("MusicBrainz returned an invalid release browse", { code: "MUSICBRAINZ_INVALID_RESPONSE", status: 502 });
    const rawItems = data.releases.slice(0, limit);
    const items = rawItems.map((item) => normalizeBrowseItem(item, releaseGroupMbid)).filter(Boolean);
    const invalid = items.length !== rawItems.length || data.releases.length > limit;
    const consumed = rawItems.length;
    const hasMore = offset + consumed < total;
    const nextOffset = hasMore && consumed > 0 && offset + consumed <= MAX_BROWSE_OFFSET ? offset + consumed : null;
    return { items, total, nextOffset, invalid, incomplete: invalid || hasMore };
  }

  async function release(idOrUrl) {
    const releaseMbid = parseReleaseId(idOrUrl);
    if (!releaseMbid) throw new BaselineMusicBrainzError("Invalid MusicBrainz release ID or URL", { code: "INVALID_PROVIDER_INPUT", status: 400 });
    const data = await request(`release/${releaseMbid}?inc=media+recordings+artist-credits+release-groups&fmt=json`, `baseline-mb:release:${releaseMbid}`, (raw) => normalizeRelease(raw, releaseMbid, nowDate().toISOString()));
    return normalizeRelease(data, releaseMbid, nowDate().toISOString());
  }

  async function recommend(groupId, optionsForRecommendation = {}) {
    const releaseGroupMbid = normalizeMbid(groupId);
    if (!releaseGroupMbid) throw new BaselineMusicBrainzError("Invalid release-group MBID", { code: "INVALID_PROVIDER_INPUT", status: 400 });
    const requestedTitle = clean(optionsForRecommendation.title, 500);
    if (!requestedTitle) throw new BaselineMusicBrainzError("A release-group title is required", { code: "INVALID_PROVIDER_INPUT", status: 400 });
    const allItems = [];
    let nextOffset = 0;
    let incomplete = false;
    for (let page = 0; page < MAX_RECOMMEND_PAGES && nextOffset !== null; page += 1) {
      const result = await browseReleases(releaseGroupMbid, { offset: nextOffset, limit: 20 });
      allItems.push(...result.items);
      if (result.invalid || (result.incomplete && result.nextOffset === null)) incomplete = true;
      nextOffset = result.nextOffset;
    }
    if (nextOffset !== null) incomplete = true;
    const ranked = allItems.map((item) => ({ ...item, __requestedTitle: requestedTitle })).sort(compareRecommendation);
    const hydrated = [];
    const official = ranked.filter((item) => normalizeTitle(item.status) === "official");
    for (const item of official.slice(0, MAX_RECOMMEND_LOOKUPS)) {
      try {
        const candidate = await release(item.releaseMbid);
        if (candidate.releaseGroupMbid !== releaseGroupMbid) {
          incomplete = true;
          continue;
        }
        hydrated.push({ item, candidate });
      } catch (error) {
        incomplete = true;
        if (["MUSICBRAINZ_RATE_LIMITED", "MUSICBRAINZ_TIMEOUT", "MUSICBRAINZ_UNAVAILABLE"].includes(error.code)) break;
      }
    }
    const top = hydrated[0] || null;
    const ambiguous = Boolean(top && official.filter((item) => qualityKey(item, requestedTitle) === qualityKey(top.item, requestedTitle)).length > 1);
    if (official.length > MAX_RECOMMEND_LOOKUPS) incomplete = true;
    const rationale = top
      ? `Selected the first complete official release with the closest title and a standard edition marker profile; date and release MBID break ties.${ambiguous ? " Multiple releases remain equally suitable for moderator review." : ""}`
      : "No complete MusicBrainz release with a valid tracklist was available in the bounded browse window.";
    return {
      candidate: top?.candidate || null,
      items: ranked.map(({ __requestedTitle, ...item }) => item),
      nextOffset,
      incomplete,
      ambiguous,
      rationale,
    };
  }

  return { searchReleaseGroups, browseReleases, release, recommend };
}

module.exports = {
  BaselineMusicBrainzError,
  MUSICBRAINZ_BASE_URL,
  MAX_TRACKS,
  createBaselineMusicBrainz,
  hashCandidateTracklist,
  normalizeMbid,
  parseReleaseId,
  parseRetryAfter,
  validateNormalizedCandidate,
};
