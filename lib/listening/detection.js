const { safeError } = require("./common");
const { MATCHING_VERSION, countablePositions, mappingIndex, matchEvent } = require("./trackMatching");

// Versioned counting rule. Changes apply only to new sessions.
const RULES = Object.freeze({
  version: 1,
  matchingVersion: MATCHING_VERSION,
  gapMs: 2 * 60 * 60 * 1_000,
  maxSessionMs: 24 * 60 * 60 * 1_000,
  publishRecencyMs: 7 * 24 * 60 * 60 * 1_000,
});

const IDENTITY_FIELDS = ["artistMbid", "albumMbid", "trackMbid"];

function time(value) {
  const at = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(at) ? at : null;
}

function windowKey(window) {
  return window.windowId || new Date(window.start).toISOString();
}

function windowFor(windows, at) {
  return windows.find((window) => {
    const start = time(window.start);
    const end = window.end ? time(window.end) : Infinity;
    return start !== null && at >= start && at < end;
  }) || null;
}

function calendarDate(at, timeZone) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
  } catch {
    throw safeError("INVALID_TIME_ZONE");
  }
}

function count(diagnostics, reason) {
  diagnostics[reason] = (diagnostics[reason] || 0) + 1;
}

function asMap(value, keyOf) {
  if (value instanceof Map) return value;
  return new Map((value || []).map((item) => [keyOf(item), item]));
}

// Excludes unusable evidence and collapses duplicate deliveries. Duplicates that
// disagree on populated identifiers are kept once and marked as conflicting.
function retainedEvents(events, windows, evaluatedAt, diagnostics) {
  const unique = new Map();
  for (const event of events || []) {
    const at = time(event?.playedAt);
    if (event?.nowPlaying) { count(diagnostics, "now_playing"); continue; }
    if (at === null) { count(diagnostics, "invalid_event"); continue; }
    if (at > evaluatedAt) { count(diagnostics, "future_event"); continue; }
    if (event.expiresAt && time(event.expiresAt) <= evaluatedAt) { count(diagnostics, "evidence_expired"); continue; }
    const window = windowFor(windows, at);
    if (!window) { count(diagnostics, "outside_activation_window"); continue; }
    const key = event.identityKey || event.eventId;
    const previous = unique.get(key);
    if (previous) {
      count(diagnostics, "duplicate_delivery");
      if (IDENTITY_FIELDS.some((field) => previous.event[field] && event[field] && previous.event[field] !== event[field])) {
        previous.event = { ...previous.event, identityConflict: true };
      }
      continue;
    }
    unique.set(key, { key, at, event, window });
  }
  return [...unique.values()].sort((a, b) => a.at - b.at || String(a.key).localeCompare(String(b.key)));
}

function newPlay(ordinal) {
  return { ordinal, positions: new Set(), eventCount: 0, firstEventId: "", firstEventAt: null, lastEventAt: null, qualifiedAt: null, qualifyingEventId: "" };
}

// Credits one countable position using the replay rule: the earliest play that
// lacks it takes it; otherwise a new play opens only after the newest qualified.
function creditPosition(plays, trackId, entry, required) {
  let play = plays.find((candidate) => !candidate.positions.has(trackId));
  if (!play) {
    const newest = plays[plays.length - 1];
    if (newest && !newest.qualifiedAt) return null;
    play = newPlay(plays.length + 1);
    plays.push(play);
  }
  play.positions.add(trackId);
  play.eventCount += 1;
  if (!play.firstEventAt) { play.firstEventAt = entry.at; play.firstEventId = entry.event.eventId || entry.key; }
  play.lastEventAt = entry.at;
  if (!play.qualifiedAt && play.positions.size >= required) {
    play.qualifiedAt = entry.at;
    play.qualifyingEventId = entry.event.eventId || entry.key;
  }
  return play;
}

function openSession(entry, baseline, countable) {
  return {
    albumId: entry.match.albumId,
    windowKey: windowKey(entry.window),
    windowClosed: Boolean(entry.window.end),
    baseline,
    countable,
    countableSet: new Set(countable.countable),
    startedAt: entry.at,
    lastEventAt: entry.at,
    plays: [],
    mappings: new Map(),
    evidence: [],
  };
}

function addToSession(session, entry) {
  const { match } = entry;
  session.lastEventAt = entry.at;
  session.mappings.set(match.mappingId, match.mappingRevision);
  const evidence = { eventId: entry.event.eventId || entry.key, trackId: match.trackId, playedAt: new Date(entry.at), rules: match.rules, play: null, credit: "" };
  if (!session.countableSet.has(match.trackId)) evidence.credit = "excluded_position";
  else {
    const play = creditPosition(session.plays, match.trackId, entry, session.countable.required);
    evidence.credit = play ? "credited" : "repeat";
    evidence.play = play ? play.ordinal : null;
  }
  session.evidence.push(evidence);
}

function serializeSession(session, { evaluatedAt, rules, timeZone }) {
  const order = new Map(session.baseline.tracks.map((track, index) => [track.trackId, index]));
  const closed = session.superseded || session.windowClosed
    || evaluatedAt - session.lastEventAt > rules.gapMs
    || evaluatedAt - session.startedAt >= rules.maxSessionMs;
  const plays = session.plays.map((play) => ({
    ordinal: play.ordinal,
    positions: [...play.positions].sort((a, b) => order.get(a) - order.get(b)),
    distinct: play.positions.size,
    required: session.countable.required,
    eventCount: play.eventCount,
    firstEventId: play.firstEventId,
    firstEventAt: new Date(play.firstEventAt),
    lastEventAt: new Date(play.lastEventAt),
    qualifiedAt: play.qualifiedAt ? new Date(play.qualifiedAt) : null,
    qualifyingEventId: play.qualifyingEventId,
    coverage: play.qualifiedAt ? "qualified" : "below_threshold",
    ...(timeZone ? { proposedDate: calendarDate(play.firstEventAt, timeZone) } : {}),
  }));
  return {
    albumId: session.albumId,
    windowKey: session.windowKey,
    ruleVersion: rules.version,
    matchingVersion: rules.matchingVersion,
    baseline: { baselineId: session.baseline.baselineId, version: session.baseline.version ?? null, tracklistHash: session.baseline.tracklistHash },
    mappings: [...session.mappings].map(([mappingId, revision]) => ({ mappingId, revision })).sort((a, b) => a.mappingId.localeCompare(b.mappingId)),
    timeZone: timeZone || null,
    lifecycle: closed ? "closed" : "open",
    coverage: plays.some((play) => play.qualifiedAt) ? "qualified" : "below_threshold",
    startedAt: new Date(session.startedAt),
    lastEventAt: new Date(session.lastEventAt),
    countable: {
      total: session.countable.total,
      countable: session.countable.countable.length,
      required: session.countable.required,
      excluded: session.countable.excluded,
      diagnostic: session.countable.diagnostic,
    },
    plays,
    evidence: session.evidence,
  };
}

// Pure detection over one connection's retained events. The caller supplies the
// current mappings, reviewed baselines, activation windows, and evaluation time.
function detectSessions({ events, windows = [], mappings = [], baselines = [], evaluatedAt, timeZone = null, rules = RULES } = {}) {
  const now = time(evaluatedAt);
  if (now === null) throw safeError("INVALID_EVALUATION_TIME");
  if (timeZone) calendarDate(now, timeZone);
  const context = { mappings: mappings instanceof Map ? mappings : mappingIndex(mappings), baselines: asMap(baselines, (baseline) => baseline.albumId) };
  const diagnostics = {};
  const countableByAlbum = new Map();
  const partitions = new Map();

  for (const entry of retainedEvents(events, windows, now, diagnostics)) {
    const match = matchEvent(entry.event, context);
    if (match.status !== "matched") { count(diagnostics, match.status); continue; }
    if (!countableByAlbum.has(match.albumId)) countableByAlbum.set(match.albumId, countablePositions(context.baselines.get(match.albumId)));
    if (!countableByAlbum.get(match.albumId).eligible) { count(diagnostics, "baseline_uncountable"); continue; }
    count(diagnostics, "matched");
    const key = JSON.stringify([windowKey(entry.window), match.albumId]);
    partitions.set(key, [...(partitions.get(key) || []), { ...entry, match }]);
  }

  const sessions = [];
  for (const entries of partitions.values()) {
    let session = null;
    for (const entry of entries) {
      if (!session || entry.at - session.lastEventAt > rules.gapMs || entry.at - session.startedAt >= rules.maxSessionMs) {
        if (session) sessions.push({ ...session, superseded: true });
        const baseline = context.baselines.get(entry.match.albumId);
        session = openSession(entry, baseline, countableByAlbum.get(entry.match.albumId));
      }
      addToSession(session, entry);
    }
    if (session) sessions.push(session);
  }

  return {
    ruleVersion: rules.version,
    evaluatedAt: new Date(now),
    sessions: sessions
      .map((session) => serializeSession(session, { evaluatedAt: now, rules, timeZone }))
      .sort((a, b) => a.startedAt - b.startedAt || a.albumId.localeCompare(b.albumId)),
    diagnostics,
  };
}

module.exports = { RULES, calendarDate, detectSessions };
