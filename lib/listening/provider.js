const crypto = require("node:crypto");
const { ProviderBudget, ProviderCache } = require("../../models/Listening");

const LASTFM_API_URL = "https://ws.audioscrobbler.com/2.0/";
const LASTFM_AUTH_URL = "https://www.last.fm/api/auth/";
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_RESPONSE_BYTES = 1_000_000;

class LastfmProviderError extends Error {
  constructor(code, status = 502, options = {}) {
    super(code, options.cause ? { cause: options.cause } : undefined);
    this.name = "LastfmProviderError";
    this.code = code;
    this.status = status;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.retryable = options.retryable === true;
  }
}

function clean(value, max = 500) {
  const normalized = String(value || "").normalize("NFC").replace(/\s+/gu, " ").trim();
  return normalized.length <= max ? normalized : "";
}

function mbid(value) {
  const normalized = clean(value, 64).toLowerCase();
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(normalized) ? normalized : "";
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function retryAfter(value, now = Date.now()) {
  if (value === null || value === undefined || value === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const timestamp = Date.parse(String(value));
  return Number.isNaN(timestamp) ? null : Math.max(0, timestamp - now);
}

function envConfig(env) {
  const apiKey = clean(env.LASTFM_API_KEY || env.LAST_FM_API, 256);
  const apiSecret = clean(env.LASTFM_API_SECRET || env.LAST_FM_SECRET, 256);
  return {
    apiKey,
    apiSecret,
    userAgent: clean(env.LASTFM_USER_AGENT, 500) || "Rescened/1.0 (Last.fm listening pilot)",
    timeoutMs: boundedInt(env.LASTFM_TIMEOUT_MS, 8_000, 500, 30_000),
    retries: boundedInt(env.LASTFM_RETRIES, 2, 0, 3),
    budgetLimit: boundedInt(env.LASTFM_REQUESTS_PER_MINUTE, 45, 1, 1_000),
  };
}

async function acquireMongoBudget({ limit, now }) {
  const current = now();
  try {
    await ProviderBudget.updateOne(
      { key: "lastfm" },
      { $setOnInsert: { key: "lastfm", windowStartedAt: current, used: 0, cooldownUntil: null } },
      { upsert: true },
    );
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }
  const cutoff = new Date(current.getTime() - 60_000);
  const result = await ProviderBudget.findOneAndUpdate(
    { key: "lastfm", $or: [{ cooldownUntil: null }, { cooldownUntil: { $exists: false } }, { cooldownUntil: { $lte: current } }] },
    [{ $set: {
      key: "lastfm",
      windowStartedAt: { $cond: [{ $lt: [{ $ifNull: ["$windowStartedAt", new Date(0)] }, cutoff] }, current, "$windowStartedAt"] },
      used: { $cond: [{ $lt: [{ $ifNull: ["$windowStartedAt", new Date(0)] }, cutoff] }, 1, { $add: [{ $ifNull: ["$used", 0] }, 1] }] },
    } }],
    { returnDocument: "after", updatePipeline: true },
  ).lean();
  if (!result) {
    const blocked = await ProviderBudget.findOne({ key: "lastfm" }).select("cooldownUntil").lean();
    const retryAfterMs = blocked?.cooldownUntil ? Math.max(0, blocked.cooldownUntil.getTime() - current.getTime()) : 1_000;
    throw new LastfmProviderError("lastfm_rate_limited", 503, { retryAfterMs });
  }
  if (result.used > limit) {
    const retryAfterMs = Math.max(1_000, result.windowStartedAt.getTime() + 60_000 - current.getTime());
    throw new LastfmProviderError("lastfm_request_budget_exhausted", 503, { retryAfterMs });
  }
}

async function deferMongoBudget({ delayMs, now }) {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;
  const cooldownUntil = new Date(now().getTime() + Math.min(delayMs, 24 * 60 * 60 * 1_000));
  await ProviderBudget.updateOne(
    { key: "lastfm" },
    {
      $max: { cooldownUntil },
      $setOnInsert: { key: "lastfm", windowStartedAt: now(), used: 0 },
    },
    { upsert: true },
  );
}

function signature(params, secret) {
  const source = Object.keys(params).sort().map((key) => `${key}${params[key]}`).join("") + secret;
  return crypto.createHash("md5").update(source, "utf8").digest("hex");
}

function cacheKey(method, params) {
  return `lastfm:${crypto.createHash("sha256").update(JSON.stringify([method, Object.entries(params).sort()])).digest("hex")}`;
}

function lastfmSourceUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:"
      && (url.hostname === "www.last.fm" || url.hostname === "last.fm")
      && !url.username && !url.password && !url.search && !url.hash
      ? url.toString() : "";
  } catch { return ""; }
}

function strictInteger(value, { min, max }) {
  if (!/^(?:0|[1-9]\d*)$/u.test(String(value ?? ""))) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

async function readBoundedBody(response) {
  if (!response?.body?.getReader) {
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) throw new LastfmProviderError("lastfm_response_too_large", 502);
    return body;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new LastfmProviderError("lastfm_response_too_large", 502);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

function createLastfmProvider(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");
  const config = envConfig(options.env || process.env);
  const now = options.now || (() => new Date());
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const budget = options.budget || {
    acquire: () => acquireMongoBudget({ limit: config.budgetLimit, now }),
    defer: (delayMs) => deferMongoBudget({ delayMs, now }),
  };
  const cache = options.cache === false ? null : (options.cache || {
    async get(key) { return (await ProviderCache.findOne({ key, expiresAt: { $gt: now() } }).lean())?.value ?? null; },
    async set(key, value, ttlMs) {
      await ProviderCache.updateOne({ key }, { $set: { value, expiresAt: new Date(now().getTime() + ttlMs) }, $setOnInsert: { key } }, { upsert: true });
    },
  });

  function requireConfig(secret = false) {
    if (!config.apiKey || (secret && !config.apiSecret)) throw new LastfmProviderError("lastfm_not_configured", 503);
  }

  async function request(method, params, requestOptions = {}) {
    requireConfig(Boolean(requestOptions.signed));
    const all = { method, api_key: config.apiKey, ...params };
    if (requestOptions.signed) all.api_sig = signature(all, config.apiSecret);
    all.format = "json";
    let lastError;
    const retries = requestOptions.noRetry ? 0 : config.retries;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        await budget.acquire();
        const url = new URL(LASTFM_API_URL);
        for (const [name, value] of Object.entries(all)) url.searchParams.set(name, String(value));
        const response = await fetchImpl(url, { headers: { Accept: "application/json", "User-Agent": config.userAgent }, signal: controller.signal });
        const contentLength = strictInteger(response.headers?.get?.("content-length"), { min: 0, max: Number.MAX_SAFE_INTEGER });
        if (contentLength !== null && contentLength > MAX_RESPONSE_BYTES) throw new LastfmProviderError("lastfm_response_too_large", 502);
        const retryDelay = retryAfter(response.headers?.get?.("retry-after"));
        const delay = retryDelay === null ? null : Math.min(retryDelay, 30_000);
        if (!response.ok) {
          const transient = RETRYABLE.has(response.status);
          if (transient && retryDelay !== null && typeof budget.defer === "function") {
            await budget.defer(retryDelay);
          }
          const error = new LastfmProviderError(transient ? "lastfm_temporarily_unavailable" : "lastfm_request_rejected", response.status === 429 ? 503 : 502, { retryAfterMs: delay, retryable: transient });
          if (retryDelay !== null && retryDelay > 30_000) throw new LastfmProviderError("lastfm_rate_limited", 503, { retryAfterMs: retryDelay });
          if (!RETRYABLE.has(response.status) || attempt === retries) throw error;
          lastError = error;
          await sleep(delay ?? Math.min(500 * (2 ** attempt), 4_000));
          continue;
        }
        let data;
        try {
          const body = await readBoundedBody(response);
          data = JSON.parse(body);
        } catch (error) {
          if (error instanceof LastfmProviderError) throw error;
          throw new LastfmProviderError("lastfm_malformed_response", 502, { cause: error });
        }
        if (!data || typeof data !== "object" || data.error) {
          const providerCode = Number(data?.error);
          const transient = new Set([11, 16, 29]).has(providerCode);
          const error = new LastfmProviderError(transient ? "lastfm_temporarily_unavailable" : "lastfm_request_rejected", transient ? 503 : 502, { retryable: transient });
          if (!transient || attempt === retries) throw error;
          lastError = error;
          await sleep(Math.min(500 * (2 ** attempt), 4_000));
          continue;
        }
        return data;
      } catch (error) {
        if (error instanceof LastfmProviderError) {
          if (!error.retryable || attempt === retries) throw error;
          lastError = error;
        } else {
          lastError = new LastfmProviderError(error?.name === "AbortError" ? "lastfm_timeout" : "lastfm_unavailable", 503, { cause: error, retryable: true });
          if (attempt === retries) throw lastError;
        }
        await sleep(Math.min(500 * (2 ** attempt), 4_000));
      } finally { clearTimeout(timeout); }
    }
    throw lastError || new LastfmProviderError("lastfm_unavailable", 503);
  }

  return {
    authorizationUrl({ state, callbackUrl }) {
      requireConfig(false);
      const normalizedState = clean(state, 500);
      if (!normalizedState) throw new TypeError("state is required");
      let callback;
      try { callback = new URL(callbackUrl); } catch { throw new TypeError("callbackUrl must be an absolute URL"); }
      callback.searchParams.set("state", normalizedState);
      const url = new URL(LASTFM_AUTH_URL);
      url.searchParams.set("api_key", config.apiKey);
      url.searchParams.set("cb", callback.toString());
      return url.toString();
    },
    async getSession(token) {
      const normalized = clean(token, 500);
      if (!normalized) throw new LastfmProviderError("invalid_lastfm_token", 400);
      const data = await request("auth.getSession", { token: normalized }, { signed: true, noRetry: true });
      const username = clean(data?.session?.name, 200);
      if (!username) throw new LastfmProviderError("lastfm_malformed_response", 502);
      return { username };
    },
    async recentTracks({ username, from, to, page = 1, limit = 200 }) {
      const normalizedUsername = clean(username, 200);
      if (!normalizedUsername) throw new TypeError("username is required");
      const fromSeconds = Math.floor(new Date(from).getTime() / 1_000);
      const toSeconds = Math.floor(new Date(to).getTime() / 1_000);
      if (!Number.isSafeInteger(fromSeconds) || !Number.isSafeInteger(toSeconds) || fromSeconds > toSeconds) throw new TypeError("Invalid recent-track window");
      const normalizedPage = boundedInt(page, 1, 1, 100_000);
      const normalizedLimit = boundedInt(limit, 200, 1, 200);
      const data = await request("user.getRecentTracks", { user: normalizedUsername, from: fromSeconds, to: toSeconds, page: normalizedPage, limit: normalizedLimit, extended: 0 });
      const container = data?.recenttracks;
      const rawRows = Array.isArray(container?.track) ? container.track : (container?.track ? [container.track] : []);
      const attr = container?.["@attr"] || {};
      const totalPages = strictInteger(attr.totalPages, { min: 0, max: 100_000 });
      const responsePage = strictInteger(attr.page, { min: 1, max: 100_000 });
      if (!container || totalPages === null || responsePage !== normalizedPage) throw new LastfmProviderError("lastfm_malformed_response", 502);
      const tracks = rawRows.map((row) => {
        const nowPlaying = String(row?.["@attr"]?.nowplaying || "").toLowerCase() === "true";
        const playedSeconds = Number(row?.date?.uts);
        const artist = clean(row?.artist?.["#text"] || row?.artist?.name, 500);
        const album = clean(row?.album?.["#text"], 500);
        const track = clean(row?.name, 500);
        if (nowPlaying) return { nowPlaying: true };
        if (!Number.isSafeInteger(playedSeconds) || playedSeconds < 0 || !track) return null;
        return { nowPlaying: false, artist, album, track, playedAt: new Date(playedSeconds * 1_000), artistMbid: mbid(row?.artist?.mbid), albumMbid: mbid(row?.album?.mbid), trackMbid: mbid(row?.mbid) };
      }).filter(Boolean);
      return { page: responsePage, totalPages, tracks };
    },
    async albumInfo({ artist, album }) {
      const normalizedArtist = clean(artist, 500);
      const normalizedAlbum = clean(album, 500);
      if (!normalizedArtist || !normalizedAlbum) throw new TypeError("artist and album are required");
      const params = { artist: normalizedArtist, album: normalizedAlbum, autocorrect: 0 };
      const key = cacheKey("album.getInfo:normalized:v2", params);
      if (cache) {
        const cached = await cache.get(key);
        if (cached !== null) return cached;
      }
      const data = await request("album.getInfo", params);
      const result = data?.album;
      const title = clean(result?.name, 500);
      const albumArtist = clean(result?.artist, 500);
      if (!title || !albumArtist) throw new LastfmProviderError("lastfm_malformed_response", 502);
      const rawTracks = Array.isArray(result?.tracks?.track) ? result.tracks.track : (result?.tracks?.track ? [result.tracks.track] : []);
      const normalized = {
        artist: albumArtist,
        album: title,
        mbid: mbid(result?.mbid),
        url: lastfmSourceUrl(result?.url),
        tracks: rawTracks.slice(0, 1_000).map((row) => clean(row?.name, 500)).filter(Boolean),
        retrievedAt: now().toISOString(),
      };
      if (cache) await cache.set(key, normalized, 24 * 60 * 60 * 1_000);
      return normalized;
    },
  };
}

module.exports = { LASTFM_API_URL, LASTFM_AUTH_URL, MAX_RESPONSE_BYTES, LastfmProviderError, createLastfmProvider, lastfmSourceUrl, readBoundedBody, retryAfter, signature };
