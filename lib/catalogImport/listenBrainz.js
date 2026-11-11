const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { validateAlbumRow, validateDatasetObject } = require("./dataset");

const SCHEMA_VERSION = "1.0.0";
const LISTENBRAINZ_API_URL = "https://api.listenbrainz.org/1/stats/sitewide/release-groups";
const MUSICBRAINZ_API_URL = "https://musicbrainz.org/ws/2/release-group";
const DEFAULT_USER_AGENT = "RescenedCatalogImporter/1.0.0 (https://github.com/jkind889/rescened)";
const DEFAULT_MAX_PER_PRIMARY_ARTIST = 5;
const DEFAULT_MUSICBRAINZ_INTERVAL_MS = 1_100;
const DEFAULT_RANGE_CONFIGS = Object.freeze([
  Object.freeze({ range: "all_time", quota: 300, candidateLimit: 1_000 }),
  Object.freeze({ range: "year", quota: 150, candidateLimit: 1_000 }),
  Object.freeze({ range: "month", quota: 50, candidateLimit: 1_000 }),
]);
const ALLOWED_RANGES = new Set(["all_time", "year", "month"]);
const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const SECONDARY_TYPE_PRECEDENCE = [
  ["soundtrack", "soundtrack"],
  ["mixtape/street", "mixtape"],
  ["mixtape", "mixtape"],
  ["live", "live"],
  ["remix", "remix"],
  ["compilation", "compilation"],
];

class CatalogFetchError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "CatalogFetchError";
    this.code = options.code || "catalog_fetch_failed";
    this.status = options.status;
    this.report = options.report;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function currentIso(clock = () => new Date()) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("clock must return a valid date");
  return date.toISOString();
}

function normalizeMbid(value) {
  const mbid = String(value || "").trim().toLowerCase();
  return MBID_PATTERN.test(mbid) ? mbid : "";
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFC")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeJoinPhrase(value) {
  const original = String(value || "").normalize("NFC");
  if (!original) return "";
  const hasLeadingWhitespace = /^\s/u.test(original);
  const hasTrailingWhitespace = /\s$/u.test(original);
  const middle = original.replace(/\s+/gu, " ").trim();
  if (!middle) return " ";
  return `${hasLeadingWhitespace ? " " : ""}${middle}${hasTrailingWhitespace ? " " : ""}`;
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year, month) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function parsePartialDate(value) {
  const releaseDate = String(value || "").trim();
  let match = /^(\d{4})$/.exec(releaseDate);
  if (match) {
    const year = Number(match[1]);
    if (year >= 0 && year <= 9999) {
      return { releaseDate, releaseDatePrecision: "year", releaseYear: year };
    }
  }

  match = /^(\d{4})-(\d{2})$/.exec(releaseDate);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (year >= 0 && year <= 9999 && month >= 1 && month <= 12) {
      return { releaseDate, releaseDatePrecision: "month", releaseYear: year };
    }
  }

  match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(releaseDate);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (
      year >= 0
      && year <= 9999
      && month >= 1
      && month <= 12
      && day >= 1
      && day <= daysInMonth(year, month)
    ) {
      return { releaseDate, releaseDatePrecision: "day", releaseYear: year };
    }
  }

  return { releaseDate: "", releaseDatePrecision: "", releaseYear: null };
}

function mapReleaseType(primaryType, secondaryTypes = []) {
  const normalizedSecondaryTypes = new Set(
    (Array.isArray(secondaryTypes) ? secondaryTypes : [])
      .map((value) => normalizeText(value).toLowerCase())
      .filter(Boolean),
  );

  for (const [musicBrainzType, rescenedType] of SECONDARY_TYPE_PRECEDENCE) {
    if (normalizedSecondaryTypes.has(musicBrainzType)) return rescenedType;
  }

  const normalizedPrimaryType = normalizeText(primaryType).toLowerCase();
  if (normalizedPrimaryType === "album") return "album";
  if (normalizedPrimaryType === "ep") return "ep";
  if (normalizedPrimaryType === "single") return "single";
  return "other";
}

function mapArtistCredits(rawCredits) {
  if (!Array.isArray(rawCredits) || rawCredits.length === 0) {
    throw new CatalogFetchError("MusicBrainz release group has no artist credits", {
      code: "missing_artist_credits",
    });
  }
  if (rawCredits.length > 64) {
    throw new CatalogFetchError("MusicBrainz release group has too many artist credits", {
      code: "artist_credits_too_large",
    });
  }

  const artistCredits = rawCredits.map((rawCredit, index) => {
    const artistMbid = normalizeMbid(rawCredit?.artist?.id);
    const name = normalizeText(rawCredit?.name || rawCredit?.artist?.name);
    const joinPhrase = normalizeJoinPhrase(rawCredit?.joinphrase);
    if (!artistMbid || !name) {
      throw new CatalogFetchError(`MusicBrainz artist credit ${index + 1} is missing a valid artist identity`, {
        code: "invalid_artist_credit",
      });
    }
    if (name.length > 300) {
      throw new CatalogFetchError(`MusicBrainz artist credit ${index + 1} exceeds 300 characters`, {
        code: "artist_credit_name_too_long",
      });
    }
    if (joinPhrase.length > 32) {
      throw new CatalogFetchError(`MusicBrainz artist credit ${index + 1} join phrase exceeds 32 characters`, {
        code: "artist_join_phrase_too_long",
      });
    }
    if (rawCredit?.artist?.name !== undefined && typeof rawCredit.artist.name !== "string") {
      throw new CatalogFetchError("MusicBrainz artist name must be text", { code: "invalid_artist_name" });
    }
    const artistName = normalizeText(rawCredit?.artist?.name);
    if (artistName.length > 500) {
      throw new CatalogFetchError("MusicBrainz artist name exceeds 500 characters", { code: "artist_name_too_long" });
    }
    return { artistMbid, name, joinPhrase, ...(artistName ? { artistName } : {}) };
  });

  const artistDisplayName = artistCredits.map((credit) => `${credit.name}${credit.joinPhrase}`).join("");
  if (!artistDisplayName || artistDisplayName.length > 500) {
    throw new CatalogFetchError("MusicBrainz artist display name is empty or exceeds 500 characters", {
      code: "invalid_artist_display_name",
    });
  }

  return { artistCredits, artistDisplayName };
}

function normalizeImageId(value) {
  if (Number.isSafeInteger(value) && value >= 1) return value;
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

function buildCover(releaseMbid, imageId) {
  const normalizedReleaseMbid = normalizeMbid(releaseMbid);
  const normalizedImageId = normalizeImageId(imageId);
  if (!normalizedReleaseMbid || normalizedImageId === null) return null;
  return {
    releaseMbid: normalizedReleaseMbid,
    imageId: normalizedImageId,
    url500: `https://coverartarchive.org/release/${normalizedReleaseMbid}/front-500`,
  };
}

function epochSecondsToDate(value) {
  if (!Number.isFinite(value) || value < 0) return null;
  const date = new Date(Math.trunc(value) * 1_000);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function validateRangeConfigs(rangeConfigs) {
  if (!Array.isArray(rangeConfigs) || rangeConfigs.length === 0) {
    throw new TypeError("rangeConfigs must contain at least one range");
  }
  const seenRanges = new Set();
  return rangeConfigs.map((config) => {
    const range = String(config?.range || "");
    const quota = Number(config?.quota);
    const candidateLimit = Number(config?.candidateLimit);
    if (!ALLOWED_RANGES.has(range) || seenRanges.has(range)) {
      throw new TypeError(`Invalid or duplicate ListenBrainz range: ${range || "<empty>"}`);
    }
    if (!Number.isInteger(quota) || quota < 0 || quota > 1_000) {
      throw new TypeError(`Quota for ${range} must be an integer from 0 to 1000`);
    }
    if (!Number.isInteger(candidateLimit) || candidateLimit < quota || candidateLimit > 1_000) {
      throw new TypeError(`Candidate limit for ${range} must be between its quota and 1000`);
    }
    seenRanges.add(range);
    return { range, quota, candidateLimit };
  });
}

function parseRetryAfter(value, nowMilliseconds = Date.now()) {
  if (value === null || value === undefined || value === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }
  const timestamp = Date.parse(String(value));
  if (Number.isNaN(timestamp)) return null;
  return Math.max(timestamp - nowMilliseconds, 0);
}

async function requestJson(url, options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  if (typeof fetchFn !== "function") throw new TypeError("A fetch implementation is required");
  const timeoutMs = options.timeoutMs ?? 15_000;
  const retries = options.retries ?? 3;
  const retryBaseMs = options.retryBaseMs ?? 500;
  const maximumRetryDelayMs = options.maximumRetryDelayMs ?? 30_000;
  const sleepFn = options.sleepFn || delay;
  const nowMs = options.nowMs || Date.now;
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (options.beforeAttempt) await options.beforeAttempt({ attempt, url });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          ...(options.headers || {}),
        },
        signal: controller.signal,
      });
      if (response.status === 204) return { data: null, response, attempts: attempt + 1 };
      if (!response.ok) {
        const error = new CatalogFetchError(`Request failed with HTTP ${response.status}: ${url}`, {
          code: "http_error",
          status: response.status,
        });
        const retryable = RETRYABLE_STATUS_CODES.has(response.status);
        if (!retryable || attempt === retries) throw error;
        lastError = error;
        const retryAfter = parseRetryAfter(
          response.headers?.get?.("retry-after"),
          nowMs(),
        );
        const backoff = Math.min(retryBaseMs * (2 ** attempt), maximumRetryDelayMs);
        await sleepFn(retryAfter ?? backoff);
        continue;
      }

      let data;
      try {
        data = await response.json();
      } catch (cause) {
        throw new CatalogFetchError(`Response was not valid JSON: ${url}`, {
          cause,
          code: "invalid_json_response",
        });
      }
      return { data, response, attempts: attempt + 1 };
    } catch (error) {
      const normalizedError = error instanceof CatalogFetchError
        ? error
        : new CatalogFetchError(
          controller.signal.aborted ? `Request timed out after ${timeoutMs}ms: ${url}` : `Request failed: ${url}`,
          { cause: error, code: controller.signal.aborted ? "request_timeout" : "network_error" },
        );
      if (normalizedError.status && !RETRYABLE_STATUS_CODES.has(normalizedError.status)) throw normalizedError;
      if (attempt === retries) throw normalizedError;
      lastError = normalizedError;
      await sleepFn(Math.min(retryBaseMs * (2 ** attempt), maximumRetryDelayMs));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new CatalogFetchError(`Request failed: ${url}`);
}

function createRateGate(options = {}) {
  const intervalMs = options.intervalMs ?? DEFAULT_MUSICBRAINZ_INTERVAL_MS;
  const nowMs = options.nowMs || Date.now;
  const sleepFn = options.sleepFn || delay;
  let lastStartedAt = null;
  let queue = Promise.resolve();

  return function waitForRateSlot() {
    const turn = queue.then(async () => {
      if (lastStartedAt !== null) {
        const waitMs = intervalMs - (nowMs() - lastStartedAt);
        if (waitMs > 0) await sleepFn(waitMs);
      }
      lastStartedAt = nowMs();
    });
    queue = turn.catch(() => {});
    return turn;
  };
}

async function stageFile(filePath, contents, fileSystem = fs) {
  const directory = path.dirname(filePath);
  await fileSystem.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  await fileSystem.writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
  return temporaryPath;
}

async function atomicWriteFile(filePath, contents) {
  const temporaryPath = await stageFile(filePath, contents);
  try {
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function isMusicBrainzResponse(data, expectedMbid) {
  return Boolean(
    data
    && typeof data === "object"
    && normalizeMbid(data.id) === expectedMbid
    && normalizeText(data.title)
    && Array.isArray(data["artist-credit"]),
  );
}

function isContractIsoTimestamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/.exec(String(value));
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

function createMusicBrainzClient(options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  const userAgent = normalizeText(options.userAgent || DEFAULT_USER_AGENT);
  if (!userAgent || !/[(/@]/.test(userAgent)) {
    throw new TypeError("MusicBrainz user agent must identify the application and provide contact information");
  }
  const cacheDir = options.cacheDir ? path.resolve(options.cacheDir) : null;
  const clock = options.clock || (() => new Date());
  const rateGate = createRateGate({
    intervalMs: options.intervalMs,
    nowMs: options.nowMs,
    sleepFn: options.sleepFn,
  });
  const stats = { cacheHits: 0, cacheMisses: 0, networkRequests: 0 };

  async function readCache(releaseGroupMbid) {
    if (!cacheDir) return null;
    const cachePath = path.join(cacheDir, `${releaseGroupMbid}.json`);
    try {
      const cached = JSON.parse(await fs.readFile(cachePath, "utf8"));
      if (
        isContractIsoTimestamp(cached?.fetchedAt)
        && isMusicBrainzResponse(cached.data, releaseGroupMbid)
      ) {
        return cached;
      }
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    return null;
  }

  async function hydrateReleaseGroup(releaseGroupMbid) {
    const mbid = normalizeMbid(releaseGroupMbid);
    if (!mbid) {
      throw new CatalogFetchError("Cannot hydrate an invalid release-group MBID", {
        code: "invalid_release_group_mbid",
      });
    }

    const cached = await readCache(mbid);
    if (cached) {
      stats.cacheHits += 1;
      return { data: cached.data, fetchedAt: cached.fetchedAt, cacheHit: true };
    }
    stats.cacheMisses += 1;

    const url = new URL(`${MUSICBRAINZ_API_URL}/${mbid}`);
    url.searchParams.set("inc", "artist-credits");
    url.searchParams.set("fmt", "json");
    const result = await requestJson(url.toString(), {
      fetchFn,
      headers: { "User-Agent": userAgent },
      timeoutMs: options.timeoutMs,
      retries: options.retries,
      retryBaseMs: options.retryBaseMs,
      maximumRetryDelayMs: options.maximumRetryDelayMs,
      sleepFn: options.sleepFn,
      nowMs: options.nowMs,
      beforeAttempt: async () => {
        await rateGate();
        stats.networkRequests += 1;
      },
    });
    if (!isMusicBrainzResponse(result.data, mbid)) {
      throw new CatalogFetchError(`MusicBrainz returned invalid data for ${mbid}`, {
        code: "invalid_musicbrainz_release_group",
      });
    }

    const cacheEntry = { fetchedAt: currentIso(clock), data: result.data };
    if (cacheDir) {
      await atomicWriteFile(
        path.join(cacheDir, `${mbid}.json`),
        `${JSON.stringify(cacheEntry, null, 2)}\n`,
      );
    }
    return { data: cacheEntry.data, fetchedAt: cacheEntry.fetchedAt, cacheHit: false };
  }

  return { hydrateReleaseGroup, stats };
}

async function fetchListenBrainzRange(config, options = {}) {
  const [normalizedConfig] = validateRangeConfigs([config]);
  const userAgent = normalizeText(options.userAgent || DEFAULT_USER_AGENT);
  const url = new URL(options.baseUrl || LISTENBRAINZ_API_URL);
  url.searchParams.set("range", normalizedConfig.range);
  url.searchParams.set("count", String(normalizedConfig.candidateLimit));
  url.searchParams.set("offset", "0");
  const result = await requestJson(url.toString(), {
    fetchFn: options.fetchFn,
    headers: { "User-Agent": userAgent },
    timeoutMs: options.timeoutMs,
    retries: options.retries,
    retryBaseMs: options.retryBaseMs,
    maximumRetryDelayMs: options.maximumRetryDelayMs,
    sleepFn: options.sleepFn,
    nowMs: options.nowMs,
  });
  const fetchedAt = currentIso(options.clock);
  const payload = result.data?.payload;
  if (!payload || !Array.isArray(payload.release_groups)) {
    throw new CatalogFetchError(`ListenBrainz returned no release-group ranking for ${normalizedConfig.range}`, {
      code: "invalid_listenbrainz_ranking",
    });
  }
  if (payload.range && payload.range !== normalizedConfig.range) {
    throw new CatalogFetchError(
      `ListenBrainz returned range ${payload.range} for requested range ${normalizedConfig.range}`,
      { code: "listenbrainz_range_mismatch" },
    );
  }
  return { config: normalizedConfig, payload, fetchedAt, url: url.toString() };
}

function collectCandidates(rangeResults) {
  const candidates = new Map();
  const rangeOrders = new Map();
  const rangeSummaries = [];
  const invalidRows = [];
  let totalRows = 0;
  let validRows = 0;

  for (const rangeResult of rangeResults) {
    const { config, payload, fetchedAt } = rangeResult;
    const releaseGroups = payload.release_groups.slice(0, config.candidateLimit);
    totalRows += releaseGroups.length;
    const order = [];
    const seenInRange = new Set();

    releaseGroups.forEach((entry, index) => {
      const rank = index + 1;
      const releaseGroupMbid = normalizeMbid(entry?.release_group_mbid);
      if (!releaseGroupMbid) {
        invalidRows.push({
          range: config.range,
          rank,
          code: "invalid_release_group_mbid",
          message: "ListenBrainz candidate has no valid MusicBrainz release-group MBID",
        });
        return;
      }
      if (!Number.isSafeInteger(entry?.listen_count) || entry.listen_count < 0) {
        invalidRows.push({
          range: config.range,
          rank,
          releaseGroupMbid,
          code: "invalid_listen_count",
          message: "ListenBrainz candidate listen_count must be a non-negative integer",
        });
        return;
      }
      validRows += 1;
      if (!seenInRange.has(releaseGroupMbid)) {
        order.push(releaseGroupMbid);
        seenInRange.add(releaseGroupMbid);
      }

      let candidate = candidates.get(releaseGroupMbid);
      if (!candidate) {
        candidate = {
          releaseGroupMbid,
          selectionSignals: [],
          listenBrainzFetchedAt: fetchedAt,
          representativeReleaseMbids: [],
          coverCandidates: [],
        };
        candidates.set(releaseGroupMbid, candidate);
      }
      candidate.selectionSignals.push({
        range: config.range,
        rank,
        listenCount: entry.listen_count,
      });
      if (fetchedAt > candidate.listenBrainzFetchedAt) candidate.listenBrainzFetchedAt = fetchedAt;

      const representativeReleaseMbid = normalizeMbid(entry?.caa_release_mbid);
      if (representativeReleaseMbid && !candidate.representativeReleaseMbids.includes(representativeReleaseMbid)) {
        candidate.representativeReleaseMbids.push(representativeReleaseMbid);
      }
      const cover = buildCover(representativeReleaseMbid, entry?.caa_id);
      if (cover && !candidate.coverCandidates.some((existing) => (
        existing.releaseMbid === cover.releaseMbid && existing.imageId === cover.imageId
      ))) {
        candidate.coverCandidates.push(cover);
      }
    });

    rangeOrders.set(config.range, order);
    rangeSummaries.push({
      range: config.range,
      quota: config.quota,
      candidateLimit: config.candidateLimit,
      from: epochSecondsToDate(payload.from_ts),
      to: epochSecondsToDate(payload.to_ts),
      fetchedAt,
      candidatesFetched: releaseGroups.length,
      uniqueValidCandidates: order.length,
    });
  }

  return {
    candidates,
    rangeOrders,
    rangeSummaries,
    invalidRows,
    stats: {
      rowsFetched: totalRows,
      validRows,
      uniqueCandidates: candidates.size,
      duplicateRows: Math.max(validRows - candidates.size, 0),
      invalidRows: invalidRows.length,
    },
  };
}

function mapMusicBrainzReleaseGroup(musicBrainzData, candidate, selectedRange, musicBrainzFetchedAt) {
  const releaseGroupMbid = normalizeMbid(musicBrainzData?.id);
  if (!releaseGroupMbid || releaseGroupMbid !== candidate.releaseGroupMbid) {
    throw new CatalogFetchError("MusicBrainz release-group identity did not match the ListenBrainz candidate", {
      code: "musicbrainz_identity_mismatch",
    });
  }
  const title = normalizeText(musicBrainzData.title);
  if (!title || title.length > 500) {
    throw new CatalogFetchError("MusicBrainz release-group title is empty or exceeds 500 characters", {
      code: "invalid_release_group_title",
    });
  }
  const { artistCredits, artistDisplayName } = mapArtistCredits(musicBrainzData["artist-credit"]);
  const releaseDateFields = parsePartialDate(musicBrainzData["first-release-date"]);
  const cover = candidate.coverCandidates[0] || null;
  const representativeReleaseMbid = cover?.releaseMbid
    || candidate.representativeReleaseMbids[0]
    || null;
  const rangeOrder = new Map(DEFAULT_RANGE_CONFIGS.map((config, index) => [config.range, index]));
  const selectionSignals = candidate.selectionSignals
    .map((signal) => ({ ...signal }))
    .sort((left, right) => (
      (rangeOrder.get(left.range) ?? 99) - (rangeOrder.get(right.range) ?? 99)
      || left.rank - right.rank
    ));
  if (!selectionSignals.some((signal) => signal.range === selectedRange)) {
    throw new CatalogFetchError("Selected range is not represented in the ListenBrainz signals", {
      code: "selected_range_signal_missing",
    });
  }

  return {
    releaseGroupMbid,
    representativeReleaseMbid,
    selectedRange,
    selectionSignals,
    title,
    artistDisplayName,
    artistCredits,
    releaseType: mapReleaseType(
      musicBrainzData["primary-type"],
      musicBrainzData["secondary-types"],
    ),
    ...releaseDateFields,
    cover,
    sourceFetchedAt: {
      listenbrainz: candidate.listenBrainzFetchedAt,
      musicbrainz: musicBrainzFetchedAt,
    },
  };
}

async function selectCatalogAlbums(input) {
  const rangeConfigs = validateRangeConfigs(input.rangeConfigs || DEFAULT_RANGE_CONFIGS);
  const maxPerPrimaryArtist = input.maxPerPrimaryArtist ?? DEFAULT_MAX_PER_PRIMARY_ARTIST;
  if (!Number.isInteger(maxPerPrimaryArtist) || maxPerPrimaryArtist < 1 || maxPerPrimaryArtist > 100) {
    throw new TypeError("maxPerPrimaryArtist must be an integer from 1 to 100");
  }
  if (typeof input.hydrateReleaseGroup !== "function") {
    throw new TypeError("hydrateReleaseGroup must be a function");
  }

  const selectedAlbums = [];
  const selectedMbids = new Set();
  const terminalMbids = new Set();
  const primaryArtistCounts = new Map();
  const rejections = [...(input.collected.invalidRows || [])];
  const selectedByRange = Object.fromEntries(rangeConfigs.map((config) => [config.range, 0]));
  let hydratedCandidates = 0;

  for (const config of rangeConfigs) {
    const order = input.collected.rangeOrders.get(config.range) || [];
    for (const releaseGroupMbid of order) {
      if (selectedByRange[config.range] >= config.quota) break;
      if (selectedMbids.has(releaseGroupMbid) || terminalMbids.has(releaseGroupMbid)) continue;
      const candidate = input.collected.candidates.get(releaseGroupMbid);
      if (!candidate) continue;

      let album;
      try {
        const hydrated = await input.hydrateReleaseGroup(releaseGroupMbid);
        hydratedCandidates += 1;
        const musicBrainzData = hydrated?.data || hydrated;
        const musicBrainzFetchedAt = hydrated?.fetchedAt || currentIso(input.clock);
        album = mapMusicBrainzReleaseGroup(
          musicBrainzData,
          candidate,
          config.range,
          musicBrainzFetchedAt,
        );
        const mappedValidation = validateAlbumRow(album, selectedAlbums.length);
        if (!mappedValidation.valid) {
          const firstIssue = mappedValidation.errors[0];
          throw new CatalogFetchError(
            `Mapped album failed strict validation at ${firstIssue?.pointer || "/"}: ${firstIssue?.message || "invalid album row"}`,
            { code: "invalid_mapped_album" },
          );
        }
      } catch (error) {
        terminalMbids.add(releaseGroupMbid);
        rejections.push({
          range: config.range,
          releaseGroupMbid,
          code: error.code || "musicbrainz_hydration_failed",
          message: error.message,
        });
        if (input.onProgress) input.onProgress({ type: "rejected", range: config.range, releaseGroupMbid });
        continue;
      }

      const primaryArtistKey = album.artistCredits[0].artistMbid;
      const artistCount = primaryArtistCounts.get(primaryArtistKey) || 0;
      if (artistCount >= maxPerPrimaryArtist) {
        terminalMbids.add(releaseGroupMbid);
        rejections.push({
          range: config.range,
          releaseGroupMbid,
          code: "primary_artist_cap",
          message: `Primary artist ${album.artistCredits[0].name} already has ${maxPerPrimaryArtist} selected releases`,
        });
        if (input.onProgress) input.onProgress({ type: "artist_cap", range: config.range, releaseGroupMbid });
        continue;
      }

      selectedAlbums.push(album);
      selectedMbids.add(releaseGroupMbid);
      primaryArtistCounts.set(primaryArtistKey, artistCount + 1);
      selectedByRange[config.range] += 1;
      if (input.onProgress) {
        input.onProgress({
          type: "selected",
          range: config.range,
          selectedInRange: selectedByRange[config.range],
          quota: config.quota,
          releaseGroupMbid,
        });
      }
    }
  }

  return {
    albums: selectedAlbums,
    selectedByRange,
    rejections,
    hydratedCandidates,
    primaryArtistCounts,
  };
}

function sourceLicenses() {
  return {
    listenbrainz: {
      license: "CC0-1.0",
      url: "https://listenbrainz.org/data/",
    },
    musicbrainz: {
      license: "CC0-1.0",
      url: "https://musicbrainz.org/doc/About/Data_License",
    },
    coverArtArchive: {
      license: "varies-by-image",
      url: "https://musicbrainz.org/doc/Cover_Art_Archive",
      notice: "Cover artwork may be copyrighted; verify each image's rights before reuse.",
    },
  };
}

function makeReportSkeleton(rangeConfigs, generatedAt) {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    status: "running",
    targetAlbumCount: rangeConfigs.reduce((total, config) => total + config.quota, 0),
    selectedAlbumCount: 0,
    ranges: rangeConfigs.map((config) => ({ ...config, candidatesFetched: 0, selected: 0 })),
    candidates: {
      rowsFetched: 0,
      validRows: 0,
      uniqueCandidates: 0,
      duplicateRows: 0,
      invalidRows: 0,
      hydrated: 0,
      cacheHits: 0,
      cacheMisses: 0,
      networkRequests: 0,
    },
    rejections: [],
  };
}

async function fetchCatalogDataset(options = {}) {
  const rangeConfigs = validateRangeConfigs(options.rangeConfigs || DEFAULT_RANGE_CONFIGS);
  const maxPerPrimaryArtist = options.maxPerPrimaryArtist ?? DEFAULT_MAX_PER_PRIMARY_ARTIST;
  const report = makeReportSkeleton(rangeConfigs, currentIso(options.clock));
  let musicBrainzClient;

  try {
    const rangeResults = [];
    for (const config of rangeConfigs) {
      rangeResults.push(await fetchListenBrainzRange(config, {
        fetchFn: options.listenBrainzFetchFn || options.fetchFn,
        baseUrl: options.listenBrainzBaseUrl,
        userAgent: options.userAgent,
        timeoutMs: options.timeoutMs,
        retries: options.retries,
        retryBaseMs: options.retryBaseMs,
        maximumRetryDelayMs: options.maximumRetryDelayMs,
        sleepFn: options.sleepFn,
        nowMs: options.nowMs,
        clock: options.clock,
      }));
    }

    const collected = collectCandidates(rangeResults);
    musicBrainzClient = options.hydrateReleaseGroup
      ? { hydrateReleaseGroup: options.hydrateReleaseGroup, stats: options.musicBrainzStats || {} }
      : createMusicBrainzClient({
        fetchFn: options.musicBrainzFetchFn || options.fetchFn,
        userAgent: options.userAgent,
        cacheDir: options.cacheDir,
        timeoutMs: options.timeoutMs,
        retries: options.retries,
        retryBaseMs: options.retryBaseMs,
        maximumRetryDelayMs: options.maximumRetryDelayMs,
        intervalMs: options.musicBrainzIntervalMs,
        sleepFn: options.sleepFn,
        nowMs: options.nowMs,
        clock: options.clock,
      });
    const selected = await selectCatalogAlbums({
      collected,
      rangeConfigs,
      maxPerPrimaryArtist,
      hydrateReleaseGroup: musicBrainzClient.hydrateReleaseGroup,
      clock: options.clock,
      onProgress: options.onProgress,
    });

    const targetAlbumCount = rangeConfigs.reduce((total, config) => total + config.quota, 0);
    report.selectedAlbumCount = selected.albums.length;
    report.ranges = collected.rangeSummaries.map((summary) => ({
      ...summary,
      selected: selected.selectedByRange[summary.range] || 0,
    }));
    report.candidates = {
      ...report.candidates,
      ...collected.stats,
      hydrated: selected.hydratedCandidates,
      cacheHits: musicBrainzClient.stats.cacheHits || 0,
      cacheMisses: musicBrainzClient.stats.cacheMisses || 0,
      networkRequests: musicBrainzClient.stats.networkRequests || 0,
    };
    report.rejections = selected.rejections;

    const shortages = rangeConfigs
      .filter((config) => selected.selectedByRange[config.range] !== config.quota)
      .map((config) => `${config.range}: ${selected.selectedByRange[config.range]}/${config.quota}`);
    if (selected.albums.length !== targetAlbumCount || shortages.length > 0) {
      report.status = "incomplete";
      throw new CatalogFetchError(`Could not fill catalog quotas (${shortages.join(", ")})`, {
        code: "catalog_quota_unfilled",
        report,
      });
    }

    const datasetId = options.datasetId || crypto.randomUUID();
    if (!normalizeMbid(datasetId)) {
      throw new CatalogFetchError("datasetId must be a UUID", { code: "invalid_dataset_id", report });
    }
    // `generatedAt` describes the completed artifact, after every upstream
    // observation captured in its rows, rather than the start of a long run.
    const generatedAt = currentIso(options.clock);
    report.generatedAt = generatedAt;
    const dataset = {
      schemaVersion: SCHEMA_VERSION,
      datasetId: datasetId.toLowerCase(),
      generatedAt,
      selection: {
        targetAlbumCount,
        maxPerPrimaryArtist,
        ranges: collected.rangeSummaries.map((summary) => ({
          range: summary.range,
          quota: summary.quota,
          candidateLimit: summary.candidateLimit,
          from: summary.from,
          to: summary.to,
          fetchedAt: summary.fetchedAt,
        })),
      },
      sourceLicenses: sourceLicenses(),
      albums: selected.albums,
    };
    const validation = validateDatasetObject(dataset);
    if (validation.quarantined.length > 0 || validation.validAlbums.length !== dataset.albums.length) {
      throw new CatalogFetchError("Generated catalog dataset failed strict row validation", {
        code: "generated_dataset_invalid",
        report,
      });
    }
    report.datasetId = dataset.datasetId;
    report.status = "complete";
    return { dataset, report };
  } catch (error) {
    if (report.status === "running") report.status = "failed";
    if (!report.fatalError) {
      report.fatalError = { code: error.code || "catalog_fetch_failed", message: error.message };
    }
    if (error instanceof CatalogFetchError) {
      error.report = error.report || report;
      throw error;
    }
    throw new CatalogFetchError(error.message || "Catalog fetch failed", {
      cause: error,
      code: "catalog_fetch_failed",
      report,
    });
  }
}

function artifactPathsFor(outputPath) {
  const resolvedOutputPath = path.resolve(outputPath);
  return {
    outputPath: resolvedOutputPath,
    checksumPath: `${resolvedOutputPath}.sha256`,
    reportPath: `${resolvedOutputPath}.fetch-report.json`,
  };
}

async function inspectArtifactDestination(destination, fileSystem) {
  try {
    const stat = await fileSystem.lstat(destination);
    if (!stat.isFile()) {
      throw new CatalogFetchError(`Artifact destination is not a regular file: ${destination}`, {
        code: "artifact_destination_not_file",
      });
    }
    return { existed: true };
  } catch (error) {
    if (error.code === "ENOENT") return { existed: false };
    throw error;
  }
}

function siblingArtifactPath(destination, suffix) {
  return path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${crypto.randomUUID()}.${suffix}`,
  );
}

async function writeCatalogArtifacts(outputPath, dataset, report, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const paths = artifactPathsFor(outputPath);
  const datasetContents = `${JSON.stringify(dataset, null, 2)}\n`;
  const reportContents = `${JSON.stringify(report, null, 2)}\n`;
  const checksum = crypto.createHash("sha256").update(datasetContents).digest("hex");
  const checksumContents = `${checksum}  ${path.basename(paths.outputPath)}\n`;
  // Sidecars publish first; the dataset is the commit marker and must publish last.
  const destinations = [
    { destination: paths.reportPath, contents: reportContents },
    { destination: paths.checksumPath, contents: checksumContents },
    { destination: paths.outputPath, contents: datasetContents },
  ];
  const staged = [];
  const backups = new Map();
  const published = [];
  try {
    for (const entry of destinations) {
      entry.preflight = await inspectArtifactDestination(entry.destination, fileSystem);
    }
    for (const entry of destinations) {
      entry.temporaryPath = await stageFile(entry.destination, entry.contents, fileSystem);
      staged.push(entry.temporaryPath);
    }
    for (const entry of destinations) {
      if (!entry.preflight.existed) continue;
      const backupPath = siblingArtifactPath(entry.destination, "bak");
      await fileSystem.copyFile(entry.destination, backupPath);
      backups.set(entry.destination, backupPath);
    }
    for (const entry of destinations) {
      await fileSystem.rename(entry.temporaryPath, entry.destination);
      published.push(entry.destination);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const destination of [...published].reverse()) {
      try {
        const backupPath = backups.get(destination);
        if (backupPath) {
          await fileSystem.rename(backupPath, destination);
          backups.delete(destination);
        } else {
          await fileSystem.unlink(destination);
        }
      } catch (rollbackError) {
        rollbackErrors.push(`${destination}: ${rollbackError.message}`);
      }
    }
    await Promise.all(staged.map((temporaryPath) => fileSystem.unlink(temporaryPath).catch(() => {})));
    await Promise.all([...backups.values()].map((backupPath) => fileSystem.unlink(backupPath).catch(() => {})));
    if (rollbackErrors.length > 0) error.rollbackErrors = rollbackErrors;
    throw error;
  }
  await Promise.all([...backups.values()].map((backupPath) => fileSystem.unlink(backupPath).catch(() => {})));
  return { ...paths, checksum };
}

async function runCatalogFetch(options = {}) {
  if (!options.outputPath) throw new TypeError("outputPath is required");
  try {
    const { dataset, report } = await fetchCatalogDataset(options);
    const artifacts = await writeCatalogArtifacts(options.outputPath, dataset, report);
    return { dataset, report, artifacts };
  } catch (error) {
    if (error.report) {
      const { reportPath } = artifactPathsFor(options.outputPath);
      await atomicWriteFile(reportPath, `${JSON.stringify(error.report, null, 2)}\n`);
    }
    throw error;
  }
}

module.exports = {
  ALLOWED_RANGES,
  CatalogFetchError,
  DEFAULT_MAX_PER_PRIMARY_ARTIST,
  DEFAULT_MUSICBRAINZ_INTERVAL_MS,
  DEFAULT_RANGE_CONFIGS,
  DEFAULT_USER_AGENT,
  LISTENBRAINZ_API_URL,
  MBID_PATTERN,
  MUSICBRAINZ_API_URL,
  SCHEMA_VERSION,
  artifactPathsFor,
  atomicWriteFile,
  buildCover,
  collectCandidates,
  createMusicBrainzClient,
  createRateGate,
  epochSecondsToDate,
  fetchCatalogDataset,
  fetchListenBrainzRange,
  mapArtistCredits,
  mapMusicBrainzReleaseGroup,
  mapReleaseType,
  normalizeJoinPhrase,
  normalizeMbid,
  normalizeText,
  parsePartialDate,
  parseRetryAfter,
  requestJson,
  runCatalogFetch,
  selectCatalogAlbums,
  sourceLicenses,
  validateRangeConfigs,
  writeCatalogArtifacts,
};
