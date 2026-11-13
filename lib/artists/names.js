const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { artistMbidOf, normalizeArtistMbid, normalizeArtistName } = require("./identity");
const { sealPlan } = require("./backfill");
const { createRateGate, parseRetryAfter, DEFAULT_USER_AGENT } = require("../catalogImport/listenBrainz");

const BASE_URL = "https://musicbrainz.org/ws/2/artist";
const CACHE_KIND = "rescened-musicbrainz-artist-name";
const MAX_RESPONSE_BYTES = 256 * 1024;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class ArtistNameError extends Error {
  constructor(message, code = "ARTIST_NAME_LOOKUP_FAILED") {
    super(message);
    this.name = "ArtistNameError";
    this.code = code;
  }
}

function normalizeNameRecord(raw, expectedMbid, retrievedAt) {
  const artistMbid = normalizeArtistMbid(expectedMbid);
  if (!artistMbid || normalizeArtistMbid(raw?.id) !== artistMbid) {
    throw new ArtistNameError("MusicBrainz returned a different artist identity; review merges manually", "ARTIST_NAME_ID_MISMATCH");
  }
  let name;
  try { name = normalizeArtistName(raw?.name); } catch {
    throw new ArtistNameError("MusicBrainz returned an invalid artist name", "ARTIST_NAME_INVALID_RESPONSE");
  }
  return { kind: CACHE_KIND, artistMbid, name, sourceUrl: `https://musicbrainz.org/artist/${artistMbid}`, retrievedAt };
}

async function readBoundedJson(response) {
  if (Number(response.headers?.get?.("content-length") || 0) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel?.();
    throw new ArtistNameError("MusicBrainz artist response is too large", "ARTIST_NAME_INVALID_RESPONSE");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.byteLength;
    if (size > MAX_RESPONSE_BYTES) throw new ArtistNameError("MusicBrainz artist response is too large", "ARTIST_NAME_INVALID_RESPONSE");
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
    throw new ArtistNameError("MusicBrainz artist response is not valid JSON", "ARTIST_NAME_INVALID_RESPONSE");
  }
}

function createArtistNameLookup(options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  const nowMs = options.nowMs || Date.now;
  const sleepFn = options.sleepFn || pause;
  const gate = options.rateGate || createRateGate({ intervalMs: 1100, nowMs, sleepFn });
  const timeoutMs = options.timeoutMs ?? 8000;
  const deadline = nowMs() + (options.budgetMs ?? 15 * 60 * 1000);
  const userAgent = options.userAgent || DEFAULT_USER_AGENT;
  const withinBudget = (delay = 0) => {
    if (nowMs() + delay >= deadline) throw new ArtistNameError("Artist-name lookup time budget exhausted; rerun to use the saved cache", "ARTIST_NAME_BUDGET_EXHAUSTED");
  };
  return async function lookup(artistMbid) {
    const mbid = normalizeArtistMbid(artistMbid);
    if (!mbid) throw new ArtistNameError("Invalid MusicBrainz artist ID", "INVALID_ARTIST_MBID");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      withinBudget();
      await gate();
      withinBudget();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, deadline - nowMs()));
      let retryDelay = null;
      try {
        const response = await fetchFn(`${BASE_URL}/${mbid}?fmt=json`, {
          method: "GET", redirect: "error", signal: controller.signal,
          headers: { Accept: "application/json", "User-Agent": userAgent },
        });
        if (!response.ok) {
          await response.body?.cancel?.();
          const retryAfter = parseRetryAfter(response.headers?.get?.("retry-after"), nowMs());
          if (retryAfter !== null && retryAfter > 30_000) {
            throw new ArtistNameError("MusicBrainz requested a longer pause; stop and resume later", "ARTIST_NAME_RETRY_AFTER");
          }
          if (!RETRYABLE.has(response.status) || attempt === 2) {
            throw new ArtistNameError(`MusicBrainz artist lookup returned HTTP ${response.status}`, "ARTIST_NAME_HTTP_ERROR");
          }
          retryDelay = retryAfter ?? 500 * (2 ** attempt);
        } else {
          return normalizeNameRecord(await readBoundedJson(response), mbid, new Date(nowMs()).toISOString());
        }
      } catch (error) {
        if (error instanceof ArtistNameError) throw error;
        if (attempt === 2) throw new ArtistNameError(controller.signal.aborted ? "MusicBrainz artist lookup timed out" : "MusicBrainz artist lookup failed");
        retryDelay = 500 * (2 ** attempt);
      } finally { clearTimeout(timer); }
      withinBudget(retryDelay);
      await sleepFn(retryDelay);
    }
    throw new ArtistNameError("MusicBrainz artist lookup failed");
  };
}

async function readCachedName(cachePath, mbid, nowMs) {
  let cached;
  try {
    const stat = await fs.stat(cachePath);
    if (stat.size > MAX_RESPONSE_BYTES) return null;
    cached = JSON.parse(await fs.readFile(cachePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
  const age = nowMs() - Date.parse(cached?.retrievedAt);
  if (cached?.kind !== CACHE_KIND || cached.artistMbid !== mbid || !Number.isFinite(age) || age < 0 || age > CACHE_TTL_MS) return null;
  try {
    const validated = normalizeNameRecord({ id: cached.artistMbid, name: cached.name }, mbid, cached.retrievedAt);
    return cached.sourceUrl === validated.sourceUrl ? validated : null;
  } catch { return null; }
}

async function writeCachedName(cachePath, record) {
  const temporary = `${cachePath}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, cachePath);
  } finally { await fs.rm(temporary, { force: true }); }
}

// Explicit operator-only enrichment. No database access and no provider calls
// during apply or community approval. Successful lookups survive failed runs;
// incomplete resolution never produces a sealable plan with guessed names.
async function resolvePlanArtistNames(plan, options = {}) {
  if (!options.cacheDir) throw new ArtistNameError("An artist-name cache directory is required", "INVALID_ARGUMENTS");
  if (plan.artistRegistrations.length > 1000) throw new ArtistNameError("Resolve at most 1000 new artists per plan", "ARTIST_NAME_LIMIT");
  const cacheDir = path.resolve(options.cacheDir);
  await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(cacheDir, ".artist-name-fetch.lock");
  let lock;
  try { lock = await fs.open(lockPath, "wx", 0o600); } catch (error) {
    if (error.code === "EEXIST") throw new ArtistNameError("Artist-name cache is locked; check the existing operator process before removing a stale lock", "ARTIST_NAME_CACHE_LOCKED");
    throw error;
  }
  const nowMs = options.nowMs || Date.now;
  const lookup = options.lookup || createArtistNameLookup(options);
  const resolved = JSON.parse(JSON.stringify(plan));
  const summary = { source: "musicbrainz", resolved: 0, cached: 0, changedNames: [] };
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date(nowMs()).toISOString() }));
    for (const artist of resolved.artistRegistrations) {
      const mbid = artistMbidOf(artist);
      const cachePath = path.join(cacheDir, `${mbid}.json`);
      let record = await readCachedName(cachePath, mbid, nowMs);
      if (record) summary.cached += 1;
      else {
        const fetched = await lookup(mbid);
        record = normalizeNameRecord({ id: fetched.artistMbid, name: fetched.name }, mbid, fetched.retrievedAt);
        if (!Number.isFinite(Date.parse(record.retrievedAt))) throw new ArtistNameError("Artist-name lookup has no valid observation time", "ARTIST_NAME_INVALID_RESPONSE");
        await writeCachedName(cachePath, record);
      }
      if (artist.name !== record.name) summary.changedNames.push({ artistId: artist.artistId, artistMbid: mbid, creditedName: artist.name, verifiedName: record.name });
      artist.name = record.name;
      artist.fieldProvenance.name = {
        ...artist.fieldProvenance.name, source: "musicbrainz", nameSource: "musicbrainz-artist",
        method: "artist-name-lookup", artistMbid: mbid, sourceUrl: record.sourceUrl, retrievedAt: record.retrievedAt,
      };
      summary.resolved += 1;
      options.onProgress?.({ completed: summary.resolved, total: resolved.artistRegistrations.length, cached: summary.cached });
    }
    resolved.artistNameResolution = summary;
    return sealPlan(resolved);
  } finally {
    await lock.close();
    await fs.rm(lockPath, { force: true });
  }
}

module.exports = { ArtistNameError, CACHE_TTL_MS, MAX_RESPONSE_BYTES, createArtistNameLookup, normalizeNameRecord, resolvePlanArtistNames };
