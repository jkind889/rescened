const { ProviderBudget, ProviderCache } = require("../../models/Listening");
const { createMusicBrainzSearch } = require("../musicBrainzSearch");
const { safeError } = require("./common");
const MBID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// All discovery processes share one MusicBrainz slot, including search calls.
async function requestSlot({ clock = () => new Date(), sleep = pause } = {}) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const now = clock();
    try {
      const slot = await ProviderBudget.findOneAndUpdate({ key: "musicbrainz-listening", windowStartedAt: { $lte: new Date(now.getTime() - 1100) } }, { $set: { windowStartedAt: now, used: 1 }, $setOnInsert: { key: "musicbrainz-listening" } }, { upsert: true, returnDocument: "after" });
      if (slot) return;
    } catch (error) { if (error.code !== 11000) throw error; }
    await sleep(1100);
  }
  throw safeError("MUSICBRAINZ_BUDGET_EXHAUSTED", 503);
}

function createListeningMusicBrainz(options = {}) {
  const clock = options.clock || (() => new Date());
  const gate = options.gate || (() => requestSlot({ clock }));
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const userAgent = process.env.MUSICBRAINZ_USER_AGENT || require("../musicBrainzSearch").DEFAULT_USER_AGENT;
  const cache = options.cache || ProviderCache;
  async function guardedFetch(url, init) {
    const response = await fetchImpl(url, init);
    if (response.status === 429 || response.status === 503) {
      const value = response.headers?.get?.("retry-after");
      const seconds = value === null || value === undefined ? NaN : Number(value);
      const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - clock().getTime();
      if (Number.isFinite(delay) && delay > 0) {
        await ProviderBudget.updateOne({ key: "musicbrainz-listening" }, { $max: { windowStartedAt: new Date(clock().getTime() + delay) }, $setOnInsert: { used: 1 } }, { upsert: true });
      }
    }
    return response;
  }
  const search = options.search || createMusicBrainzSearch({ rateGate: gate, userAgent, timeoutMs: 8000, fetchFn: guardedFetch });
  return {
    searchReleaseGroups: search.searchReleaseGroups,
    async releaseRelationship(id) {
      if (!MBID.test(id || "")) return null;
      const releaseMbid = id.toLowerCase();
      const key = `listening-mb-release:${releaseMbid}`;
      const cached = await cache.findOne({ key, expiresAt: { $gt: clock() } }).lean();
      if (cached) return cached.value;
      await gate();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const url = `https://musicbrainz.org/ws/2/release/${releaseMbid}?inc=release-groups+artist-credits&fmt=json`;
        const response = await guardedFetch(url, { signal: controller.signal, headers: { Accept: "application/json", "User-Agent": userAgent } });
        if (response.status === 404) return null;
        if (!response.ok) throw safeError("MUSICBRAINZ_UNAVAILABLE", 503);
        const length = Number(response.headers?.get?.("content-length") || 0);
        if (length > 1000000) throw safeError("MUSICBRAINZ_INVALID_RESPONSE", 502);
        let bytes = "";
        if (response.body?.getReader) {
          const reader = response.body.getReader(); let size = 0; const chunks = [];
          while (true) {
            const { done, value } = await reader.read(); if (done) break;
            size += value.byteLength;
            if (size > 1000000) { await reader.cancel(); throw safeError("MUSICBRAINZ_INVALID_RESPONSE", 502); }
            chunks.push(Buffer.from(value));
          }
          bytes = Buffer.concat(chunks).toString("utf8");
        } else bytes = JSON.stringify(await response.json());
        const raw = JSON.parse(bytes);
        const group = raw["release-group"];
        if (raw.id !== releaseMbid || !MBID.test(group?.id || "")) throw safeError("MUSICBRAINZ_INVALID_RESPONSE", 502);
        const credits = raw["artist-credit"];
        if (!Array.isArray(credits) || credits.length > 50) throw safeError("MUSICBRAINZ_INVALID_RESPONSE", 502);
        const artist = credits.map((item) => `${item.name || item.artist?.name || ""}${item.joinphrase || ""}`).join("");
        if (!artist || artist.length > 500 || typeof raw.title !== "string" || raw.title.length > 500) throw safeError("MUSICBRAINZ_INVALID_RESPONSE", 502);
        const value = { releaseMbid, releaseGroupMbid: group.id.toLowerCase(), artist, album: raw.title, sourceUrl: `https://musicbrainz.org/release/${releaseMbid}`, retrievedAt: clock().toISOString() };
        await cache.updateOne({ key }, { $set: { value, expiresAt: new Date(clock().getTime() + 86400000) } }, { upsert: true });
        return value;
      } catch (error) {
        throw safeError(error.code === "MUSICBRAINZ_INVALID_RESPONSE" ? error.code : "MUSICBRAINZ_UNAVAILABLE", 503);
      } finally { clearTimeout(timer); }
    },
  };
}
module.exports = { createListeningMusicBrainz, requestSlot };
