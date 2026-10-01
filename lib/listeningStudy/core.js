const crypto = require("node:crypto");

const RULES = Object.freeze({ version: "1.0.0", threshold: 0.8, gapSeconds: 7200, maxSessionSeconds: 86400 });
const hash = (value) => crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const text = (value) => typeof value === "string" ? value.normalize("NFC").replace(/[‘’]/g, "'").replace(/\s+/gu, " ").trim().toLowerCase() : "";
const name = (value) => typeof value === "string" ? value : value?.name ?? value?.["#text"] ?? "";
const array = (value) => Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
const mbid = (value) => typeof value === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : "";

function normalizeAlbum(payload) {
  if (payload?.error) return { status: "provider_error", code: Number(payload.error) };
  const album = payload?.album;
  if (!album || !text(name(album.artist)) || !text(album.name)) return { status: "malformed" };
  const raw = array(album.tracks?.track);
  if (!raw.length) return { status: "missing_tracklist", artist: name(album.artist), title: album.name };
  if (raw.length > 1000 || raw.some((track) => !text(track.name) || !text(name(track.artist)))) return { status: "malformed" };
  const tracks = raw.map((track, index) => ({
    title: track.name, artist: name(track.artist), mbid: mbid(track.mbid),
    position: index + 1,
    // Preserve a rank disagreement for scoring rather than silently repairing it.
    rankValid: track["@attr"]?.rank === undefined || Number(track["@attr"].rank) === index + 1,
  }));
  return { status: "ok", title: album.name, artist: name(album.artist), mbid: mbid(album.mbid), tracks };
}

function normalizeRecent(payloads) {
  const events = new Map();
  const rejected = [];
  for (const payload of array(payloads)) {
    if (payload?.error || !payload?.recenttracks) throw new Error("Incomplete or invalid recent-track response");
    for (const row of array(payload.recenttracks.track)) {
      if (row["@attr"]?.nowplaying === "true" || row["@attr"]?.nowplaying === true) continue;
      const timestamp = String(row.date?.uts ?? "");
      const artist = name(row.artist); const title = row.name; const album = name(row.album);
      if (!/^\d{1,11}$/.test(timestamp) || Number(timestamp) <= 0 || !text(artist) || !text(title)) {
        rejected.push("invalid_track_or_timestamp"); continue;
      }
      const event = { timestamp: Number(timestamp), artist, title, album, albumMbid: mbid(row.album?.mbid), trackMbid: mbid(row.mbid) };
      // No documented event ID exists. Identical same-second events collapse conservatively.
      event.id = hash([event.timestamp, text(artist), text(title), text(album)]);
      const previous = events.get(event.id);
      if (previous && (previous.albumMbid !== event.albumMbid || previous.trackMbid !== event.trackMbid)) {
        previous.identityConflict = true;
      } else if (!previous) events.set(event.id, event);
    }
  }
  return { events: [...events.values()].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id)), rejected };
}

function compareAlbum(reference, result) {
  if (!reference?.verified || !reference.tracks?.length) return { status: "reference_missing", correct: false };
  if (result?.status === "not_applicable") return { status: "not_applicable", correct: false };
  if (!result || result.status === "unavailable") return { status: "incomplete", correct: false };
  const album = normalizeAlbum(result.payload);
  if (album.status !== "ok") return { status: album.status, correct: false };
  const expected = reference.tracks.map((t) => `${text(t.artist)}|${text(t.title)}`);
  const actual = album.tracks.map((t) => `${text(t.artist)}|${text(t.title)}`);
  const count = actual.length === expected.length;
  const membership = JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
  const order = JSON.stringify(actual) === JSON.stringify(expected) && album.tracks.every((t) => t.rankValid);
  const identity = text(album.artist) === text(reference.artist)
    && [reference.title, reference.queryTitle].some((title) => text(title) === text(album.title));
  return { status: "scored", correct: count && membership && order && identity, count, membership, order, identity,
    expectedCount: expected.length, actualCount: actual.length, returnedTitle: album.title, returnedMbid: album.mbid };
}

function trackPositions(event, edition) {
  if (event.identityConflict) return [];
  // Never fall back to text when both sides have conflicting identifiers.
  return edition.tracks.flatMap((track, index) => {
    if (event.trackMbid && track.mbid) return event.trackMbid === track.mbid ? [index] : [];
    return text(track.title) === text(event.title) && text(track.artist) === text(event.artist) ? [index] : [];
  });
}

function eventCandidates(event, editions) {
  if (!text(event.album) || event.identityConflict) return [];
  return editions.filter((edition) => {
    const titleMatches = edition.aliases.some((title) => text(title) === text(event.album));
    // A MusicBrainz ID is used only as an opaque, observed album-identity match here.
    const conflictingId = event.albumMbid && edition.mbid && event.albumMbid !== edition.mbid;
    return titleMatches && !conflictingId && trackPositions(event, edition).length === 1;
  });
}

function splitSessions(events) {
  const sessions = [];
  for (const event of [...events].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))) {
    const current = sessions.at(-1);
    if (!current || event.timestamp - current.at(-1).timestamp > RULES.gapSeconds
      || event.timestamp - current[0].timestamp >= RULES.maxSessionSeconds) sessions.push([event]);
    else current.push(event);
  }
  return sessions;
}

function evaluateSessions(events, editions, mode = "edition") {
  if (!["edition", "standard"].includes(mode)) throw new Error("Invalid evaluation mode");
  const groups = new Map(); const unresolved = [];
  for (const event of events) {
    const candidates = eventCandidates(event, editions);
    const pairs = new Set(candidates.map((e) => e.pairId));
    if (pairs.size !== 1) { unresolved.push({ eventId: event.id, reason: pairs.size ? "ambiguous_album" : "unmatched_track_or_album" }); continue; }
    const pairId = [...pairs][0];
    if (!groups.has(pairId)) groups.set(pairId, []);
    groups.get(pairId).push({ ...event, candidates: candidates.map((e) => e.id) });
  }
  const results = [];
  for (const [pairId, grouped] of groups) {
    for (const session of splitSessions(grouped)) {
      const pairEditions = editions.filter((e) => e.pairId === pairId);
      let target;
      let reason;
      if (mode === "standard") target = pairEditions.find((e) => e.kind === "standard");
      else {
        const common = pairEditions.filter((e) => session.every((event) => event.candidates.includes(e.id)));
        if (common.length === 1) target = common[0];
        else reason = common.length ? "ambiguous_edition" : "mixed_editions";
      }
      const covered = new Set();
      if (target) for (const event of session) {
        const positions = trackPositions(event, target);
        if (positions.length === 1) covered.add(positions[0]);
      }
      const required = target ? Math.ceil(RULES.threshold * target.tracks.length) : null;
      const status = !target ? "unresolved" : covered.size >= required ? "would_log" : "below_threshold";
      results.push({ sessionId: hash([RULES.version, mode, pairId, session.map((e) => e.id)]), pairId,
        editionId: target?.id || null, status, reason: reason || (!target ? "missing_standard_baseline" : null),
        firstTimestamp: session[0].timestamp, lastTimestamp: session.at(-1).timestamp,
        distinctTracks: covered.size, totalTracks: target?.tracks.length ?? null, required,
        eventIds: session.map((e) => e.id) });
    }
  }
  return { sessions: results.sort((a, b) => a.firstTimestamp - b.firstTimestamp), unresolved };
}

module.exports = { RULES, hash, text, name, array, mbid, normalizeAlbum, normalizeRecent, compareAlbum, evaluateSessions };
