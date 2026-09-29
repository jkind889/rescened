const crypto = require("node:crypto");
const AlbumCatalog = require("../../models/AlbumCatalog");
const { Connection, Scrobble, AlbumMapping, Detection, DetectionEvidence } = require("../../models/Listening");
const { catalogRevisionOf, normalize } = require("./common");
const { RULES, calendarDate, detectSessions } = require("./detection");
const { publishConnection } = require("./publication");

const MAX_DETECTION_EVENTS = 50_000;
// Expired detections stay visible to the owner for this long after their last evidence expires.
const EXPIRED_VISIBLE_MS = 30 * 24 * 60 * 60 * 1_000;

class ReconciliationError extends Error {
  constructor(code, options = {}) { super(code); this.name = "ListeningReconciliationError"; this.code = code; this.retryable = options.retryable !== false; }
}

function time(value) { return value ? new Date(value).getTime() : null; }
function eventIdsOf(session) { return [...new Set(session.evidence.map((item) => item.eventId))]; }

// The date coverage would drop below the threshold as credited evidence expires.
function playEvidenceExpiry(session, play, retained) {
  if (!play.qualifiedAt) return null;
  const expiries = session.evidence
    .filter((item) => item.credit === "credited" && item.play === play.ordinal)
    .map((item) => time(retained.get(item.eventId)?.expiresAt))
    .filter((value) => value !== null)
    .sort((a, b) => a - b);
  const index = play.distinct - play.required;
  return index >= 0 && index < expiries.length ? new Date(expiries[index]) : null;
}

function frozenMismatch(stored, fresh) {
  if (stored.ruleVersion !== fresh.ruleVersion || stored.matchingVersion !== fresh.matchingVersion) return "stale_rule";
  if (stored.baseline?.baselineId !== fresh.baseline.baselineId || (stored.baseline?.version ?? null) !== (fresh.baseline.version ?? null)
    || stored.baseline?.tracklistHash !== fresh.baseline.tracklistHash) return "stale_baseline";
  return null;
}

function publishedPlays(stored) { return (stored.plays || []).filter((play) => play.publishedAt); }

// A published play is a fixed boundary: the recomputed play at the same ordinal
// must still start with the same event and remain qualified.
function preservesPublished(stored, fresh) {
  return publishedPlays(stored).every((play) => {
    const next = fresh.plays[play.ordinal - 1];
    return next && next.qualifiedAt && next.firstEventId === play.firstEventId;
  });
}

function qualifiedCount(sessions) {
  return sessions.reduce((total, session) => total + session.plays.filter((play) => play.qualifiedAt).length, 0);
}

function staleReason(stored, { retained, currentMappings, currentBaselines }) {
  if (!(stored.eventIds || []).some((eventId) => retained.has(eventId))) return "evidence_expired";
  const mappingsValid = (stored.mappings || []).every(({ mappingId }) => currentMappings.get(mappingId)?.albumId === stored.albumId);
  if (!mappingsValid) return "stale_mapping";
  const baseline = currentBaselines.get(stored.albumId);
  if (!baseline || baseline.baselineId !== stored.baseline?.baselineId || (baseline.version ?? null) !== (stored.baseline?.version ?? null)) return "stale_baseline";
  return "reconciliation_required";
}

function components(existing, fresh) {
  const nodes = [...existing.map((item) => ({ kind: "existing", item })), ...fresh.map((item) => ({ kind: "fresh", item }))];
  const parent = nodes.map((_, index) => index);
  const root = (index) => (parent[index] === index ? index : (parent[index] = root(parent[index])));
  const owners = new Map();
  nodes.forEach((node, index) => {
    const ids = node.kind === "existing" ? node.item.eventIds || [] : eventIdsOf(node.item);
    for (const eventId of ids) {
      // Only sessions for the same album share lineage.
      const key = JSON.stringify([node.item.albumId, eventId]);
      if (owners.has(key)) parent[root(index)] = root(owners.get(key));
      else owners.set(key, index);
    }
  });
  const groups = new Map();
  nodes.forEach((node, index) => {
    const group = groups.get(root(index)) || { existing: [], fresh: [] };
    group[node.kind].push(node.item);
    groups.set(root(index), group);
  });
  return [...groups.values()];
}

// Pure planning step. Returns the writes that bring stored detections in line
// with a fresh computation without moving, splitting, merging, or reinterpreting
// anything that must stay fixed.
function planReconciliation({ existing = [], fresh = [], retained = new Map(), currentMappings = new Map(), currentBaselines = new Map(), retentionGap = null, now = null, rules = RULES }) {
  const plan = { inserts: [], updates: [], holds: [], removals: [] };
  const gapHold = (session) => (retentionGap && time(session.startedAt) - rules.gapMs <= time(retentionGap.to) ? ["sync_incomplete"] : []);
  // A held session whose qualified evidence has lapsed is also marked expired.
  const lapsed = (stored) => now !== null && (stored.plays || []).some((play) => play.qualifiedAt && play.evidenceExpiresAt && time(play.evidenceExpiresAt) <= time(now));
  const hold = (stored, code) => plan.holds.push({ stored, holds: [...new Set([code, ...(lapsed(stored) ? ["evidence_expired"] : [])])].sort() });
  for (const { existing: stored, fresh: computed } of components(existing, fresh)) {
    if (!stored.length) {
      computed.forEach((session) => plan.inserts.push({ session, predecessorSessionIds: [], holds: gapHold(session) }));
      continue;
    }
    if (!computed.length) {
      stored.forEach((item) => hold(item, staleReason(item, { retained, currentMappings, currentBaselines })));
      continue;
    }
    const mismatch = stored.map((item) => frozenMismatch(item, computed[0])).find(Boolean);
    if (mismatch) { stored.forEach((item) => hold(item, mismatch)); continue; }
    if (stored.some((item) => publishedPlays(item).length)) {
      if (stored.length === 1 && computed.length === 1 && preservesPublished(stored[0], computed[0])) {
        plan.updates.push({ stored: stored[0], session: computed[0], holds: gapHold(computed[0]) });
      } else stored.forEach((item) => hold(item, "reconciliation_required"));
      continue;
    }
    const expired = stored.some((item) => (item.eventIds || []).some((eventId) => !retained.has(eventId)));
    if (expired && qualifiedCount(computed) < stored.reduce((total, item) => total + (item.plays || []).filter((play) => play.qualifiedAt).length, 0)) {
      stored.forEach((item) => hold(item, "evidence_expired"));
      continue;
    }
    if (stored.length === 1 && computed.length === 1) {
      plan.updates.push({ stored: stored[0], session: computed[0], holds: gapHold(computed[0]) });
      continue;
    }
    // Unpublished merge or split: replace with explicit lineage.
    const predecessors = stored.map((item) => item.sessionId).sort();
    plan.removals.push(...predecessors);
    computed.forEach((session) => plan.inserts.push({ session, predecessorSessionIds: predecessors, holds: gapHold(session) }));
  }
  return plan;
}

function detectionDocument(session, { sessionId, stored = null, predecessorSessionIds = [], holds = [], connection, evaluatedThrough, retained }) {
  const eventIds = eventIdsOf(session);
  const lastExpiry = Math.max(...eventIds.map((eventId) => time(retained.get(eventId)?.expiresAt) || 0));
  const window = (connection.windows || []).find((item) => new Date(item.start).toISOString() === session.windowKey)
    || { start: new Date(session.windowKey), end: null };
  // A session keeps the zone it was first dated in. Sessions from before any
  // zone was saved adopt the owner's first choice.
  const timeZone = stored?.timeZone || connection.timeZone || null;
  return {
    sessionId,
    userId: connection.userId,
    connectionId: connection._id,
    window: { start: window.start, end: window.end || null },
    windowKey: session.windowKey,
    albumId: session.albumId,
    baseline: session.baseline,
    ruleVersion: session.ruleVersion,
    matchingVersion: session.matchingVersion,
    countable: session.countable,
    mappings: session.mappings,
    timeZone,
    lifecycle: session.lifecycle,
    coverage: session.coverage,
    holds,
    startedAt: session.startedAt,
    lastEventAt: session.lastEventAt,
    plays: session.plays.map((play) => {
      const previous = stored?.plays?.[play.ordinal - 1];
      // Publication state follows the same play; the publication pass rederives it.
      const same = previous && previous.firstEventId === play.firstEventId;
      return {
        playId: previous?.playId || crypto.randomUUID(),
        ordinal: play.ordinal,
        distinct: play.distinct,
        required: play.required,
        eventCount: play.eventCount,
        firstEventId: play.firstEventId,
        firstEventAt: play.firstEventAt,
        lastEventAt: play.lastEventAt,
        qualifiedAt: play.qualifiedAt,
        qualifyingEventId: play.qualifyingEventId,
        coverage: play.coverage,
        proposedDate: timeZone ? calendarDate(play.firstEventAt, timeZone) : null,
        evidenceExpiresAt: playEvidenceExpiry(session, play, retained),
        publishedAt: previous?.publishedAt || null,
        listenId: same ? previous.listenId || null : null,
        publication: same ? previous.publication || null : null,
      };
    }),
    eventIds,
    predecessorSessionIds: stored ? stored.predecessorSessionIds || [] : predecessorSessionIds,
    evaluatedThrough,
    connectionRevision: connection.revision,
    processingRevision: stored ? Number(stored.processingRevision || 1) + 1 : 1,
    expiresAt: new Date(lastExpiry + EXPIRED_VISIBLE_MS),
  };
}

function evidenceDocuments(session, sessionId, connectionId, retained) {
  return session.evidence.map((item) => ({
    sessionId, connectionId, eventId: item.eventId, trackId: item.trackId, play: item.play, credit: item.credit,
    rules: item.rules, playedAt: item.playedAt, expiresAt: retained.get(item.eventId).expiresAt,
  }));
}

function canonical(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    if (typeof value.toHexString === "function") return value.toHexString();
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value ?? null;
}

// Fields that decide whether a stored detection actually changed.
function signature(document) {
  const { processingRevision, updatedAt, createdAt, _id, __v, evaluatedThrough, connectionRevision, ...rest } = document;
  return JSON.stringify(canonical(rest));
}

async function currentCatalogMappings(query, session) {
  const mappings = await AlbumMapping.find({ ...query, status: "active" }).session(session).lean();
  const albums = await AlbumCatalog.find({ albumId: { $in: [...new Set(mappings.map((row) => row.albumId))] } }).session(session).lean();
  const byAlbum = new Map(albums.map((album) => [album.albumId, album]));
  return {
    mappings: mappings.filter((row) => byAlbum.has(row.albumId) && catalogRevisionOf(byAlbum.get(row.albumId)) === row.catalogRevision),
    albums: byAlbum,
  };
}

async function reconcileConnection({ connectionId, clock = () => new Date(), session, rules = RULES, env = process.env }) {
  const now = clock();
  const connection = await Connection.findOne({ _id: connectionId, state: { $in: ["active", "paused"] } }).session(session).lean();
  if (!connection?.completedThrough) return { skipped: true };
  const fenced = await Connection.updateOne(
    { _id: connection._id, revision: connection.revision, state: connection.state },
    { $set: { workerFence: crypto.randomUUID() } }, { session, timestamps: false },
  );
  if (fenced.matchedCount !== 1) throw new ReconciliationError("connection_revision_changed");
  const evaluatedThrough = new Date(connection.completedThrough);

  const rows = await Scrobble.find({
    connectionId: connection._id, expiresAt: { $gt: now }, playedAt: { $lte: evaluatedThrough }, trackKey: { $exists: true, $ne: "" },
  }).select("eventId identityKey artist album track artistMbid albumMbid trackMbid playedAt expiresAt identityConflict artistKey albumKey")
    .sort({ playedAt: 1, _id: 1 }).limit(MAX_DETECTION_EVENTS + 1).session(session).lean();
  if (rows.length > MAX_DETECTION_EVENTS) throw new ReconciliationError("detection_event_limit", { retryable: false });
  const retained = new Map(rows.map((row) => [row.eventId, row]));
  const existing = await Detection.find({ connectionId: connection._id }).session(session).lean();

  const keys = [...new Set(rows.map((row) => JSON.stringify(["lastfm", normalize(row.artistKey), normalize(row.albumKey)])))];
  const storedMappingIds = [...new Set(existing.flatMap((item) => (item.mappings || []).map((mapping) => mapping.mappingId)))];
  const { mappings, albums } = await currentCatalogMappings({ $or: [{ key: { $in: keys } }, { mappingId: { $in: storedMappingIds } }] }, session);
  for (const albumId of new Set(existing.map((item) => item.albumId))) {
    if (!albums.has(albumId)) {
      const album = await AlbumCatalog.findOne({ albumId }).session(session).lean();
      if (album) albums.set(albumId, album);
    }
  }
  const { baselineForAlbum } = require("../baselines/service");
  const currentBaselines = new Map();
  for (const album of albums.values()) {
    const baseline = await baselineForAlbum(album, { session });
    if (baseline?.tracks?.length) currentBaselines.set(album.albumId, baseline);
  }

  const fresh = detectSessions({
    events: rows, windows: connection.windows || [], mappings, baselines: [...currentBaselines.values()], evaluatedAt: evaluatedThrough, rules,
  });
  const plan = planReconciliation({
    existing, fresh: fresh.sessions, retained, currentMappings: new Map(mappings.map((row) => [row.mappingId, row])), currentBaselines,
    retentionGap: connection.retentionGap, now, rules,
  });

  const summary = { inserted: 0, updated: 0, held: 0, removed: plan.removals.length, diagnostics: fresh.diagnostics };
  if (plan.removals.length) {
    await Detection.deleteMany({ connectionId: connection._id, sessionId: { $in: plan.removals } }, { session });
    await DetectionEvidence.deleteMany({ connectionId: connection._id, sessionId: { $in: plan.removals } }, { session });
  }
  for (const { session: computed, predecessorSessionIds, holds } of plan.inserts) {
    const sessionId = crypto.randomUUID();
    await Detection.create([detectionDocument(computed, { sessionId, predecessorSessionIds, holds, connection, evaluatedThrough, retained })], { session });
    await DetectionEvidence.insertMany(evidenceDocuments(computed, sessionId, connection._id, retained), { session });
    summary.inserted += 1;
  }
  for (const { stored, session: computed, holds } of plan.updates) {
    const document = detectionDocument(computed, { sessionId: stored.sessionId, stored, holds, connection, evaluatedThrough, retained });
    if (signature(document) === signature({ ...stored, processingRevision: document.processingRevision })) continue;
    const updated = await Detection.updateOne(
      { sessionId: stored.sessionId, processingRevision: stored.processingRevision },
      { $set: document }, { session },
    );
    if (updated.matchedCount !== 1) throw new ReconciliationError("detection_revision_changed");
    await DetectionEvidence.deleteMany({ sessionId: stored.sessionId }, { session });
    await DetectionEvidence.insertMany(evidenceDocuments(computed, stored.sessionId, connection._id, retained), { session });
    summary.updated += 1;
  }
  for (const { stored, holds } of plan.holds) {
    if (JSON.stringify(stored.holds || []) === JSON.stringify(holds)) continue;
    const updated = await Detection.updateOne(
      { sessionId: stored.sessionId, processingRevision: stored.processingRevision },
      { $set: { holds, evaluatedThrough }, $inc: { processingRevision: 1 } }, { session },
    );
    if (updated.matchedCount !== 1) throw new ReconciliationError("detection_revision_changed");
    summary.held += 1;
  }
  // Publication sees exactly the detections written above, in the same transaction.
  summary.published = (await publishConnection({ connectionId: connection._id, session, now, env, rules })).published;
  return summary;
}

// Queues detection for every retained-event owner of a mapping key, including
// paused connections, whose previews must also be revalidated.
// Time alone can expire evidence, including on paused connections with no sync.
async function enqueueDetectionForExpiry({ enqueueJob, env, pilotAllowed, now }) {
  const connectionIds = await Detection.distinct("connectionId", { holds: { $ne: "evidence_expired" }, "plays.evidenceExpiresAt": { $lte: now } });
  const connections = await Connection.find({ _id: { $in: connectionIds }, state: { $in: ["active", "paused"] } }).select("_id userId").lean();
  let queued = 0;
  for (const connection of connections) {
    if (!pilotAllowed(connection.userId, env)) continue;
    await enqueueJob("detect", `detect:${connection._id}`, { connectionId: String(connection._id) }, { reopenDone: true, rerunRunning: true, runAt: now });
    queued += 1;
  }
  return queued;
}

async function enqueueDetectionForMapping(mapping, { enqueueJob, env, pilotAllowed, runAt, session }) {
  const connectionIds = await Scrobble.distinct("connectionId", { artistKey: mapping.artistKey, albumKey: mapping.albumKey });
  const connections = await Connection.find({ _id: { $in: connectionIds }, state: { $in: ["active", "paused"] } }).select("_id userId").lean();
  let queued = 0;
  for (const connection of connections) {
    if (!pilotAllowed(connection.userId, env)) continue;
    await enqueueJob("detect", `detect:${connection._id}`, { connectionId: String(connection._id) }, { reopenDone: true, rerunRunning: true, runAt, session });
    queued += 1;
  }
  return queued;
}

module.exports = {
  EXPIRED_VISIBLE_MS, MAX_DETECTION_EVENTS, ReconciliationError,
  enqueueDetectionForExpiry, enqueueDetectionForMapping, planReconciliation, playEvidenceExpiry, reconcileConnection,
};
