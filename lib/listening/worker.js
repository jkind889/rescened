const crypto = require("node:crypto");
const mongoose = require("mongoose");
const AlbumCatalog = require("../../models/AlbumCatalog");
const {
  Connection, AuthAttempt, Scrobble, MappingCase, AlbumMapping, Job, CatalogScan, Detection, DetectionEvidence, DiscoveryAttempt,
} = require("../../models/Listening");
const { normalize, mappingKey, baselineAvailable, flags, pilotAllowed, catalogRevisionOf, catalogRevisionFilter } = require("./common");
const { activeMappingStates } = require("./mappingRevisions");
const { createDiscoveryService, simplifiedTitle } = require("./discovery");
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
// Recent scans overlap; a separate daily sweep catches late commits and preallocated old IDs.
const CATALOG_SCAN_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1_000;
const CATALOG_SCAN_OVERLAP_MS = 15 * 60 * 1_000;
const CATALOG_CASE_PAGE_SIZE = 25;
const MAX_CATALOG_ALBUMS_PER_PASS = 10;
const MAX_CATALOG_CASES_PER_PASS = 200;
const MAX_CATALOG_JOBS_PER_PASS = 25;
const MAX_CATALOG_OUTSTANDING_JOBS = 100;
const CATALOG_QUEUE_HORIZON_MS = 5 * 60 * 1_000;
const CATALOG_REDISCOVERY_RETRY_MS = 60 * 60 * 1_000;
const CATALOG_REDISCOVERY_STAGGER_MS = 15 * 1_000;
// A name the providers never recognize stays incomplete; each observed album has a bounded retry.
const MAX_CATALOG_REDISCOVERY_RETRIES = 3;
// Discovery attempt records support the deterministic mapping measurement and then expire.
const DISCOVERY_ATTEMPT_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const PAIR_OBSERVATION_VERSION = 1;
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
        const listeners = await Scrobble.distinct("connectionId", { artistKey: resolved.artistKey, albumKey: resolved.albumKey, resolution: "unresolved", expiresAt: { $gt: now } }).session(session);
        if (listeners.length !== mappingCase.listenerCount) {
          await MappingCase.updateOne({ _id: mappingCase._id }, { $set: { listenerCount: listeners.length } }, { session, timestamps: false });
        }
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

function discoveryTrigger(job) {
  if (job.payload.catalogAlbumId) return "catalog";
  return job.key === `discovery:${job.payload.caseId}` ? "moderator_refresh" : "case_revision";
}
const attemptCandidates = (candidates) => (candidates || []).filter((item) => typeof item?.albumId === "string" && item.albumId).map((item) => ({ albumId: item.albumId, catalogRevision: Number.isSafeInteger(item.catalogRevision) ? item.catalogRevision : null }));
const attemptJobKey = (key) => crypto.createHash("sha256").update(String(key)).digest("hex");

// Records what one discovery job execution did. A committed run's record is validated before its
// transaction, then written inside the discovery transaction stamped with the
// commit time, so a rolled-back run leaves no committed record and a record can never block
// discovery. Skips, failures and conflicts have no committed discovery; their records are best
// effort and never change the job's outcome. Upserts by attemptId are idempotent across retries.
function attemptRecorder(job, context) {
  const startedAt = context.clock();
  const attemptId = crypto.randomUUID();
  const pairAlbumId = job.payload.observation?.albumId || "";
  const base = { attemptId, caseId: job.payload.caseId, jobKeyHash: attemptJobKey(job.key), trigger: discoveryTrigger(job), pairAlbumId, leaseAttempt: job.attempts || 0, startedAt };
  const has = (candidates) => pairAlbumId ? candidates.some((item) => item.albumId === pairAlbumId) : null;
  // Returns validated fields, or null when they cannot form a valid record (an observation gap).
  const prepare = (fields) => {
    const candidatesBefore = fields.candidatesBefore || [];
    const candidatesAfter = fields.candidatesAfter || [];
    const value = { ...base, ...fields, candidatesBefore, candidatesAfter, pairCandidateBefore: fields.caseRevision == null ? null : has(candidatesBefore), pairCandidateAfter: fields.outcome === "committed" ? has(candidatesAfter) : null, completedAt: startedAt, expiresAt: startedAt };
    const model = new DiscoveryAttempt(value);
    if (model.validateSync()) return null;
    const { _id, ...prepared } = model.toObject({ depopulate: true });
    return prepared;
  };
  const write = (prepared, session) => {
    const completedAt = context.clock();
    return DiscoveryAttempt.updateOne({ attemptId }, { $setOnInsert: { ...prepared, completedAt, expiresAt: new Date(completedAt.getTime() + DISCOVERY_ATTEMPT_RETENTION_MS) } }, { upsert: true, session });
  };
  const fromCase = (mappingCase) => mappingCase ? { caseRevision: mappingCase.revision, statusBefore: mappingCase.status, candidatesBefore: attemptCandidates(mappingCase.candidates) } : {};
  return {
    prepare: (fields) => prepare({ outcome: "committed", ...fields }),
    async committed(prepared, session) { if (prepared) await write(prepared, session); },
    async bestEffort(fields, mappingCase) {
      try { const prepared = prepare({ ...fromCase(mappingCase), ...fields }); if (prepared) await write(prepared); }
      catch { /* observation gaps are visible as missing records */ }
    },
    fromCase,
  };
}

async function discoveryJob(job, context) {
  const record = attemptRecorder(job, context);
  const mappingCase = await MappingCase.findOne({ caseId: job.payload.caseId, key: job.payload.key }).lean();
  if (!mappingCase) return record.bestEffort({ outcome: "skipped", skipReason: "case_missing" });
  if (mappingCase.status === "approved" && job.payload.allowApproved !== true) return record.bestEffort({ outcome: "skipped", skipReason: "case_approved" }, mappingCase);
  // A queued catalog suggestion cannot undo a later moderator rejection. A rejection during
  // discovery is fenced by the case revision, as are other concurrent moderator commands.
  if (job.payload.catalogAlbumId && !["pending", "no_catalog_match"].includes(mappingCase.status)) return record.bestEffort({ outcome: "skipped", skipReason: "case_not_eligible" }, mappingCase);
  let result;
  try { result = await context.discovery.discover({ artist: mappingCase.artist, album: mappingCase.album }); }
  catch (error) {
    await record.bestEffort({ outcome: "failed", errorCode: String(error?.code || "discovery_failed").slice(0, 200) }, mappingCase);
    throw error;
  }
  const changedEvidence = mappingCase.evidenceHash ? mappingCase.evidenceHash !== result.evidenceHash : Boolean(job.payload.catalogAlbumId && result.candidates.length);
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
  const coverage = (result.evidence || []).find((entry) => entry?.source === "candidate_discovery") || {};
  const runFacts = {
    ...record.fromCase(mappingCase), statusAfter: nextStatus, providerComplete: !result.incomplete,
    queryCapReached: typeof coverage.candidateQueryLimitReached === "boolean" ? coverage.candidateQueryLimitReached : null,
    candidateCapReached: Number.isFinite(coverage.candidatesFound) && Number.isFinite(coverage.candidatesShown) ? coverage.candidatesFound > coverage.candidatesShown : null,
    candidatesAfter: attemptCandidates(result.candidates), storedCandidatesReplaced: !result.incomplete,
  };
  const prepared = record.prepare(runFacts);
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
      await record.committed(prepared, session);
      const commitNow = context.clock();
      const commitFence = await Job.updateOne(
        { _id: job._id, status: "running", leaseToken: job.leaseToken, leaseUntil: { $gt: commitNow } },
        { $set: { leaseUntil: new Date(commitNow.getTime() + context.leaseMs) } }, { session },
      );
      if (commitFence.matchedCount !== 1) throw new WorkerError("job_lease_lost");
    });
  } catch (error) {
    // Provider work ran but nothing was committed: a moderator command won the case revision, the
    // lease was lost, or the transaction failed.
    const conflict = error?.code === "mapping_case_revision_changed";
    await record.bestEffort({ ...runFacts, outcome: conflict ? "conflict" : "failed", errorCode: String(error?.code || "discovery_transaction_failed").slice(0, 200), statusAfter: "", storedCandidatesReplaced: false });
    throw error;
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

// Versioned with the matching rules below so measurement cohorts can name the matcher they used.
const REDISCOVERY_MATCHER_VERSION = 1;

// Matches cases the way discovery's exact and edition-label lookups would, so a rerun can find the
// album. Artist names must match too: a title-only match would reopen cases a moderator closed for
// any new album sharing a common title. Returns every accepted case/album pair, at most `limit`
// cases per album, ranked by listeners.
function rediscoveryPairs(cases, albums, limit = Infinity) {
  const byName = new Map();
  const add = (title, row) => {
    if (!title) return;
    const key = `${row.artistKey}\u0000${title}`;
    const rows = byName.get(key) || [];
    if (!rows.includes(row)) rows.push(row);
    byName.set(key, rows);
  };
  for (const row of cases) { add(row.albumKey, row); add(normalize(simplifiedTitle(row.album)), row); }
  const pairs = [];
  for (const album of albums) {
    const title = normalize(album.title);
    const rows = [...new Set(album.artists.flatMap((artist) => byName.get(`${normalize(artist)}\u0000${title}`) || []))]
      .sort((a, b) => (b.listenerCount || 0) - (a.listenerCount || 0) || a.caseId.localeCompare(b.caseId))
      .slice(0, limit);
    for (const row of rows) pairs.push({ row, album });
  }
  return pairs;
}

// Returns each matched case with its newest matching album time.
function rediscoveryMatches(cases, albums, limit = CATALOG_CASE_PAGE_SIZE) {
  const matched = new Map();
  for (const { row, album } of rediscoveryPairs(cases, albums, limit)) {
    const current = matched.get(row.caseId);
    if (!current || current.albumCreatedAt < album.createdAt) matched.set(row.caseId, { row, albumCreatedAt: album.createdAt });
  }
  return [...matched.values()];
}

// Each case/album pair has one durable job. Its existence acknowledges an observed album,
// not an inferred publication time, and another discovery cannot consume that acknowledgement.
// Existing jobs are never touched by scans: failed jobs retry through the worker's lease fence.
async function scheduleCatalogRediscoveryJobs({ clock = () => new Date(), env = process.env, state } = {}) {
  if (!flags(env).discovery) return 0;
  // An explicit state is an isolated test harness. Production always uses the durable lease.
  if (state) return scheduleCatalogPass({ clock, state });
  const key = "catalog-rediscovery";
  try {
    await CatalogScan.updateOne({ key }, { $setOnInsert: { key, state: {}, leaseUntil: null, leaseToken: "" } }, { upsert: true, timestamps: false });
  } catch (error) {
    if (error?.code !== 11000 || !await CatalogScan.exists({ key })) throw error;
  }
  const token = crypto.randomUUID(); const now = clock();
  const checkpoint = await CatalogScan.findOneAndUpdate({ key, $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] }, {
    $set: { leaseToken: token, leaseUntil: new Date(now.getTime() + DEFAULT_LEASE_MS) },
  }, { returnDocument: "after" }).lean();
  if (!checkpoint) return 0;
  try {
    const ensureLease = async () => {
      const at = clock();
      const held = await CatalogScan.updateOne({ _id: checkpoint._id, leaseToken: token, leaseUntil: { $gt: at } }, {
        $set: { leaseUntil: new Date(at.getTime() + DEFAULT_LEASE_MS) },
      });
      if (held.matchedCount !== 1) throw new WorkerError("catalog_scan_lease_lost");
    };
    return await scheduleCatalogPass({ clock, state: checkpoint.state, ensureLease });
  } finally {
    // Replayed inserts are idempotent if a process dies before this checkpoint. A stale scanner
    // cannot overwrite a successor's cursor. Persist partial progress even after a pass failure.
    await CatalogScan.updateOne({ _id: checkpoint._id, leaseToken: token, leaseUntil: { $gt: clock() } }, {
      $set: { state: checkpoint.state, leaseToken: "", leaseUntil: null },
    });
  }
}

// Measurement clocks for a newly observed pair. The pair has no earlier job, so the last full
// sweep to complete before this observation read the album's position without finding the pair
// eligible: eligibility followed that sweep's start. Before any full sweep has completed with this
// field, the entry time is unknown. Publication commit time is never inferred from IDs.
// Stored candidates are only replaced by provider-complete runs, so a stored candidate bound to the
// album's current revision is usable even when a later refresh failed. An album checkpointed by a
// scanner without these fields has no observation; its pairs stay outside measured cohorts.
function pairObservation(row, album, { now, mode, state }) {
  if (!album.albumId) return null;
  const candidate = (row.candidates || []).find((item) => item?.albumId === album.albumId);
  return {
    version: PAIR_OBSERVATION_VERSION, albumId: album.albumId, observedAt: now, scanMode: mode,
    eligibleAfter: state.lastFullSweepStartedAt || null,
    usableCandidateAtEntry: Boolean(candidate) && candidate.catalogRevision === catalogRevisionOf(album),
  };
}

async function scheduleCatalogPass({ clock, state, ensureLease = async () => {} }) {
  const now = clock();
  const outstanding = await Job.find({ type: "discovery", status: { $in: ["pending", "running"] }, "payload.catalogAlbumId": { $exists: true } })
    .select("runAt attempts status").limit(MAX_CATALOG_OUTSTANDING_JOBS).lean();
  const capacity = MAX_CATALOG_OUTSTANDING_JOBS - outstanding.length;
  if (!capacity) return 0;
  const tail = outstanding.filter((job) => job.status === "pending" && job.attempts === 0)
    .reduce((latest, job) => Math.max(latest, job.runAt.getTime()), 0);
  let runAt = new Date(Math.max(now.getTime(), tail ? tail + CATALOG_REDISCOVERY_STAGGER_MS : 0));
  const horizon = now.getTime() + CATALOG_QUEUE_HORIZON_MS;
  if (runAt.getTime() > horizon) return 0;

  // Alternate independent cursors so a large full sweep cannot hold up recent publications.
  const fullDue = state.full || !state.fullCompletedAt || now - state.fullCompletedAt >= SWEEP_INTERVAL_MS;
  const mode = state.nextScan === "full" && fullDue ? "full" : "recent";
  state.nextScan = mode === "recent" ? "full" : "recent";
  if (!state[mode]) {
    const from = new Date((state.from ? state.from.getTime() : now.getTime() - CATALOG_SCAN_LOOKBACK_MS) - CATALOG_SCAN_OVERLAP_MS);
    state[mode] = {
      lower: mode === "full" ? null : mongoose.Types.ObjectId.createFromTime(Math.floor(from.getTime() / 1_000)),
      upper: mongoose.Types.ObjectId.createFromTime(Math.floor(now.getTime() / 1_000) + 1),
      startedAt: now, cursor: null, album: null, caseCursor: null,
    };
  }
  const scan = state[mode];
  let casesRead = 0; let albumsRead = 0; let queued = 0;
  while (albumsRead < MAX_CATALOG_ALBUMS_PER_PASS && casesRead < MAX_CATALOG_CASES_PER_PASS && queued < Math.min(MAX_CATALOG_JOBS_PER_PASS, capacity)) {
    await ensureLease();
    if (!scan.album) {
      const rows = await AlbumCatalog.find({ _id: {
        ...(scan.cursor ? { $gt: scan.cursor } : scan.lower ? { $gte: scan.lower } : {}), $lt: scan.upper,
      } }).select("_id albumId title artistDisplayName artistCredits.name catalogRevision").sort({ _id: 1 }).limit(1).lean();
      if (!rows.length) {
        if (mode === "recent") state.from = scan.startedAt;
        else { state.fullCompletedAt = now; state.lastFullSweepStartedAt = scan.startedAt; }
        delete state[mode];
        break;
      }
      scan.album = rows[0]; scan.caseCursor = null; scan.artistIndex = 0;
    }
    albumsRead += 1;
    const album = { title: scan.album.title, artists: [scan.album.artistDisplayName, ...(scan.album.artistCredits || []).map((credit) => credit.name)] };
    const artistKeys = [...new Set(album.artists.map(normalize).filter(Boolean))];
    const pageSize = Math.min(CATALOG_CASE_PAGE_SIZE, MAX_CATALOG_CASES_PER_PASS - casesRead);
    const artistKey = artistKeys[scan.artistIndex];
    const cases = artistKey ? await MappingCase.find({
      status: { $in: ["pending", "no_catalog_match"] }, artistKey,
      ...(scan.caseCursor ? { _id: { $gt: scan.caseCursor } } : {}),
    }).select("_id caseId key artistKey album albumKey listenerCount candidates.albumId candidates.catalogRevision").sort({ _id: 1 }).limit(pageSize).lean() : [];
    casesRead += cases.length;
    const matches = new Set(rediscoveryMatches(cases, [album], pageSize).map(({ row }) => row.caseId));
    for (const row of cases) {
      if (matches.has(row.caseId)) {
        if (runAt.getTime() > horizon || queued >= Math.min(MAX_CATALOG_JOBS_PER_PASS, capacity)) return queued;
        const catalogAlbumId = String(scan.album._id);
        const key = `discovery:catalog:${row.caseId}:${catalogAlbumId}`;
        const observation = pairObservation(row, scan.album, { now, mode, state });
        let inserted;
        await ensureLease();
        try {
          inserted = await Job.updateOne({ key }, { $setOnInsert: {
            key, type: "discovery", payload: { caseId: row.caseId, key: row.key, catalogAlbumId, ...(observation ? { observation } : {}) },
            status: "pending", runAt, attempts: 0, progress: {}, error: "", createdAt: now, updatedAt: now,
          } }, { upsert: true, timestamps: false });
        } catch (error) {
          // A concurrent scanner may have inserted this exact unique key first.
          if (error?.code !== 11000 || !await Job.exists({ key })) throw error;
          inserted = { upsertedCount: 0 };
        }
        if (inserted.upsertedCount === 1) {
          queued += 1;
          runAt = new Date(runAt.getTime() + CATALOG_REDISCOVERY_STAGGER_MS);
        }
      }
      // Advance only after the matching job is durable. A retry replays at most this row.
      scan.caseCursor = row._id;
    }
    if (cases.length < pageSize) {
      scan.artistIndex += 1; scan.caseCursor = null;
      if (scan.artistIndex >= artistKeys.length) { scan.cursor = scan.album._id; scan.album = null; }
    }
  }
  return queued;
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
      const catalogDiscovery = job.type === "discovery" && Boolean(job.payload.catalogAlbumId);
      const retryable = (error?.retryable !== false || providerTransient || (catalogDiscovery && code === "mapping_case_revision_changed")) && !(job.type === "discovery" && job.attempts >= (catalogDiscovery ? MAX_CATALOG_REDISCOVERY_RETRIES + 1 : 5));
      const retryAt = new Date(clock().getTime() + (catalogDiscovery ? CATALOG_REDISCOVERY_RETRY_MS : Math.min(60_000 * (2 ** Math.min(job.attempts, 6)), 60 * 60 * 1_000)));
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
  DEFAULT_LEASE_MS, DISCOVERY_ATTEMPT_RETENTION_MS, MAX_REPROCESS_EVENTS_PER_RUN, PAIR_OBSERVATION_VERSION, attemptJobKey, MAX_SYNC_PAGES, MAX_SYNC_PAGES_PER_RUN, OVERLAP_MS, POLL_MS, RETENTION_MS, WorkerError,
  SWEEP_INTERVAL_MS, SWEEP_LOOKBACK_MS,
  enqueueJob, identityKey, inActivationWindow, persistPage, runWorkerOnce,
  REDISCOVERY_MATCHER_VERSION, rediscoveryMatches, rediscoveryPairs, scheduleCatalogRediscoveryJobs, scheduleDueDetectionJobs, scheduleDueSweepJobs, scheduleDueSyncJobs, scheduleStaleMappingJobs, sweepWindow, syncWindow,
};
