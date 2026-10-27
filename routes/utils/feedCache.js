// A small TTL cache for site-wide discovery rankings, modeled on the people
// suggestion pool. Concurrent requests for the same key share one in-flight
// ranking, and a failed ranking is not cached. Entries hold only ranked ids and
// scores; catalog metadata and viewer state are resolved on every request.
const FEED_CACHE_TTL_MS = 60 * 1000;
const FEED_CACHE_MAX_KEYS = 100;

function createFeedCache({ ttlMs = FEED_CACHE_TTL_MS, maxKeys = FEED_CACHE_MAX_KEYS, clock = Date.now } = {}) {
  const entries = new Map();

  function get(key, compute) {
    const current = clock();
    const cached = entries.get(key);
    if (cached && cached.expiresAt > current) return cached.promise;

    const promise = Promise.resolve().then(compute);
    const entry = { expiresAt: current + ttlMs, promise };
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > maxKeys) entries.delete(entries.keys().next().value);
    promise.catch(() => { if (entries.get(key) === entry) entries.delete(key); });
    return promise;
  }

  return {
    get,
    clear() { entries.clear(); },
    get size() { return entries.size; },
  };
}

module.exports = { FEED_CACHE_TTL_MS, FEED_CACHE_MAX_KEYS, createFeedCache };
