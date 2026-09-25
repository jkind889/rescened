const { array, mbid, name, text } = require("./core");
const USER_AGENT = "RescenedListeningStudy/1.0 (https://github.com/jkind889/rescened)";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const safeFailure = (code) => Object.assign(new Error(code), { code });

function retryAfter(value, now) {
  if (!value) return 0;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.ceil(Number(value) * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

function createClient({ apiKey = "", fetchFn = globalThis.fetch, sleepFn = sleep, now = Date.now, intervalMs = 1100 } = {}) {
  if (!Number.isFinite(intervalMs) || intervalMs < 1100) throw new Error("Study requests require at least 1100ms spacing");
  let gate = Promise.resolve(); let lastStart = null;
  async function request(base, parameters) {
    const url = new URL(base);
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const turn = gate.then(async () => {
        if (lastStart !== null) await sleepFn(Math.max(0, lastStart + intervalMs - now()));
        lastStart = now();
      });
      gate = turn.catch(() => {}); await turn;
      let response; let data;
      try {
        response = await fetchFn(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: AbortSignal.timeout(10000) });
        // Limit data before parsing and never put URLs (which contain the key) into errors.
        const chunks = []; let bytes = 0;
        for await (const chunk of response.body || []) {
          bytes += chunk.length;
          if (bytes > 5_000_000) throw safeFailure("response_too_large");
          chunks.push(Buffer.from(chunk));
        }
        try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { if (response.ok) throw safeFailure("malformed_json"); }
      } catch (error) {
        if (["malformed_json", "response_too_large"].includes(error.code)) throw error;
        if (attempt === 2) throw safeFailure("network_or_timeout");
        await sleepFn(1000 * 2 ** attempt); continue;
      }
      const transient = [408, 429, 500, 502, 503, 504].includes(response.status) || [11, 16, 29].includes(Number(data?.error));
      if (transient) {
        const delay = Math.max(retryAfter(response.headers.get("retry-after"), now()), 1000 * 2 ** attempt);
        if (attempt === 2 || delay > 10000) throw safeFailure("provider_unavailable");
        await sleepFn(delay); continue;
      }
      if (!response.ok) throw safeFailure(`http_${response.status}`);
      if ([4, 9, 10, 13, 26].includes(Number(data?.error))) throw safeFailure("provider_authentication_failed");
      return data;
    }
    throw safeFailure("provider_unavailable");
  }
  function lastfm(parameters) {
    if (!apiKey.trim()) throw safeFailure("LASTFM_API_KEY_required");
    return request("https://ws.audioscrobbler.com/2.0/", { ...parameters, api_key: apiKey, format: "json" });
  }
  return {
    album: (artist, album, id = "") => lastfm({ method: "album.getInfo", autocorrect: "0", ...(id ? { mbid: id } : { artist, album }) }),
    async recent(user, from, to) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(user) || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from <= 0 || to <= from || to - from > 86400) throw safeFailure("invalid_capture_window");
      const pages = []; let totalPages = null;
      for (let page = 1; page <= 20; page += 1) {
        const data = await lastfm({ method: "user.getRecentTracks", user, from: String(from - 1), to: String(to + 1), page: String(page), limit: "200" });
        if (data?.error || !data?.recenttracks || !/^[0-9]+$/.test(String(data.recenttracks["@attr"]?.totalPages))) throw safeFailure("malformed_recent_response");
        const count = Math.max(1, Number(data.recenttracks["@attr"].totalPages));
        if (totalPages !== null && count !== totalPages) throw safeFailure("pagination_changed_retry_window");
        totalPages = count; pages.push(data);
        if (page >= count) return { complete: true, pages };
      }
      throw safeFailure("page_budget_exceeded");
    },
    async candidates(artist, title) {
      const escape = (value) => value.replace(/[\\"]/g, "\\$&");
      const query = `artist:"${escape(artist)}" AND release:"${escape(title)}"`;
      // Discovery is bounded, never an assertion that all editions have been inspected.
      return request("https://musicbrainz.org/ws/2/release/", { query, fmt: "json", limit: "25" });
    },
    async browseReleases(groupId) {
      if (!mbid(groupId)) throw safeFailure("invalid_release_group_mbid");
      const releases = []; let expectedCount = null;
      for (let offset = 0; offset < 600; offset += 100) {
        const data = await request("https://musicbrainz.org/ws/2/release/", { "release-group": groupId, inc: "media+artist-credits", fmt: "json", limit: "100", offset: String(offset) });
        if (!Array.isArray(data.releases) || !Number.isInteger(data["release-count"])) throw safeFailure("malformed_release_browse");
        if (expectedCount !== null && expectedCount !== data["release-count"]) throw safeFailure("release_browse_changed");
        expectedCount = data["release-count"]; releases.push(...data.releases);
        if (releases.length >= expectedCount) return { releases, complete: true, count: expectedCount };
        if (!data.releases.length) throw safeFailure("incomplete_release_browse");
      }
      return { releases, complete: false, count: expectedCount };
    },
    async release(id) {
      if (!mbid(id)) throw safeFailure("invalid_release_mbid");
      return request(`https://musicbrainz.org/ws/2/release/${id}`, { inc: "recordings+artist-credits+release-groups", fmt: "json" });
    },
  };
}

function referenceFromRelease(payload, edition, reviewer, fetchedAt) {
  if (!mbid(payload?.id) || !mbid(payload["release-group"]?.id) || !text(payload.title) || !reviewer.trim()) throw new Error("Invalid reference release or reviewer");
  const credit = (credits) => array(credits).map((c) => `${c.name || c.artist?.name || ""}${c.joinphrase || ""}`).join("");
  const artist = credit(payload["artist-credit"]);
  if (text(artist) !== text(edition.artist)) throw new Error("Reference artist differs from frozen sample; review cannot silently change the sample");
  const media = array(payload.media);
  if (!media.length || media.some((medium, index) => medium.position !== index + 1 || !Array.isArray(medium.tracks)
    || !medium.tracks.length || medium["track-count"] !== medium.tracks.length)) throw new Error("Incomplete media/track counts");
  const tracks = media.flatMap((medium) => medium.tracks.map((track, index) => {
    if (track.position !== index + 1 || !mbid(track.id) || !mbid(track.recording?.id)) throw new Error("Invalid release-track identity or position");
    const title = track.title || track.recording.title;
    const trackArtist = credit(track["artist-credit"] || track.recording["artist-credit"] || payload["artist-credit"]);
    if (!text(title) || !text(trackArtist)) throw new Error("Missing track title or artist");
    return { title, artist: trackArtist, disc: medium.position, position: track.position,
      releaseTrackMbid: track.id, recordingMbid: track.recording.id };
  }));
  return { verified: true, reviewer, reviewedAt: fetchedAt, fetchedAt, source: `https://musicbrainz.org/release/${payload.id}`,
    releaseMbid: payload.id, releaseGroupMbid: payload["release-group"].id, title: payload.title,
    queryTitle: edition.queryTitle, artist, tracks, license: "MusicBrainz core data: CC0" };
}
module.exports = { createClient, retryAfter, referenceFromRelease };
