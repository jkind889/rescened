// Shared Clerk author lookups for album-, review-, and profile-bearing responses.
//
// Clerk's getUserList returns 10 users unless asked for more, and each call
// also issues a count request, so lookups are batched with an explicit limit
// and cached briefly in process. A failed Clerk call falls back to the default
// author without caching, so the next read tries again.
const DEFAULT_AUTHOR = "rescened user";
const BATCH_SIZE = 100;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 5000;

function fallbackAuthor(userId) {
  return { userId, username: DEFAULT_AUTHOR, imageUrl: "" };
}

function toAuthor(user) {
  return { userId: user.id, username: user.username || DEFAULT_AUTHOR, imageUrl: user.imageUrl || "" };
}

function listedUsers(listed) {
  return Array.isArray(listed) ? listed : listed?.data || [];
}

// An LRU of resolved authors plus the lookups in flight, so concurrent
// requests for the same user share one Clerk call.
function createAuthorCache({ ttlMs = CACHE_TTL_MS, maxEntries = CACHE_MAX_ENTRIES, now = Date.now } = {}) {
  const entries = new Map();
  const pending = new Map();

  function read(userId) {
    const entry = entries.get(userId);
    if (!entry) return null;
    entries.delete(userId);
    if (entry.expiresAt <= now()) return null;
    entries.set(userId, entry);
    return entry.author;
  }

  function write(userId, author) {
    entries.delete(userId);
    entries.set(userId, { author, expiresAt: now() + ttlMs });
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  }

  function request(users, batch) {
    const found = (async () => {
      const listed = await users.getUserList({ userId: batch, limit: batch.length });
      const byId = new Map(listedUsers(listed).map((user) => [user.id, toAuthor(user)]));
      // A user missing from a successful response (for example, a deleted
      // Clerk account) is cached under the default name like any other.
      batch.forEach((userId) => write(userId, byId.get(userId) || fallbackAuthor(userId)));
      return byId;
    })().catch(() => null);

    for (const userId of batch) {
      const lookup = found.then((byId) => (byId ? byId.get(userId) || fallbackAuthor(userId) : null));
      pending.set(userId, lookup);
      lookup.then(() => { if (pending.get(userId) === lookup) pending.delete(userId); });
    }
  }

  // Resolves every id to { userId, username, imageUrl }. Ids listed in refresh
  // skip the cache, for reads where the user may have just renamed themself.
  async function lookup(users, ids, { refresh = [] } = {}) {
    const unique = [...new Set((ids || []).filter(Boolean))];
    const forced = new Set(refresh);
    const resolved = new Map();
    const missing = [];

    for (const userId of unique) {
      const cached = forced.has(userId) ? null : read(userId);
      if (cached) resolved.set(userId, cached);
      else if (!forced.has(userId) && pending.has(userId)) continue;
      else missing.push(userId);
    }

    for (let start = 0; start < missing.length; start += BATCH_SIZE) {
      request(users, missing.slice(start, start + BATCH_SIZE));
    }

    await Promise.all(unique
      .filter((userId) => !resolved.has(userId))
      .map(async (userId) => resolved.set(userId, (await pending.get(userId)) || fallbackAuthor(userId))));

    // Copies keep callers from mutating shared cache entries.
    return new Map(unique.map((userId) => [userId, { ...resolved.get(userId) }]));
  }

  return {
    lookup,
    clear() { entries.clear(); pending.clear(); },
    get size() { return entries.size; },
  };
}

// One cache per Clerk users API object. Production reuses a single client;
// tests that install a stub client start from an empty cache.
const caches = new WeakMap();

function cacheFor(users) {
  let cache = caches.get(users);
  if (!cache) {
    cache = createAuthorCache();
    caches.set(users, cache);
  }
  return cache;
}

async function lookupAuthors(ids, options = {}) {
  let users;
  try {
    // Resolved per call so tests can substitute the Clerk module.
    ({ clerkClient: { users } } = require("@clerk/express"));
  } catch {
    users = null;
  }
  if (!users || typeof users.getUserList !== "function") {
    return new Map([...new Set((ids || []).filter(Boolean))].map((userId) => [userId, fallbackAuthor(userId)]));
  }
  return cacheFor(users).lookup(users, ids, options);
}

module.exports = {
  BATCH_SIZE,
  CACHE_TTL_MS,
  DEFAULT_AUTHOR,
  createAuthorCache,
  fallbackAuthor,
  lookupAuthors,
};
