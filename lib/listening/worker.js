const crypto = require("node:crypto");
const mongoose = require("mongoose");
const AlbumCatalog = require("../../models/AlbumCatalog");
const {
  Connection, AuthAttempt, Scrobble, MappingCase, AlbumMapping, Job, Detection, DetectionEvidence,
} = require("../../models/Listening");
const { normalize, mappingKey, baselineAvailable, flags, pilotAllowed, catalogRevisionOf, catalogRevisionFilter } = require("./common");
const { activeMappingStates } = require("./mappingRevisions");
const { createDiscoveryService } = require("./discovery");
const { createLastfmProvider } = require("./provider");
const { enqueueDetectionForExpiry, enqueueDetectionForMapping, reconcileConnection } = require("./reconciliation");

const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const OVERLAP_MS = 48 * 60 * 60 * 1_000;
const POLL_MS = 5 * 60 * 1_000;
const DEFAULT_LEASE_MS = 2 * 60 * 1_000;
const MAX_SYNC_PAGES = 1_000;
const MAX_SYNC_PAGES_PER_RUN = 10;
const MAX_REPROCESS_EVENTS_PER_RUN = 200;
const MAX_REPROCESS_CONNECTIONS_PER_RUN = 100;
const SYNC_CONTINUE_DELAY_MS = 1_000;
// The deep sweep refetches recently completed history for late, back-dated scrobbles.
const SWEEP_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1_000;
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const JOB_TYPES = new Set(["sync", "discovery", "reprocess", "cleanup", "detect", "sweep"]);
const IDENTITY_FIELDS = ["artistMbid", "albumMbid", "trackMbid"];
// Albums come from the reviewed text mapping, so only a disagreeing track ID
// makes an event ambiguous. Last.fm routinely swaps album IDs between releases.
const BLOCKING_IDENTITY_FIELDS = new Set(["trackMbid"]);

class WorkerError extends Error {
  constructor(code, options = {}) { super(code); this.name = "ListeningWorkerError"; this.code = code; this.retryable = options.retryable !== false; }
}

function date(value) {
  const result = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(result.getTime())) throw new WorkerError("invalid_job_window", { retryable: false });
  return result;
}

function identityKey(row) {
  return crypto.createHash("sha256").update(JSON.stringify([
    date(row.playedAt).toISOString(), normalize(row.artist), normalize(row.album), normalize(row.track),
  ])).digest("hex");
}

function inActivationWindow(connection, playedAt) {
  const at = date(playedAt).getTime();
  return (connection.windows || []).some((window) => {
    const start = date(window.start).getTime();
    const end = window.end ? date(window.end).getTime() : Infinity;
    return at >= start && at < end;
  });
}

async function enqueueJob(type, key, payload, options = {}) {
  if (!JOB_TYPES.has(type)) throw new TypeError("Invalid listening job type");
  const runAt = options.runAt ? date(options.runAt) : new Date();
  if (options.reopenDone) {
    await Job.updateOne(
      { key, status: "done" },
      { $set: { type, payload, status: "pending", runAt, leaseUntil: null, leaseToken: "", progress: {}, error: "", attempts: 0 } },
      { session: options.session },
    );
  }
  // A running job would miss this request; ask it to run once more instead.
  if (options.rerunRunning) await Job.updateOne({ key, status: "running" }, { $set: { "progress.rerun": true } }, { session: options.session });
  return Job.findOneAndUpdate(
    { key },
    { $setOnInsert: { key, type, payload, status: "pending", runAt, attempts: 0, progress: {}, error: "" } },
    { upsert: true, returnDocument: "after", session: options.session },
  );
}

async function acquireJob({ clock, leaseMs, types }) {
  const now = clock();
  const token = crypto.randomUUID();
  const query = {
    runAt: { $lte: now },
    ...(types?.length ? { type: { $in: types } } : {}),
    $or: [{ status: "pending" }, { status: "running", leaseUntil: { $lte: now } }],
  };
  return Job.findOneAndUpdate(query, {
    $set: { status: "running", leaseToken: token, leaseUntil: new Date(now.getTime() + leaseMs), error: "" },
    $inc: { attempts: 1 },
  }, { sort: { runAt: 1, createdAt: 1 }, returnDocument: "after" }).lean();
}

async function fencedUpdate(job, update, { clock, leaseMs }) {
  const current = clock();
  const document = await Job.findOneAndUpdate(
    { _id: job._id, status: "running", leaseToken: job.leaseToken, leaseUntil: { $gt: current } },
    { ...update, $set: { ...(update.$set || {}), leaseUntil: new Date(current.getTime() + leaseMs) } },
    { returnDocument: "after" },
  ).lean();
  if (!document) throw new WorkerError("job_lease_lost");
  Object.assign(job, document);
  return document;
}

async function defaultOwnerExists(userId) {
  const { clerkClient } = require("@clerk/express");
  try { await clerkClient.users.getUser(userId); return true; }
  catch (error) {
    if (error?.status === 404 || error?.statusCode === 404) return false;
    throw new WorkerError("owner_check_unavailable");
  }
}

async function resolveRow(row, session) {
  const artistKey = normalize(row.artist);
  const albumKey = normalize(row.album);
  if (!artistKey || !albumKey || !normalize(row.track)) return { resolution: "unavailable", artistKey, albumKey };
  const key = mappingKey(row.artist, row.album);
  const mapping = await AlbumMapping.findOne({ key, status: "active" }).session(session).lean();
  if (!mapping) return { resolution: "unresolved", artistKey, albumKey, key };
  const fenced = await AlbumMapping.updateOne(
    { _id: mapping._id, revision: mapping.revision, status: "active" },
    { $set: { workerFence: crypto.randomUUID() } },
    { session, timestamps: false },
  );
  if (fenced.matchedCount !== 1) throw new WorkerError("mapping_revision_changed");
  const album = await AlbumCatalog.findOne({ albumId: mapping.albumId, catalogRevision: catalogRevisionFilter(mapping.catalogRevision) }).session(session).lean();
  if (!album) return { resolution: "unavailable", artistKey, albumKey, key, mappingId: mapping.mappingId, mappingRevision: mapping.revision };
  return {
    resolution: "matched", artistKey, albumKey, key, albumId: album.albumId,
    mappingId: mapping.mappingId, mappingRevision: mapping.revision,
    catalogRevision: catalogRevisionOf(album), baselineAvailable: baselineAvailable(album, await require("../baselines/service").baselineForAlbum(album, { session })),
  };
}

async function persistPage({ connectionId, revision, rows, from, to, clock = () => new Date(), job, leaseMs, sessionFactory = () => mongoose.startSession() }) {
  const createdCases = new Map();
  const session = await sessionFactory();
  try {
    await session.withTransaction(async () => {
      const now = clock();
      const jobFence = await Job.updateOne(
        { _id: job._id, status: "running", leaseToken: job.leaseToken, leaseUntil: { $gt: now } },
        { $set: { leaseUntil: new Date(now.getTime() + leaseMs) } }, { session },
      );
      if (jobFence.matchedCount !== 1) throw new WorkerError("job_lease_lost");
      const connection = await Connection.findOne({ _id: connectionId, state: "active", revision }).session(session).lean();
      if (!connection) throw new WorkerError("connection_revision_changed", { retryable: false });
      const fenced = await Connection.updateOne(
        { _id: connectionId, state: "active", revision },
        { $set: { workerFence: crypto.randomUUID() } },
        { session },
      );
      if (fenced.matchedCount !== 1) throw new WorkerError("connection_revision_changed", { retryable: false });
      for (const row of rows) {
        if (row.nowPlaying || !row.playedAt) continue;
        const playedAt = date(row.playedAt);
        const expiresAt = new Date(playedAt.getTime() + RETENTION_MS);
        if (playedAt < from || playedAt > to || expiresAt <= now || !inActivationWindow(connection, playedAt)) continue;
        const resolved = await resolveRow(row, session);
        const result = await Scrobble.updateOne(
          { connectionId: connection._id, identityKey: identityKey(row) },
          { $setOnInsert: {
            eventId: crypto.randomUUID(), connectionId: connection._id, connectionRevision: revision,
            identityKey: identityKey(row), artist: row.artist || "", album: row.album || "", track: row.track || "",
            artistKey: resolved.artistKey, albumKey: resolved.albumKey, trackKey: normalize(row.track),
            artistMbid: row.artistMbid || "", albumMbid: row.albumMbid || "", trackMbid: row.trackMbid || "",
            playedAt, expiresAt, resolution: resolved.resolution,
            albumId: resolved.albumId || "", mappingId: resolved.mappingId || "",
            mappingRevision: resolved.mappingRevision ?? null, catalogRevision: resolved.catalogRevision ?? null,
            baselineAvailable: Boolean(resolved.baselineAvailable),
          } },
          { upsert: true, session },
        );
        const populated = IDENTITY_FIELDS.filter((field) => row[field]);
        if (result.upsertedCount !== 1 && populated.length) {
          // Keep the first delivery, but never let a disagreeing retry pass silently.
          const stored = await Scrobble.findOne({ connectionId: connection._id, identityKey: identityKey(row) })
            .select(IDENTITY_FIELDS.join(" ")).session(session).lean();
          const conflicting = populated.filter((field) => stored?.[field] && stored[field] !== row[field]);
          if (conflicting.length) {
            await Scrobble.updateOne(
              { _id: stored._id },
              {
                $addToSet: { identityConflictFields: { $each: conflicting } },
                ...(conflicting.some((field) => BLOCKING_IDENTITY_FIELDS.has(field)) ? { $set: { identityConflict: true } } : {}),
              },
              { session },
            );
          }
        }
        if (result.upsertedCount !== 1 || resolved.resolution !== "unresolved" || !resolved.key) continue;
        const mappingCase = await MappingCase.findOneAndUpdate(
          { key: resolved.key },
          { $setOnInsert: {
            caseId: crypto.randomUUID(), key: resolved.key, provider: "lastfm", artist: row.artist,
            album: row.album, artistKey: resolved.artistKey, albumKey: resolved.albumKey,
            normalizationVersion: 1, status: "pending", revision: 1,
          }, $inc: { encounterCount: 1 } },
          { upsert: true, returnDocument: "after", session },
        ).lean();
        if (mappingCase.status === "pending") createdCases.set(mappingCase.key, mappingCase);
      }
      for (const mappingCase of createdCases.values()) {
        await enqueueJob("discovery", `discovery:${mappingCase.key}:${mappingCase.revision}`, { caseId: mappingCase.caseId, key: mappingCase.key }, { session });
      }
      const commitNow = clock();
      const commitFence = await Job.updateOne(
        { _id: job._id, status: "running", leaseToken: job.leaseToken, leaseUntil: { $gt: commitNow } },
        { $set: { leaseUntil: new Date(commitNow.getTime() + leaseMs) } },
        { session },
      );
      if (commitFence.matchedCount !== 1) throw new WorkerError("job_lease_lost");
    });
  } finally { await session.endSession(); }
  return { insertedCases: [...createdCases.keys()] };
}

function syncWindow(connection, now) {
  const horizon = new Date(now.getTime() - RETENTION_MS);
  const connectedAt = date(connection.connectedAt);
  const desired = connection.completedThrough ? new Date(date(connection.completedThrough).getTime() - OVERLAP_MS) : connectedAt;
  const from = new Date(Math.max(desired.getTime(), connectedAt.getTime(), horizon.getTime()));
  const retentionGap = desired < horizon ? { from: desired, to: horizon } : null;
  return { from, to: now, retentionGap };
}

function detectionAllowed(connection, env) {
  return flags(env).detection && pilotAllowed(connection.userId, env);
}

// Fetches the job's fixed window page by page. Returns a continuation while
// pages remain, or null once the whole window has been persisted.
async function fetchWindowPages(job, context, connection, initialProgress) {
  let progress = initialProgress;
  const from = date(progress.window.from);
  const to = date(progress.window.to);
  let page = Number(progress.nextPage || 1);
  let expectedPages = progress.totalPages === null || progress.totalPages === undefined ? null : Number(progress.totalPages);
  let processedPages = 0;
  do {
    await fencedUpdate(job, { $set: {} }, context);
    const response = await context.provider.recentTracks({ username: connection.username, from, to, page, limit: 200 });
    if (response.totalPages > MAX_SYNC_PAGES) throw new WorkerError("lastfm_page_limit_exceeded", { retryable: false });
    if (expectedPages !== null && response.totalPages !== expectedPages) {
      progress = { window: progress.window, nextPage: 1, totalPages: null };
      await fencedUpdate(job, { $set: { progress } }, context);
      throw new WorkerError("lastfm_pagination_changed");
    }
    expectedPages = response.totalPages;
    await persistPage({ connectionId: connection._id, revision: connection.revision, rows: response.tracks, from, to, clock: context.clock, job, leaseMs: context.leaseMs, sessionFactory: context.sessionFactory });
    page += 1;
    processedPages += 1;
    progress = { window: progress.window, nextPage: page, totalPages: expectedPages };
    await fencedUpdate(job, { $set: { progress } }, context);
  } while (page <= Math.max(1, expectedPages) && processedPages < MAX_SYNC_PAGES_PER_RUN);
  if (page <= Math.max(1, expectedPages)) {
    return { pending: true, runAt: new Date(context.clock().getTime() + SYNC_CONTINUE_DELAY_MS) };
  }
  return null;
}

// Late-scrobble window: the trailing lookback up to the last completed sync.
// It never extends past `completedThrough`, so regular sync keeps ownership of
// the cursor.
function sweepWindow(connection, now) {
  if (!connection.completedThrough) return null;
  const to = date(connection.completedThrough);
  const from = new Date(Math.max(now.getTime() - SWEEP_LOOKBACK_MS, date(connection.connectedAt).getTime(), now.getTime() - RETENTION_MS));
  return from < to ? { from, to } : null;
}

async function sweepJob(job, context) {
  const connection = await Connection.findOne({ _id: job.payload.connectionId, state: "active", revision: job.payload.connectionRevision }).lean();
  if (!connection || !pilotAllowed(connection.userId, context.env)) return;
  let progress = job.progress?.window ? job.progress : null;
  if (!progress) {
    const window = sweepWindow(connection, context.clock());
    if (!window) return;
    progress = { window: { from: window.from.toISOString(), to: window.to.toISOString() }, nextPage: 1, totalPages: null };
    await fencedUpdate(job, { $set: { progress } }, context);
  }
  const pending = await fetchWindowPages(job, context, connection, progress);
  if (pending) return pending;
  const detect = detectionAllowed(connection, context.env);
  const session = await context.sessionFactory();
  try {
    await session.withTransaction(async () => {
      const finishedAt = context.clock();
      const jobFence = await Job.updateOne(
        { _id: job._id, status: "running", leaseToken: job.leaseToken, leaseUntil: { $gt: finishedAt } },
        { $set: { leaseUntil: new Date(finishedAt.getTime() + context.leaseMs) } }, { session },
      );
      if (jobFence.matchedCount !== 1) throw new WorkerError("job_lease_lost");
      const updated = await Connection.updateOne({ _id: connection._id, state: "active", revision: connection.revision }, { $set: { lastSweepAt: finishedAt } }, { session });
      if (updated.matchedCount !== 1) throw new WorkerError("connection_revision_changed", { retryable: false });
      if (detect) await enqueueJob("detect", `detect:${connection._id}`, { connectionId: String(connection._id) }, { reopenDone: true, rerunRunning: true, runAt: finishedAt, session });
      const commitNow = context.clock();
      const commitFence = await Job.updateOne(
        { _id: job._id, status: "running", leaseToken: job.leaseToken, leaseUntil: { $gt: commitNow } },
        { $set: { leaseUntil: new Date(commitNow.getTime() + context.leaseMs) } }, { session },
      );
      if (commitFence.matchedCount !== 1) throw new WorkerError("job_lease_lost");
    });
  } finally { await session.endSession(); }
}

async function detectJob(job, context) {
  const connection = await Connection.findOne({ _id: job.payload.connectionId, state: { $in: ["active", "paused"] } }).select("userId").lean();
  if (!connection || !pilotAllowed(connection.userId, context.env)) return;
  const session = await context.sessionFactory();
  try {
    await session.withTransaction(async () => {
      const current = context.clock();
      const jobFence = await Job.updateOne(
        { _id: job._id, status: "running", leaseToken: job.leaseToken, leaseUntil: { $gt: current } },
        { $set: { leaseUntil: new Date(current.getTime() + context.leaseMs) } }, { session },
      );
      if (jobFence.matchedCount !== 1) throw new WorkerError("job_lease_lost");
      await reconcileConnection({ connectionId: connection._id, clock: context.clock, session, env: context.env });
      const commitNow = context.clock();
      const commitFence = await Job.updateOne(
        { _id: job._id, status: "running", leaseToken: job.leaseToken, leaseUntil: { $gt: commitNow } },
        { $set: { leaseUntil: new Date(commitNow.getTime() + context.leaseMs) } }, { session },
      );
      if (commitFence.matchedCount !== 1) throw new WorkerError("job_lease_lost");
    });
  } finally { await session.endSession(); }
}

async function syncJob(job, context) {
  const connection = await Connection.findOne({ _id: job.payload.connectionId, state: "active", revision: job.payload.connectionRevision }).lean();
  if (!connection) return;
  if (!pilotAllowed(connection.userId, context.env)) {
    await Connection.updateOne(
      { _id: connection._id, state: "active", revision: connection.revision },
      { $set: { state: "paused", nextSyncAt: null, "windows.$[window].end": context.clock(), error: { code: "pilot_access_removed", at: context.clock() } }, $inc: { revision: 1 } },
      { arrayFilters: [{ "window.end": null }] },
    );
    return;
  }
  if (!(await context.ownerExists(connection.userId))) {
    const changed = await Connection.findOneAndUpdate({ _id: connection._id, state: "active", revision: connection.revision }, {
      $set: { state: "disconnected", nextSyncAt: null, "windows.$[window].end": context.clock() }, $inc: { revision: 1 },
    }, { arrayFilters: [{ "window.end": null }], returnDocument: "after" }).lean();
    if (changed) await enqueueJob("cleanup", `cleanup:${connection._id}:${changed.revision}`, { connectionId: String(connection._id), connectionRevision: changed.revision, userId: connection.userId });
    return;
  }
  let progress = job.progress?.window ? job.progress : null;
  if (!progress) {
    const window = syncWindow(connection, context.clock());
    progress = { window: { from: window.from.toISOString(), to: window.to.toISOString() }, nextPage: 1, totalPages: null };
    await fencedUpdate(job, { $set: { progress } }, context);
    if (window.retentionGap) await Connection.updateOne({ _id: connection._id, revision: connection.revision }, { $set: { retentionGap: window.retentionGap } });
  }
  let from = date(progress.window.from);
  const to = date(progress.window.to);
  const currentHorizon = new Date(context.clock().getTime() - RETENTION_MS);
  if (from < currentHorizon) {
    await Connection.updateOne(
      { _id: connection._id, state: "active", revision: connection.revision },
      { $set: { retentionGap: { from, to: currentHorizon } } },
    );
    from = currentHorizon;
    progress = { window: { from: from.toISOString(), to: to.toISOString() }, nextPage: 1, totalPages: null };
    await fencedUpdate(job, { $set: { progress } }, context);
  }
  const pending = await fetchWindowPages(job, context, connection, progress);
  if (pending) return pending;
  const detect = detectionAllowed(connection, context.env);
  const session = await context.sessionFactory();
  try {
    await session.withTransaction(async () => {
      const finishedAt = context.clock();
      const jobFence = await Job.updateOne(
        { _id: job._id, status: "running", leaseToken: job.leaseToken, leaseUntil: { $gt: finishedAt } },
        { $set: { leaseUntil: new Date(finishedAt.getTime() + context.leaseMs) } }, { session },
      );
      if (jobFence.matchedCount !== 1) throw new WorkerError("job_lease_lost");
      const updated = await Connection.updateOne({ _id: connection._id, state: "active", revision: connection.revision }, {
        $max: { completedThrough: to },
        $set: { lastSuccessfulSync: finishedAt, nextSyncAt: new Date(finishedAt.getTime() + POLL_MS), progress: {}, error: null },
        $pull: { windows: { end: { $lte: new Date(finishedAt.getTime() - RETENTION_MS) } } },
      }, { session });
      if (updated.matchedCount !== 1) throw new WorkerError("connection_revision_changed", { retryable: false });
      // Detection runs only over complete sync windows, never page by page.
      if (detect) await enqueueJob("detect", `detect:${connection._id}`, { connectionId: String(connection._id) }, { reopenDone: true, rerunRunning: true, runAt: finishedAt, session });
      const commitNow = context.clock();
      const commitFence = await Job.updateOne(
        { _id: job._id, status: "running", leaseToken: job.leaseToken, leaseUntil: { $gt: commitNow } },
        { $set: { leaseUntil: new Date(commitNow.getTime() + context.leaseMs) } }, { session },
      );
      if (commitFence.matchedCount !== 1) throw new WorkerError("job_lease_lost");
    });
  } finally { await session.endSession(); }
}

async function discoveryJob(job, context) {
  const mappingCase = await MappingCase.findOne({ caseId: job.payload.caseId, key: job.payload.key }).lean();
  if (!mappingCase || (mappingCase.status === "approved" && job.payload.allowApproved !== true)) return;
  const result = await context.discovery.discover({ artist: mappingCase.artist, album: mappingCase.album });
  const changedEvidence = Boolean(mappingCase.evidenceHash && mappingCase.evidenceHash !== result.evidenceHash);
  let nextStatus = mappingCase.status;
  if (!result.incomplete && mappingCase.status !== "approved") {
    if (["rejected", "no_catalog_match"].includes(mappingCase.status) && changedEvidence) nextStatus = "pending";
    else if (mappingCase.status === "pending" && !result.candidates.length) nextStatus = "no_catalog_match";
  }
  const nextCandidates = result.incomplete ? mappingCase.candidates : result.candidates;
  const nextEvidence = result.incomplete ? mappingCase.evidence : result.evidence;
  const nextEvidenceHash = result.incomplete ? mappingCase.evidenceHash : result.evidenceHash;
  const reviewContentChanged = nextStatus !== mappingCase.status
    || nextEvidenceHash !== mappingCase.evidenceHash
    || JSON.stringify(nextCandidates || []) !== JSON.stringify(mappingCase.candidates || [])
    || JSON.stringify(nextEvidence || []) !== JSON.stringify(mappingCase.evidence || []);
  const session = await context.sessionFactory();
  try {
    await session.withTransaction(async () => {
      const current = context.clock();
      const jobFence = await Job.updateOne(
        { _id: job._id, status: "running", leaseToken: job.leaseToken, leaseUntil: { $gt: current } },
        { $set: { leaseUntil: new Date(current.getTime() + context.leaseMs) } }, { session },
      );
      if (jobFence.matchedCount !== 1) throw new WorkerError("job_lease_lost");
      const update = await MappingCase.updateOne({ _id: mappingCase._id, revision: mappingCase.revision }, {
        $set: { candidates: nextCandidates, evidence: nextEvidence, evidenceHash: nextEvidenceHash, discoveryError: result.incomplete ? "provider_evidence_incomplete" : "", refreshedAt: current, status: nextStatus },
        ...(reviewContentChanged ? { $inc: { revision: 1 } } : {}),
      }, { session });
      if (update.matchedCount !== 1) throw new WorkerError("mapping_case_revision_changed", { retryable: false });
      const commitNow = context.clock();
      const commitFence = await Job.updateOne(
        { _id: job._id, status: "running", leaseToken: job.leaseToken, leaseUntil: { $gt: commitNow } },
        { $set: { leaseUntil: new Date(commitNow.getTime() + context.leaseMs) } }, { session },
      );
      if (commitFence.matchedCount !== 1) throw new WorkerError("job_lease_lost");
    });
  } finally { await session.endSession(); }
  if (result.incomplete) throw new WorkerError("discovery_incomplete");
}

async function reprocessJob(job, context) {
  const mapping = await AlbumMapping.findOne({ key: job.payload.key }).select("+workerFence").lean();
  if (!mapping || (job.payload.mappingRevision && mapping.revision !== job.payload.mappingRevision)) return;
  let progress = {
    connectionCursor: job.progress?.connectionCursor || null,
    currentConnectionId: job.progress?.currentConnectionId || null,
    eventCursor: job.progress?.eventCursor || null,
  };
  let processedEvents = 0;
  let scannedConnections = 0;
  while (true) {
    let connection = progress.currentConnectionId
      ? await Connection.findOne({ _id: progress.currentConnectionId, state: "active" }).select("_id revision").lean()
      : null;
    if (!connection) {
      const query = { state: "active", ...(progress.connectionCursor ? { _id: { $gt: progress.connectionCursor } } : {}) };
      connection = await Connection.findOne(query).sort({ _id: 1 }).select("_id revision").lean();
      progress.currentConnectionId = connection ? String(connection._id) : null;
      progress.eventCursor = null;
      if (connection) scannedConnections += 1;
    }
    if (!connection) {
      if (flags(context.env).detection) await enqueueDetectionForMapping(mapping, { enqueueJob, env: context.env, pilotAllowed, runAt: context.clock() });
      break;
    }
    const eventQuery = {
      connectionId: connection._id,
      artistKey: mapping.artistKey,
      albumKey: mapping.albumKey,
      // Reprocessing is allowed to re-evaluate retained events with a real
      // normalized track identity. Rows with missing/blank track metadata are
      // preserved as unavailable evidence and must never become matched just
      // because their album mapping was approved later.
      trackKey: { $exists: true, $ne: "" },
      expiresAt: { $gt: context.clock() },
      ...(progress.eventCursor ? { _id: { $gt: progress.eventCursor } } : {}),
    };
    const events = await Scrobble.find(eventQuery).sort({ _id: 1 }).select("_id").limit(200).lean();
    if (!events.length) {
      progress = { connectionCursor: String(connection._id), currentConnectionId: null, eventCursor: null };
      await fencedUpdate(job, { $set: { progress } }, context);
      if (scannedConnections >= MAX_REPROCESS_CONNECTIONS_PER_RUN) {
        return { pending: true, runAt: new Date(context.clock().getTime() + SYNC_CONTINUE_DELAY_MS) };
      }
      continue;
    }
    await fencedUpdate(job, { $set: {} }, context);
    const session = await context.sessionFactory();
    let active = true;
    try {
      await session.withTransaction(async () => {
        const current = context.clock();
        const jobFence = await Job.updateOne(
          { _id: job._id, status: "running", leaseToken: job.leaseToken, leaseUntil: { $gt: current } },
          { $set: { leaseUntil: new Date(current.getTime() + context.leaseMs) } }, { session },
        );
        if (jobFence.matchedCount !== 1) throw new WorkerError("job_lease_lost");
        const currentMapping = await AlbumMapping.findOne({ key: job.payload.key, revision: mapping.revision }).select("+workerFence").session(session).lean();
        if (!currentMapping) throw new WorkerError("mapping_revision_changed");
        const mappingFence = await AlbumMapping.updateOne(
          { _id: currentMapping._id, revision: currentMapping.revision, status: currentMapping.status },
          { $set: { workerFence: crypto.randomUUID() } }, { session, timestamps: false },
        );
        const connectionFence = await Connection.updateOne(
          { _id: connection._id, state: "active", revision: connection.revision },
          { $set: { workerFence: crypto.randomUUID() } }, { session, timestamps: false },
        );
        if (mappingFence.matchedCount !== 1) throw new WorkerError("mapping_revision_changed");
        if (connectionFence.matchedCount !== 1) { active = false; return; }
        const catalog = currentMapping.status === "active"
          ? await AlbumCatalog.findOne({ albumId: currentMapping.albumId, catalogRevision: catalogRevisionFilter(currentMapping.catalogRevision) }).session(session).lean() : null;
        const target = currentMapping.status === "active" && catalog ? {
          resolution: "matched", albumId: currentMapping.albumId, mappingId: currentMapping.mappingId, mappingRevision: currentMapping.revision,
          catalogRevision: currentMapping.catalogRevision, baselineAvailable: baselineAvailable(catalog, await require("../baselines/service").baselineForAlbum(catalog, { session })),
        } : currentMapping.status === "active" ? {
          resolution: "unavailable", albumId: "", mappingId: currentMapping.mappingId, mappingRevision: currentMapping.revision,
          catalogRevision: null, baselineAvailable: false,
        } : { resolution: "unresolved", albumId: "", mappingId: "", mappingRevision: null, catalogRevision: null, baselineAvailable: false };
        await Scrobble.updateMany({ _id: { $in: events.map((row) => row._id) } }, { $set: target }, { session });
        const commitNow = context.clock();
        const commitFence = await Job.updateOne(
          { _id: job._id, status: "running", leaseToken: job.leaseToken, leaseUntil: { $gt: commitNow } },
          { $set: { leaseUntil: new Date(commitNow.getTime() + context.leaseMs) } }, { session },
        );
        if (commitFence.matchedCount !== 1) throw new WorkerError("job_lease_lost");
      });
    } finally { await session.endSession(); }
    progress = active
      ? { connectionCursor: progress.connectionCursor, currentConnectionId: String(connection._id), eventCursor: String(events[events.length - 1]._id) }
      : { connectionCursor: String(connection._id), currentConnectionId: null, eventCursor: null };
    await fencedUpdate(job, { $set: { progress } }, context);
    processedEvents += events.length;
    if (processedEvents >= MAX_REPROCESS_EVENTS_PER_RUN) {
      return { pending: true, runAt: new Date(context.clock().getTime() + SYNC_CONTINUE_DELAY_MS) };
    }
  }
}

async function cleanupJob(job, context) {
  const connectionId = job.payload.connectionId;
  const session = await context.sessionFactory();
  try {
    await session.withTransaction(async () => {
      const current = context.clock();
      const jobFence = await Job.updateOne(
        { _id: job._id, status: "running", leaseToken: job.leaseToken, leaseUntil: { $gt: current } },
        { $set: { leaseUntil: new Date(current.getTime() + context.leaseMs) } }, { session },
      );
      if (jobFence.matchedCount !== 1) throw new WorkerError("job_lease_lost");
      const connection = await Connection.findOne({ _id: connectionId, state: "disconnected", revision: job.payload.connectionRevision }).session(session).lean();
      if (!connection) return;
      await Scrobble.deleteMany({ connectionId }, { session });
      await Detection.deleteMany({ connectionId }, { session });
      await DetectionEvidence.deleteMany({ connectionId }, { session });
      await AuthAttempt.deleteMany({ userId: job.payload.userId }, { session });
      await Job.updateMany(
        { _id: { $ne: job._id }, "payload.connectionId": String(connectionId) },
        { $set: { payload: {}, progress: {}, error: "" } },
        { session },
      );
      await Connection.deleteOne({ _id: connectionId, state: "disconnected", revision: job.payload.connectionRevision }, { session });
      const commitNow = context.clock();
      const commitFence = await Job.updateOne(
        { _id: job._id, status: "running", leaseToken: job.leaseToken, leaseUntil: { $gt: commitNow } },
        { $set: { leaseUntil: new Date(commitNow.getTime() + context.leaseMs) } }, { session },
      );
      if (commitFence.matchedCount !== 1) throw new WorkerError("job_lease_lost");
    });
  } finally { await session.endSession(); }
  job.payload = {};
}

async function scheduleDueSyncJobs({ clock = () => new Date(), env = process.env } = {}) {
  if (!flags(env).sync) return 0;
  const now = clock();
  const allowedUsers = String(env.LASTFM_PILOT_USER_IDS || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!allowedUsers.length) return 0;
  const connections = await Connection.find({ userId: { $in: allowedUsers }, state: "active", $or: [{ nextSyncAt: null }, { nextSyncAt: { $lte: now } }] }).select("_id revision").limit(1_000).lean();
  for (const connection of connections) await enqueueJob(
    "sync", `sync:${connection._id}`,
    { connectionId: String(connection._id), connectionRevision: connection.revision },
    { reopenDone: true, runAt: now },
  );
  return connections.length;
}

async function scheduleDueSweepJobs({ clock = () => new Date(), env = process.env } = {}) {
  const configured = flags(env);
  if (!configured.sync || !configured.deepSweep) return 0;
  const now = clock();
  const allowedUsers = String(env.LASTFM_PILOT_USER_IDS || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!allowedUsers.length) return 0;
  const connections = await Connection.find({
    userId: { $in: allowedUsers }, state: "active", completedThrough: { $ne: null },
    $or: [{ lastSweepAt: null }, { lastSweepAt: { $lte: new Date(now.getTime() - SWEEP_INTERVAL_MS) } }],
  }).select("_id revision").limit(1_000).lean();
  for (const connection of connections) await enqueueJob(
    "sweep", `sweep:${connection._id}`,
    { connectionId: String(connection._id), connectionRevision: connection.revision },
    { reopenDone: true, runAt: now },
  );
  return connections.length;
}

async function scheduleDueDetectionJobs({ clock = () => new Date(), env = process.env } = {}) {
  if (!flags(env).detection) return 0;
  return enqueueDetectionForExpiry({ enqueueJob, env, pilotAllowed, now: clock() });
}

async function scheduleStaleMappingJobs({ clock = () => new Date() } = {}) {
  const stale = (await activeMappingStates()).filter((row) => row.stale);
  for (const mapping of stale) await enqueueJob("reprocess", `reprocess:stale:${mapping.key}:${mapping.revision}:${mapping.currentCatalogRevision || "missing"}`, { key: mapping.key, mappingId: mapping.mappingId, mappingRevision: mapping.revision }, { runAt: clock() });
  return stale.length;
}

async function runWorkerOnce(options = {}) {
  const clock = options.clock || (() => new Date());
  const leaseMs = options.leaseMs || DEFAULT_LEASE_MS;
  const provider = options.provider || createLastfmProvider(options.providerOptions);
  const context = {
    clock, leaseMs, env: options.env || process.env,
    ownerExists: options.ownerExists || defaultOwnerExists,
    provider,
    discovery: options.discovery || createDiscoveryService({ provider }),
    sessionFactory: options.sessionFactory || (() => mongoose.startSession()),
  };
  const configured = flags(context.env);
  const enabledTypes = new Set(["cleanup", "reprocess"]);
  if (configured.sync) enabledTypes.add("sync");
  if (configured.discovery) enabledTypes.add("discovery");
  if (configured.detection) enabledTypes.add("detect");
  if (configured.sync && configured.deepSweep) enabledTypes.add("sweep");
  const requestedTypes = options.types?.length ? options.types : [...enabledTypes];
  const allowedTypes = requestedTypes.filter((type) => enabledTypes.has(type));
  if (!allowedTypes.length) return { processed: false };
  // Deep sweeps yield to every other job so they never delay regular sync.
  const primaryTypes = allowedTypes.filter((type) => type !== "sweep");
  let job = primaryTypes.length ? await acquireJob({ clock, leaseMs, types: primaryTypes }) : null;
  if (!job && allowedTypes.includes("sweep")) job = await acquireJob({ clock, leaseMs, types: ["sweep"] });
  if (!job) return { processed: false };
  try {
    let outcome;
    if (job.type === "sync") outcome = await syncJob(job, context);
    else if (job.type === "discovery") outcome = await discoveryJob(job, context);
    else if (job.type === "reprocess") outcome = await reprocessJob(job, context);
    else if (job.type === "cleanup") outcome = await cleanupJob(job, context);
    else if (job.type === "detect") outcome = await detectJob(job, context);
    else if (job.type === "sweep") outcome = await sweepJob(job, context);
    if (outcome?.pending) {
      const released = await Job.updateOne(
        { _id: job._id, status: "running", leaseToken: job.leaseToken, leaseUntil: { $gt: clock() } },
        { $set: { status: "pending", runAt: outcome.runAt || clock(), leaseToken: "", leaseUntil: null, attempts: 0, error: "" } },
      );
      if (released.modifiedCount !== 1) throw new WorkerError("job_lease_lost");
      return { processed: true, type: job.type, key: job.key, status: "pending" };
    }
    const rerun = await Job.updateOne(
      { _id: job._id, status: "running", leaseToken: job.leaseToken, leaseUntil: { $gt: clock() }, "progress.rerun": true },
      { $set: { status: "pending", runAt: clock(), leaseToken: "", leaseUntil: null, attempts: 0, progress: {}, error: "" } },
    );
    if (rerun.modifiedCount === 1) return { processed: true, type: job.type, key: job.key, status: "pending" };
    const completed = await Job.updateOne({ _id: job._id, status: "running", leaseToken: job.leaseToken, leaseUntil: { $gt: clock() } }, {
      $set: { status: "done", leaseToken: "", leaseUntil: null, progress: {}, payload: job.type === "cleanup" ? {} : job.payload, error: "" },
    });
    if (completed.modifiedCount !== 1) throw new WorkerError("job_lease_lost");
    return { processed: true, type: job.type, key: job.key, status: "done" };
  } catch (error) {
    const code = String(error?.code || "listening_job_failed").slice(0, 200);
    if (code !== "job_lease_lost") {
      const providerTransient = new Set([
        "lastfm_rate_limited", "lastfm_request_budget_exhausted", "lastfm_temporarily_unavailable",
        "lastfm_timeout", "lastfm_unavailable",
      ]).has(code);
      const retryable = (error?.retryable !== false || providerTransient) && !(job.type === "discovery" && job.attempts >= 5);
      const retryAt = new Date(clock().getTime() + Math.min(60_000 * (2 ** Math.min(job.attempts, 6)), 60 * 60 * 1_000));
      const failed = await Job.updateOne({
        _id: job._id, status: "running", leaseToken: job.leaseToken, leaseUntil: { $gt: clock() },
      }, {
        $set: {
          status: retryable ? "pending" : "done", runAt: retryAt, leaseToken: "", leaseUntil: null,
          progress: retryable ? job.progress : {}, error: code,
        },
      });
      if (failed.modifiedCount !== 1) return { processed: true, type: job.type, key: job.key, status: "error", error: "job_lease_lost" };
      if (job.type === "sync") await Connection.updateOne(
        { _id: job.payload.connectionId, revision: job.payload.connectionRevision },
        { $set: { error: { code, at: clock() }, ...(retryable ? {} : { nextSyncAt: retryAt }) } },
      );
      if (job.type === "discovery") await MappingCase.updateOne({ caseId: job.payload.caseId }, { $set: { discoveryError: code, refreshedAt: clock() } });
    }
    return { processed: true, type: job.type, key: job.key, status: "error", error: code };
  }
}

module.exports = {
  DEFAULT_LEASE_MS, MAX_REPROCESS_EVENTS_PER_RUN, MAX_SYNC_PAGES, MAX_SYNC_PAGES_PER_RUN, OVERLAP_MS, POLL_MS, RETENTION_MS, WorkerError,
  SWEEP_INTERVAL_MS, SWEEP_LOOKBACK_MS,
  enqueueJob, identityKey, inActivationWindow, persistPage, runWorkerOnce,
  scheduleDueDetectionJobs, scheduleDueSweepJobs, scheduleDueSyncJobs, scheduleStaleMappingJobs, sweepWindow, syncWindow,
};
