// Which credited artistIds have an artist page. List pages show many albums at
// once, so credits are checked in batches against GET /artists/links and a
// credit becomes a link only after the API names its artistId. Until then, and
// whenever the check is unavailable, the credit stays plain text.
//
// The store has no imports so it can run anywhere. It never retries on its
// own: a failed batch is skipped for a cool-down and asked again only when a
// page renders those credits after the cool-down. "Artist pages are off" is
// also a cool-down, not permanent, so a proxy's passing 503 cannot disable
// links for the rest of a long session.

const ARTIST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const LINK_BATCH_SIZE = 100;
export const LINK_BATCH_DELAY_MS = 25;
export const LINK_FAILURE_COOLDOWN_MS = 60_000;
export const LINK_UNAVAILABLE_COOLDOWN_MS = 5 * 60_000;

export function normalizeCreditArtistId(value) {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ARTIST_ID.test(id) ? id : "";
}

// The artist page API says "not for you" with the coded disabled response, or
// with a 404/503 that carries no code (an API older than the route).
export function linksUnavailable(error) {
  if (!error) return false;
  if (error.code === "ARTIST_PAGES_DISABLED") return true;
  return !error.code && [404, 503].includes(error.status);
}

export function createArtistLinkStore({
  load,
  now = () => Date.now(),
  schedule = (callback, delay) => setTimeout(callback, delay),
  batchSize = LINK_BATCH_SIZE,
  delay = LINK_BATCH_DELAY_MS,
  cooldown = LINK_FAILURE_COOLDOWN_MS,
  unavailableCooldown = LINK_UNAVAILABLE_COOLDOWN_MS,
} = {}) {
  const linked = new Set();
  const absent = new Set();
  const queued = new Set();
  const inFlight = new Set();
  const coolingDown = new Map();
  const listeners = new Set();
  let unavailableUntil = 0;
  let timer = null;
  let version = 0;

  function notify() {
    version += 1;
    listeners.forEach((listener) => listener());
  }

  const unavailable = () => now() < unavailableUntil;

  function settled(id) {
    return linked.has(id) || absent.has(id) || queued.has(id) || inFlight.has(id);
  }

  async function flush() {
    timer = null;
    if (unavailable()) { queued.clear(); return; }
    const batch = [...queued].slice(0, batchSize);
    batch.forEach((id) => { queued.delete(id); inFlight.add(id); });
    if (!batch.length) return;
    try {
      const found = new Set((await load(batch)).map(normalizeCreditArtistId).filter(Boolean));
      for (const id of batch) (found.has(id) ? linked : absent).add(id);
    } catch (error) {
      if (linksUnavailable(error)) unavailableUntil = now() + unavailableCooldown;
      else batch.forEach((id) => coolingDown.set(id, now() + cooldown));
    } finally {
      batch.forEach((id) => inFlight.delete(id));
      notify();
      if (queued.size && !timer && !unavailable()) timer = schedule(flush, delay);
    }
  }

  return {
    // Asks about credits a page is about to link. Unknown or malformed IDs are
    // dropped; known, queued, in-flight, and cooling-down IDs are not asked again.
    request(ids) {
      if (unavailable()) return;
      for (const raw of Array.isArray(ids) ? ids : []) {
        const id = normalizeCreditArtistId(raw);
        if (!id || settled(id)) continue;
        if ((coolingDown.get(id) || 0) > now()) continue;
        coolingDown.delete(id);
        queued.add(id);
      }
      if (queued.size && !timer) timer = schedule(flush, delay);
    },
    // Records IDs the API already confirmed in another response, such as an
    // album detail's artistPages.artistIds.
    confirm(ids) {
      let changed = false;
      for (const raw of Array.isArray(ids) ? ids : []) {
        const id = normalizeCreditArtistId(raw);
        if (!id || linked.has(id)) continue;
        linked.add(id);
        absent.delete(id);
        changed = true;
      }
      if (changed) notify();
    },
    isLinked: (id) => linked.has(normalizeCreditArtistId(id)),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getVersion: () => version,
  };
}
