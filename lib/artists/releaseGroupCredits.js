const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { normalizeArtistMbid } = require("./identity");
const { MAX_ATTEMPTS, buildEvidence, creditProblems, normalizeRequestIds, publishEvidence, resolvedRowProblems } = require("./enrichmentEvidence");
const {
  CatalogFetchError,
  DEFAULT_USER_AGENT,
  MUSICBRAINZ_API_URL,
  createRateGate,
  mapArtistCredits,
  normalizeText,
  parseRetryAfter,
} = require("../catalogImport/listenBrainz");

// Operator-only MusicBrainz lookup of release-group artist credits by exact
// release-group MBID. It never searches by artist name or album title, never
// follows redirects, and never touches MongoDB. Successful lookups are kept in
// a private per-ID disk cache so an interrupted run resumes by rerunning.
const REQUEST_INTERVAL_MS = 1100;
const REQUEST_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_RETRY_AFTER_MS = 30_000;
const TRANSIENT_BREAKER_LIMIT = 5;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_KIND = "rescened-musicbrainz-release-group-credits-cache";
const CACHE_VERSION = 1;
const LOCK_FILE = ".enrichment.lock";
const COOLDOWN_FILE = ".not-before.json";
const DEFAULT_BUDGET_MINUTES = 30;
const MAX_BUDGET_MINUTES = 240;
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_TITLE_LENGTH = 1000;

class EnrichmentStop extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = "EnrichmentStop";
    this.code = code;
    Object.assign(this, extra);
  }
}

// A response that will not improve on retry (malformed, oversized).
class RejectedResponse extends Error {
  constructor(message) {
    super(message);
    this.name = "RejectedResponse";
  }
}

const MAX_DATE_MS = 8.64e15;

// A sleep that ends early, without leaving a timer behind, when the run is
// interrupted, so Ctrl-C during a backoff or Retry-After wait is prompt.
function pause(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// One gate per process: every fetcher created without an explicit gate, and
// every retry, shares the same request-start spacing. Separate processes are
// not coordinated; operators run one fetch at a time from one egress address.
let processGate = null;
function processRateGate() {
  if (!processGate) processGate = createRateGate({ intervalMs: REQUEST_INTERVAL_MS });
  return processGate;
}

function iso(ms) {
  return new Date(Math.min(ms, MAX_DATE_MS)).toISOString();
}

function unresolvedRow(releaseGroupMbid, observedAt, reason, extra = {}) {
  return { releaseGroupMbid, status: "unresolved", observedAt, reason, ...extra };
}

// Normalizes one release-group payload with the catalog importer's credit
// normalization, and additionally requires every underlying artist name.
function normalizeReleaseGroupPayload(raw, expectedMbid, observedAt) {
  const releaseGroupMbid = normalizeArtistMbid(expectedMbid);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return unresolvedRow(releaseGroupMbid, observedAt, "INVALID_RESPONSE");
  const returned = normalizeArtistMbid(raw.id);
  if (returned !== releaseGroupMbid) {
    return returned
      ? unresolvedRow(releaseGroupMbid, observedAt, "ID_MISMATCH", { destinationReleaseGroupMbid: returned })
      : unresolvedRow(releaseGroupMbid, observedAt, "INVALID_RESPONSE");
  }
  const title = typeof raw.title === "string" ? normalizeText(raw.title) : "";
  const rawCredits = raw["artist-credit"];
  // The importer's normalizer coerces values to text; require real strings.
  const textOrAbsent = (value) => value === undefined || value === null || typeof value === "string";
  if (Array.isArray(rawCredits) && rawCredits.some((credit) => !credit || typeof credit !== "object"
    || !textOrAbsent(credit.name) || !textOrAbsent(credit.joinphrase) || !credit.artist || typeof credit.artist !== "object" || typeof credit.artist.id !== "string")) {
    return unresolvedRow(releaseGroupMbid, observedAt, "INVALID_CREDITS");
  }
  if (!title || title.length > MAX_TITLE_LENGTH) return unresolvedRow(releaseGroupMbid, observedAt, "INVALID_RESPONSE");
  let credits;
  try {
    credits = mapArtistCredits(rawCredits).artistCredits
      .map(({ name, joinPhrase, artistMbid, artistName }) => ({ name, joinPhrase, artistMbid, artistName }));
  } catch (error) {
    if (error instanceof CatalogFetchError) return unresolvedRow(releaseGroupMbid, observedAt, "INVALID_CREDITS");
    throw error;
  }
  if (creditProblems(credits).length) return unresolvedRow(releaseGroupMbid, observedAt, "INVALID_CREDITS");
  return { releaseGroupMbid, status: "resolved", observedAt, title, credits };
}

function destinationFromLocation(location, base) {
  if (typeof location !== "string" || !location) return "";
  try {
    const url = new URL(location, base);
    if (url.hostname !== "musicbrainz.org") return "";
    const match = /^\/ws\/2\/release-group\/([^/?#]+)\/?$/.exec(url.pathname) || /^\/release-group\/([^/?#]+)\/?$/.exec(url.pathname);
    return match ? normalizeArtistMbid(decodeURIComponent(match[1])) : "";
  } catch {
    return "";
  }
}

async function discardBody(response) {
  try { await response.body?.cancel?.(); } catch { /* ignore */ }
}

// Streams the body under the request's abort signal, so the timeout covers
// the body as well as the headers, and stops at the size limit.
async function readBoundedJson(response, signal, maxBytes) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discardBody(response);
    throw new RejectedResponse("response is too large");
  }
  const reader = response.body?.getReader?.();
  if (!reader) throw new RejectedResponse("response has no body");
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason || new Error("aborted"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => {});
  const chunks = [];
  let size = 0;
  let done = false;
  try {
    while (!done) {
      const next = await Promise.race([reader.read(), aborted]);
      done = next.done;
      if (next.value) {
        size += next.value.byteLength;
        if (size > maxBytes) throw new RejectedResponse("response is too large");
        chunks.push(Buffer.from(next.value));
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (!done) reader.cancel().catch(() => {});
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RejectedResponse("response is not valid JSON");
  }
}

function createReleaseGroupCreditFetcher(options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  if (typeof fetchFn !== "function") throw new TypeError("A fetch implementation is required");
  const nowMs = options.nowMs || Date.now;
  const sleepFn = options.sleepFn || pause;
  const gate = options.rateGate || processRateGate();
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const deadlineMs = options.deadlineMs ?? Infinity;
  const signal = options.signal || null;
  const userAgent = normalizeText(options.userAgent || DEFAULT_USER_AGENT);
  if (!userAgent || !/[(/@]/.test(userAgent)) throw new TypeError("The user agent must identify the application and a contact");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be positive");
  let notBeforeMs = 0;

  const interrupted = () => {
    if (signal?.aborted) throw new EnrichmentStop("The run was interrupted", "INTERRUPTED");
  };
  const withinBudget = (delay = 0) => {
    if (nowMs() + delay >= deadlineMs) throw new EnrichmentStop("The run's time budget is exhausted; rerun to continue from the cache", "BUDGET_EXHAUSTED");
  };
  const wait = async (ms) => {
    if (ms <= 0) return;
    withinBudget(ms);
    interrupted();
    if (signal) {
      let onAbort;
      const aborted = new Promise((resolve) => {
        onAbort = resolve;
        signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        await Promise.race([sleepFn(ms, signal), aborted]);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    } else {
      await sleepFn(ms);
    }
    interrupted();
  };

  async function fetchOne(id) {
    const releaseGroupMbid = normalizeArtistMbid(id);
    if (!releaseGroupMbid) throw new TypeError("Invalid release-group MBID");
    const url = `${MUSICBRAINZ_API_URL}/${releaseGroupMbid}?inc=artist-credits&fmt=json`;
    let lastFailure = "NETWORK_ERROR";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      interrupted();
      withinBudget();
      // Honor an earlier short Retry-After before any further request.
      await wait(notBeforeMs - nowMs());
      await gate();
      interrupted();
      withinBudget();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
      const forwardAbort = () => controller.abort(new Error("interrupted"));
      signal?.addEventListener("abort", forwardAbort, { once: true });
      let backoff = 1000 * (2 ** (attempt - 1));
      try {
        const response = await fetchFn(url, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: { Accept: "application/json", "User-Agent": userAgent },
        });
        const observedAt = iso(nowMs());
        if (response.status >= 300 && response.status < 400) {
          await discardBody(response);
          const destination = destinationFromLocation(response.headers?.get?.("location"), url);
          return {
            attempts: attempt,
            row: unresolvedRow(releaseGroupMbid, observedAt, "REDIRECTED", {
              httpStatus: response.status,
              ...(destination && destination !== releaseGroupMbid ? { destinationReleaseGroupMbid: destination } : {}),
            }),
          };
        }
        if (response.status === 404) {
          await discardBody(response);
          return { attempts: attempt, row: unresolvedRow(releaseGroupMbid, observedAt, "NOT_FOUND", { httpStatus: 404 }) };
        }
        if (!response.ok) {
          await discardBody(response);
          if (!RETRYABLE_STATUSES.has(response.status)) {
            // A status outside 4xx/5xx (for example from a proxy) is not an HTTP answer from MusicBrainz.
            const httpError = Number.isInteger(response.status) && response.status >= 400 && response.status <= 599;
            return {
              attempts: attempt,
              row: httpError
                ? unresolvedRow(releaseGroupMbid, observedAt, "HTTP_ERROR", { httpStatus: response.status })
                : unresolvedRow(releaseGroupMbid, observedAt, "INVALID_RESPONSE"),
            };
          }
          lastFailure = `HTTP_${response.status}`;
          const retryAfter = parseRetryAfter(response.headers?.get?.("retry-after"), nowMs());
          if (retryAfter !== null && retryAfter > MAX_RETRY_AFTER_MS) {
            // iso() clamps an absurd value to the latest representable date.
            throw new EnrichmentStop("MusicBrainz asked for a longer pause; the run stopped and records when it may resume", "RETRY_AFTER_EXCEEDED", {
              notBefore: iso(nowMs() + retryAfter),
            });
          }
          if (retryAfter !== null) {
            notBeforeMs = Math.max(notBeforeMs, nowMs() + retryAfter);
            backoff = Math.max(backoff, retryAfter);
          }
        } else {
          const raw = await readBoundedJson(response, controller.signal, maxBytes);
          return { attempts: attempt, row: normalizeReleaseGroupPayload(raw, releaseGroupMbid, observedAt) };
        }
      } catch (error) {
        if (error instanceof EnrichmentStop) throw error;
        interrupted();
        if (error instanceof RejectedResponse) {
          return { attempts: attempt, row: unresolvedRow(releaseGroupMbid, iso(nowMs()), "INVALID_RESPONSE") };
        }
        lastFailure = controller.signal.aborted ? "TIMEOUT" : "NETWORK_ERROR";
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", forwardAbort);
      }
      if (attempt === MAX_ATTEMPTS) {
        return {
          attempts: attempt,
          row: { releaseGroupMbid, status: "deferred", observedAt: iso(nowMs()), reason: "TRANSIENT_FAILURE", attempts: attempt, lastFailure },
        };
      }
      await wait(backoff);
    }
    throw new Error("unreachable");
  }

  // The latest short Retry-After still in force, so a run that stops for
  // another reason can persist it for the next run.
  const pendingNotBeforeMs = () => notBeforeMs;

  return { fetchOne, gate, pendingNotBeforeMs };
}

// --- Private cache -------------------------------------------------------

function cachePathFor(cacheDir, releaseGroupMbid) {
  return path.join(cacheDir, `${releaseGroupMbid}.json`);
}

// Returns a validated, unexpired successful result, or null when the entry is
// missing, corrupt, of another version or identity, expired, or oversized.
async function readCacheEntry(cacheDir, releaseGroupMbid, nowMs = Date.now) {
  const file = cachePathFor(cacheDir, releaseGroupMbid);
  let entry;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > MAX_RESPONSE_BYTES) return null;
    entry = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  if (Object.keys(entry).sort().join(",") !== "cacheVersion,kind,row") return null;
  if (entry.kind !== CACHE_KIND || entry.cacheVersion !== CACHE_VERSION) return null;
  const row = entry.row;
  if (row?.releaseGroupMbid !== releaseGroupMbid || row.status !== "resolved" || resolvedRowProblems(row).length) return null;
  const age = nowMs() - Date.parse(row.observedAt);
  if (!Number.isFinite(age) || age < 0 || age > CACHE_TTL_MS) return null;
  return row;
}

async function atomicWrite(file, text) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function writeCacheEntry(cacheDir, row) {
  if (row?.status !== "resolved" || resolvedRowProblems(row).length) throw new TypeError("Only valid resolved rows are cached");
  await atomicWrite(cachePathFor(cacheDir, row.releaseGroupMbid), `${JSON.stringify({ kind: CACHE_KIND, cacheVersion: CACHE_VERSION, row }, null, 2)}\n`);
}

function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function readLockOwner(lockPath) {
  try {
    const text = await fs.readFile(lockPath, "utf8");
    const owner = JSON.parse(text);
    return owner && typeof owner === "object" ? { owner, text } : { owner: null, text };
  } catch (error) {
    if (error.code === "ENOENT") return { owner: null, text: null, missing: true };
    return { owner: null, text: null };
  }
}

// Exclusive cache lock. A lock left by a process that no longer exists on
// this host is removed; anything else (a live owner, another host, an
// unreadable lock) stops the run for the operator to inspect.
async function acquireCacheLock(cacheDir, options = {}) {
  const lockPath = path.join(cacheDir, LOCK_FILE);
  const pid = options.pid ?? process.pid;
  const hostname = options.hostname ?? os.hostname();
  const isProcessAlive = options.isProcessAlive || defaultIsProcessAlive;
  const token = crypto.randomUUID();
  const content = JSON.stringify({ pid, hostname, token, startedAt: iso((options.nowMs || Date.now)()) });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.writeFile(lockPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      return async function release() {
        const current = await readLockOwner(lockPath);
        if (current.owner?.token === token) await fs.rm(lockPath, { force: true });
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const { owner, text, missing } = await readLockOwner(lockPath);
    if (missing) continue;
    const stale = owner && owner.hostname === hostname && Number.isInteger(owner.pid) && owner.pid > 0 && !isProcessAlive(owner.pid);
    if (!stale || attempt > 0) {
      throw new EnrichmentStop(
        `The enrichment cache is locked by ${owner ? `pid ${owner.pid} on ${owner.hostname}` : "an unreadable lock"}; check that process before removing ${lockPath}`,
        "CACHE_LOCKED",
      );
    }
    // Move the lock aside atomically and delete it only if it is the exact
    // stale lock inspected. If another process replaced it meanwhile, put
    // that fresh lock back (never over a newer one) and stop.
    const aside = `${lockPath}.${crypto.randomUUID()}.stale`;
    try {
      await fs.rename(lockPath, aside);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const moved = await readLockOwner(aside);
    if (moved.text !== text) {
      try { await fs.link(aside, lockPath); } catch { /* a newer lock exists */ }
      await fs.rm(aside, { force: true });
      throw new EnrichmentStop(`The enrichment cache lock changed while it was being checked; inspect ${lockPath}`, "CACHE_LOCKED");
    }
    await fs.rm(aside, { force: true });
  }
  throw new EnrichmentStop(`Could not acquire ${lockPath}`, "CACHE_LOCKED");
}

async function readCooldown(cacheDir) {
  const file = path.join(cacheDir, COOLDOWN_FILE);
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  let value;
  try { value = JSON.parse(text); } catch { value = null; }
  const notBeforeMs = Date.parse(value?.notBefore);
  if (!Number.isFinite(notBeforeMs)) {
    throw new EnrichmentStop(`The recorded MusicBrainz cooldown in ${file} is unreadable; inspect it before rerunning`, "COOLDOWN_UNREADABLE");
  }
  return { file, notBeforeMs, notBefore: value.notBefore };
}

async function writeCooldown(cacheDir, notBefore, nowMs, reason = "RETRY_AFTER_EXCEEDED") {
  await atomicWrite(path.join(cacheDir, COOLDOWN_FILE), `${JSON.stringify({ notBefore, recordedAt: iso(nowMs()), reason }, null, 2)}\n`);
}

function validateBudgetMinutes(value) {
  const minutes = value === undefined ? DEFAULT_BUDGET_MINUTES : Number(value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_BUDGET_MINUTES) {
    throw new EnrichmentStop(`--budget-minutes must be an integer from 1 to ${MAX_BUDGET_MINUTES}`, "INVALID_ARGUMENTS");
  }
  return minutes;
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// Fetches (or reuses cached) credits for every requested ID, then publishes
// one sealed evidence file. A stop (interruption, budget, long throttle, or
// repeated transient failures) keeps the cache and publishes nothing.
async function runReleaseGroupEnrichment(options) {
  const { originPlanSha256 = null, onProgress } = options;
  // Validate and normalize before any cache path or request is built.
  const ids = normalizeRequestIds(options.ids);
  const nowMs = options.nowMs || Date.now;
  const cacheDir = path.resolve(options.cacheDir);
  const outPath = path.resolve(options.outPath);
  const budgetMinutes = validateBudgetMinutes(options.budgetMinutes);
  if (isInside(outPath, cacheDir)) throw new EnrichmentStop("--out must not be inside --cache-dir", "INVALID_ARGUMENTS");
  try {
    await fs.lstat(outPath);
    throw new EnrichmentStop(`Evidence file already exists: ${outPath}`, "ARTIFACT_EXISTS");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const cacheStat = await fs.lstat(cacheDir);
  if (!cacheStat.isDirectory()) throw new EnrichmentStop(`--cache-dir is not a directory: ${cacheDir}`, "INVALID_ARGUMENTS");
  await fs.chmod(cacheDir, 0o700);

  const release = await acquireCacheLock(cacheDir, options);
  const progress = { total: ids.length, completed: 0, cached: 0, fetched: 0, resolved: 0, unresolved: 0, deferred: 0 };
  let fetcher = null;
  // Records any pause MusicBrainz requested, however the run ends: a long
  // Retry-After, or a short one still in force. A failure to record it is
  // reported and never hides the run's own outcome.
  const persistPause = async (otherMs, reason) => {
    const pendingMs = typeof fetcher?.pendingNotBeforeMs === "function" ? fetcher.pendingNotBeforeMs() : 0;
    const notBeforeMs = Math.max(pendingMs, otherMs || 0);
    if (!(notBeforeMs > nowMs())) return {};
    try {
      await writeCooldown(cacheDir, iso(notBeforeMs), nowMs, reason);
      return { notBefore: iso(notBeforeMs) };
    } catch (cooldownError) {
      return { notBefore: iso(notBeforeMs), cooldownWriteError: cooldownError.message };
    }
  };
  try {
    const cooldown = await readCooldown(cacheDir);
    if (cooldown && nowMs() < cooldown.notBeforeMs) {
      throw new EnrichmentStop(`MusicBrainz asked this client to wait; do not rerun before ${cooldown.notBefore}`, "COOLDOWN_ACTIVE", { notBefore: cooldown.notBefore });
    }
    if (cooldown) await fs.rm(cooldown.file, { force: true });

    fetcher = options.fetcher || createReleaseGroupCreditFetcher({
      ...options,
      deadlineMs: nowMs() + budgetMinutes * 60_000,
    });
    const results = [];
    let consecutiveTransient = 0;
    for (const id of ids) {
      if (options.signal?.aborted) throw new EnrichmentStop("The run was interrupted", "INTERRUPTED");
      let row = await readCacheEntry(cacheDir, id, nowMs);
      if (row) {
        progress.cached += 1;
      } else {
        let outcome;
        outcome = await fetcher.fetchOne(id);
        row = outcome.row;
        progress.fetched += 1;
        if (row.status === "deferred") {
          consecutiveTransient += 1;
          if (consecutiveTransient >= TRANSIENT_BREAKER_LIMIT) {
            throw new EnrichmentStop(`${TRANSIENT_BREAKER_LIMIT} consecutive release groups failed after retries; MusicBrainz may be unavailable`, "TRANSIENT_BREAKER");
          }
        } else {
          consecutiveTransient = 0;
          if (row.status === "resolved") await writeCacheEntry(cacheDir, row);
        }
      }
      results.push(row);
      progress.completed += 1;
      progress[row.status] += 1;
      onProgress?.({ ...progress });
    }
    const evidence = buildEvidence({ ids, results, originPlanSha256, generatedAt: iso(nowMs()) });
    const published = publishEvidence(outPath, evidence);
    const result = { evidence, outPath: published, progress };
    // A short pause can still be in force after a complete run (for example
    // when the last ID was deferred); the usual rerun must respect it too.
    Object.assign(result, await persistPause(0, "RETRY_AFTER_PENDING"));
    return result;
  } catch (error) {
    error.progress = { ...progress };
    const longPause = error.code === "RETRY_AFTER_EXCEEDED" ? Date.parse(error.notBefore) : 0;
    Object.assign(error, await persistPause(longPause, error.code === "RETRY_AFTER_EXCEEDED" ? "RETRY_AFTER_EXCEEDED" : "RETRY_AFTER_PENDING"));
    throw error;
  } finally {
    await release();
  }
}

module.exports = {
  CACHE_KIND,
  CACHE_TTL_MS,
  CACHE_VERSION,
  COOLDOWN_FILE,
  EnrichmentStop,
  LOCK_FILE,
  MAX_ATTEMPTS,
  MAX_RESPONSE_BYTES,
  MAX_RETRY_AFTER_MS,
  REQUEST_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
  TRANSIENT_BREAKER_LIMIT,
  acquireCacheLock,
  createReleaseGroupCreditFetcher,
  normalizeReleaseGroupPayload,
  processRateGate,
  readCacheEntry,
  runReleaseGroupEnrichment,
  validateBudgetMinutes,
  writeCacheEntry,
};
