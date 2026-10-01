const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const AlbumCatalog = require("../models/AlbumCatalog");
const Listen = require("../models/Listen");
const { Connection, Scrobble, MappingCase, AlbumMapping, Job, ProviderBudget } = require("../models/Listening");
const { enqueueJob, persistPage, runWorkerOnce, scheduleDueSyncJobs, scheduleStaleMappingJobs, RETENTION_MS } = require("../lib/listening/worker");
const { mappingKey, normalize } = require("../lib/listening/common");
const { createLastfmProvider } = require("../lib/listening/provider");

const enabled = String(process.env.RUN_MONGO_INTEGRATION || "").toLowerCase() === "true";
const DUE = new Date("2026-09-25T12:00:00Z");
let replSet;

async function setup() {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: "rescened_listening_worker" });
  await Promise.all([Connection.syncIndexes(), Scrobble.syncIndexes(), MappingCase.syncIndexes(), AlbumMapping.syncIndexes(), Job.syncIndexes(), ProviderBudget.syncIndexes(), AlbumCatalog.syncIndexes()]);
}
async function teardown() {
  if (mongoose.connection.readyState === 1) { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); }
  if (replSet) await replSet.stop();
}
async function reset() { await Promise.all(Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({}))); }

async function connection() {
  const start = new Date("2026-09-25T12:00:00Z");
  return Connection.create({ userId: "user-1", username: "listener", usernameKey: "listener", state: "active", revision: 1, connectedAt: start, windows: [{ start, end: null }], nextSyncAt: start });
}
function track(name, at, album = "Edition Label") { return { artist: "Album Artist", album, track: name, playedAt: new Date(at), nowPlaying: false }; }
function workerOptions(provider, clock = () => new Date("2026-09-25T14:00:00Z")) {
  return {
    provider,
    clock,
    env: { LASTFM_SYNC_ENABLED: "true", LASTFM_DISCOVERY_ENABLED: "false", LASTFM_PILOT_USER_IDS: "user-1" },
    ownerExists: async () => true,
    discovery: { async discover() { return { candidates: [], evidence: [], evidenceHash: "hash" }; } },
    types: ["sync"],
  };
}

test("listening worker MongoDB integration", { skip: !enabled }, async (t) => {
  await setup();
  t.after(teardown);

  await t.test("fully paginates, excludes now-playing, and replay does not inflate encounters", async () => {
    await reset();
    const conn = await connection();
    await Connection.updateOne({ _id: conn._id }, { $push: { windows: { start: new Date("2026-07-01T00:00:00Z"), end: new Date("2026-07-02T00:00:00Z") } } });
    const calls = [];
    const provider = { async recentTracks({ page }) {
      calls.push(page);
      if (page === 1) return { page, totalPages: 2, tracks: [{ nowPlaying: true }, track("One", "2026-09-25T12:10:00Z")] };
      return { page, totalPages: 2, tracks: [
        track("Two", "2026-09-25T12:20:00Z"),
        track("Missing album", "2026-09-25T12:30:00Z", ""),
        track("Outside fixed window", "2026-09-25T15:30:00Z"),
      ] };
    } };
    await enqueueJob("sync", "sync:first", { connectionId: String(conn._id), connectionRevision: 1 }, { runAt: DUE });
    assert.equal((await runWorkerOnce(workerOptions(provider))).status, "done");
    assert.deepEqual(calls, [1, 2]);
    assert.equal(await Scrobble.countDocuments(), 3);
    assert.equal(await Scrobble.countDocuments({ resolution: "unavailable" }), 1);
    const first = await Scrobble.findOne({ track: "One" }).lean();
    assert.equal(first.expiresAt.toISOString(), new Date(first.playedAt.getTime() + RETENTION_MS).toISOString());
    assert.equal((await MappingCase.findOne({ key: mappingKey("Album Artist", "Edition Label") })).encounterCount, 2);
    assert.equal((await Connection.findById(conn._id)).windows.length, 1);
    await enqueueJob("sync", "sync:replay", { connectionId: String(conn._id), connectionRevision: 1 }, { runAt: DUE });
    await runWorkerOnce(workerOptions(provider));
    assert.equal(await Scrobble.countDocuments(), 3);
    assert.equal((await MappingCase.findOne({ key: mappingKey("Album Artist", "Edition Label") })).encounterCount, 2);
    assert.equal((await MappingCase.findOne({ key: mappingKey("Album Artist", "Edition Label") })).listenerCount, 1);
    assert.equal(await Listen.countDocuments(), 0);
  });

  await t.test("ranks mapping cases by distinct listeners, not one listener's repeat plays", async () => {
    await reset();
    const start = new Date("2026-09-25T12:00:00Z");
    const first = await connection();
    const second = await Connection.create({ userId: "user-2", username: "second", usernameKey: "second", state: "active", revision: 1, connectedAt: start, windows: [{ start, end: null }], nextSyncAt: start });
    const provider = { async recentTracks({ username }) {
      if (username === "second") return { page: 1, totalPages: 1, tracks: [track("Shared", "2026-09-25T12:40:00Z", "Shared Album")] };
      return { page: 1, totalPages: 1, tracks: [
        track("One", "2026-09-25T12:10:00Z", "Solo Album"),
        track("Two", "2026-09-25T12:20:00Z", "Solo Album"),
        track("Three", "2026-09-25T12:30:00Z", "Solo Album"),
        track("Shared", "2026-09-25T12:35:00Z", "Shared Album"),
      ] };
    } };
    const options = { ...workerOptions(provider), env: { ...workerOptions(provider).env, LASTFM_PILOT_USER_IDS: "user-1,user-2" } };
    await enqueueJob("sync", "sync:listeners-1", { connectionId: String(first._id), connectionRevision: 1 }, { runAt: DUE });
    await enqueueJob("sync", "sync:listeners-2", { connectionId: String(second._id), connectionRevision: 1 }, { runAt: DUE });
    assert.equal((await runWorkerOnce(options)).status, "done");
    assert.equal((await runWorkerOnce(options)).status, "done");
    const solo = await MappingCase.findOne({ key: mappingKey("Album Artist", "Solo Album") }).lean();
    const shared = await MappingCase.findOne({ key: mappingKey("Album Artist", "Shared Album") }).lean();
    assert.deepEqual([solo.listenerCount, solo.encounterCount], [1, 3]);
    assert.deepEqual([shared.listenerCount, shared.encounterCount], [2, 2]);
    const moderation = require("../lib/listening/moderation");
    const queue = await moderation.listCases({ status: "pending" });
    assert.deepEqual(queue.items.map((item) => item.album), ["Shared Album", "Solo Album"]);
  });

  await t.test("persists page checkpoints and never advances completed cursor past a failed page", async () => {
    await reset();
    const conn = await connection();
    let fail = true;
    const pages = [];
    const provider = { async recentTracks({ page }) {
      pages.push(page);
      if (page === 2 && fail) throw Object.assign(new Error("upstream"), { code: "lastfm_unavailable" });
      return { page, totalPages: 2, tracks: [track(`Page ${page}`, `2026-09-25T12:${page}0:00Z`)] };
    } };
    await enqueueJob("sync", "sync:restart", { connectionId: String(conn._id), connectionRevision: 1 }, { runAt: DUE });
    assert.equal((await runWorkerOnce(workerOptions(provider))).status, "error");
    assert.equal((await Connection.findById(conn._id)).completedThrough, null);
    const pending = await Job.findOne({ key: "sync:restart" });
    assert.equal(pending.progress.nextPage, 2);
    await Job.updateOne({ _id: pending._id }, { $set: { runAt: new Date("2026-09-25T13:00:00Z") } });
    fail = false;
    assert.equal((await runWorkerOnce(workerOptions(provider))).status, "done");
    assert.deepEqual(pages, [1, 2, 2]);
    assert.ok((await Connection.findById(conn._id)).completedThrough);
    assert.equal(await Scrobble.countDocuments(), 2);
    assert.deepEqual((await Job.findOne({ key: "sync:restart" }).lean()).progress, {});
  });

  await t.test("large windows yield after ten pages and resume from the persisted checkpoint", async () => {
    await reset();
    const conn = await connection();
    const pages = [];
    const provider = { async recentTracks({ page }) { pages.push(page); return { page, totalPages: 12, tracks: [] }; } };
    await enqueueJob("sync", "sync:bounded-pages", { connectionId: String(conn._id), connectionRevision: 1 }, { runAt: DUE });
    const first = await runWorkerOnce(workerOptions(provider));
    assert.equal(first.status, "pending");
    assert.deepEqual(pages, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal((await Job.findOne({ key: "sync:bounded-pages" })).progress.nextPage, 11);
    assert.equal((await Connection.findById(conn._id)).completedThrough, null);
    const second = await runWorkerOnce(workerOptions(provider, () => new Date("2026-09-25T14:00:02Z")));
    assert.equal(second.status, "done");
    assert.deepEqual(pages.slice(-2), [11, 12]);
    assert.ok((await Connection.findById(conn._id)).completedThrough);
  });

  await t.test("pagination drift resets to page one without advancing the completed cursor", async () => {
    await reset();
    const conn = await connection();
    let drift = true;
    const pages = [];
    const provider = { async recentTracks({ page }) {
      pages.push(page);
      return { page, totalPages: drift && page === 1 ? 2 : 3, tracks: [track(`Page ${page}`, `2026-09-25T12:${page}0:00Z`)] };
    } };
    await enqueueJob("sync", "sync:pagination-drift", { connectionId: String(conn._id), connectionRevision: 1 }, { runAt: DUE });
    const first = await runWorkerOnce(workerOptions(provider));
    assert.equal(first.error, "lastfm_pagination_changed");
    assert.equal((await Connection.findById(conn._id)).completedThrough, null);
    const pending = await Job.findOne({ key: "sync:pagination-drift" }).lean();
    assert.equal(pending.progress.nextPage, 1);
    assert.equal(pending.progress.totalPages, null);
    await Job.updateOne({ _id: pending._id }, { $set: { runAt: DUE } });
    drift = false;
    const second = await runWorkerOnce(workerOptions(provider));
    assert.equal(second.status, "done");
    assert.deepEqual(pages, [1, 2, 1, 2, 3]);
  });

  await t.test("a delayed retry clamps its fixed window to the current retention horizon", async () => {
    await reset();
    const clock = () => new Date("2026-10-31T14:00:00Z");
    const connectedAt = new Date("2026-09-01T12:00:00Z");
    const conn = await Connection.create({ userId: "user-1", username: "listener", usernameKey: "listener", state: "active", revision: 1, connectedAt, windows: [{ start: connectedAt, end: null }], nextSyncAt: connectedAt });
    const oldFrom = new Date("2026-09-15T12:00:00Z");
    const to = clock();
    let request;
    const provider = { async recentTracks(options) { request = options; return { page: options.page, totalPages: 1, tracks: [] }; } };
    await enqueueJob("sync", "sync:retention-clamp", { connectionId: String(conn._id), connectionRevision: 1 }, { runAt: DUE });
    await Job.updateOne({ key: "sync:retention-clamp" }, { $set: { progress: { window: { from: oldFrom.toISOString(), to: to.toISOString() }, nextPage: 2, totalPages: 2 } } });
    const result = await runWorkerOnce(workerOptions(provider, clock));
    assert.equal(result.status, "done");
    assert.equal(request.page, 1);
    assert.equal(request.from.toISOString(), new Date(clock().getTime() - RETENTION_MS).toISOString());
    const updated = await Connection.findById(conn._id).lean();
    assert.equal(updated.retentionGap.from.toISOString(), oldFrom.toISOString());
    assert.equal(updated.retentionGap.to.toISOString(), request.from.toISOString());
  });

  await t.test("revision fencing rejects an in-flight page after pause or disconnect", async () => {
    await reset();
    const conn = await connection();
    const provider = { async recentTracks({ page }) {
      await Connection.updateOne({ _id: conn._id }, { $set: { state: "paused" }, $inc: { revision: 1 } });
      return { page, totalPages: 1, tracks: [track("Late", "2026-09-25T12:10:00Z")] };
    } };
    await enqueueJob("sync", "sync:revision", { connectionId: String(conn._id), connectionRevision: 1 }, { runAt: DUE });
    const result = await runWorkerOnce(workerOptions(provider));
    assert.equal(result.error, "connection_revision_changed");
    assert.equal(await Scrobble.countDocuments(), 0);
  });

  await t.test("an expired lease cannot commit a fetched page", async () => {
    await reset();
    const conn = await connection();
    const provider = { async recentTracks({ page }) {
      await Job.updateOne({ key: "sync:expired" }, { $set: { leaseUntil: new Date("2026-09-25T13:59:00Z") } });
      return { page, totalPages: 1, tracks: [track("Must not commit", "2026-09-25T12:10:00Z")] };
    } };
    await enqueueJob("sync", "sync:expired", { connectionId: String(conn._id), connectionRevision: 1 }, { runAt: DUE });
    const result = await runWorkerOnce(workerOptions(provider));
    assert.equal(result.error, "job_lease_lost");
    assert.equal(await Scrobble.countDocuments(), 0);
  });

  await t.test("a page transaction rolls back when its lease expires before commit", async () => {
    await reset();
    const conn = await connection();
    const base = new Date("2026-09-25T14:00:00Z");
    const job = await Job.create({
      key: "sync:commit-fence", type: "sync", payload: { connectionId: String(conn._id), connectionRevision: 1 },
      status: "running", runAt: DUE, leaseToken: "lease-token", leaseUntil: new Date(base.getTime() + 100), attempts: 1,
    });
    let clockCalls = 0;
    const clock = () => new Date(base.getTime() + (clockCalls++ === 0 ? 0 : 200));
    await assert.rejects(
      persistPage({
        connectionId: conn._id, revision: 1, rows: [track("Late commit", "2026-09-25T12:10:00Z")],
        from: DUE, to: base, clock, job: job.toObject(), leaseMs: 100,
      }),
      (error) => error.code === "job_lease_lost",
    );
    assert.equal(await Scrobble.countDocuments(), 0);
  });

  await t.test("incomplete discovery preserves reviewed evidence and only new complete evidence reopens a rejection", async () => {
    await reset();
    const key = mappingKey("Artist", "Edition");
    const mappingCase = await MappingCase.create({
      key, provider: "lastfm", artist: "Artist", album: "Edition", artistKey: normalize("Artist"), albumKey: normalize("Edition"),
      status: "rejected", revision: 2, encounterCount: 1, candidates: [{ albumId: crypto.randomUUID(), title: "Old" }],
      evidence: [{ kind: "provider", value: "old" }], evidenceHash: "stable-hash",
    });
    await enqueueJob("discovery", "discovery:incomplete", { caseId: mappingCase.caseId, key }, { runAt: DUE });
    const options = {
      clock: () => new Date("2026-09-25T14:00:00Z"), env: { LASTFM_DISCOVERY_ENABLED: "true" }, provider: {}, types: ["discovery"],
      discovery: { async discover() { return { incomplete: true, candidates: [], evidence: [{ kind: "error" }], evidenceHash: "outage-hash" }; } },
    };
    assert.equal((await runWorkerOnce(options)).error, "discovery_incomplete");
    let current = await MappingCase.findOne({ key }).lean();
    assert.equal(current.status, "rejected");
    assert.equal(current.revision, 2);
    assert.equal(current.evidenceHash, "stable-hash");
    assert.equal(current.candidates[0].title, "Old");

    await enqueueJob("discovery", "discovery:new-evidence", { caseId: mappingCase.caseId, key }, { runAt: DUE });
    const refreshed = await runWorkerOnce({
      ...options,
      discovery: { async discover() { return { incomplete: false, candidates: [{ albumId: crypto.randomUUID(), title: "New" }], evidence: [{ kind: "provider", value: "new" }], evidenceHash: "new-hash" }; } },
    });
    assert.equal(refreshed.status, "done");
    current = await MappingCase.findOne({ key }).lean();
    assert.equal(current.status, "pending");
    assert.equal(current.revision, 3);
    assert.equal(current.evidenceHash, "new-hash");
  });

  await t.test("approved discovery refreshes require an explicit job and never change approval status", async () => {
    await reset();
    const key = mappingKey("Artist", "Approved Edition");
    const mappingCase = await MappingCase.create({
      key, provider: "lastfm", artist: "Artist", album: "Approved Edition", artistKey: normalize("Artist"), albumKey: normalize("Approved Edition"),
      status: "approved", revision: 4, encounterCount: 1, evidenceHash: "old-hash",
    });
    let calls = 0;
    const options = {
      clock: () => new Date("2026-09-25T14:00:00Z"), env: { LASTFM_DISCOVERY_ENABLED: "true" }, provider: {}, types: ["discovery"],
      discovery: { async discover() { calls += 1; return { incomplete: false, candidates: [], evidence: [{ kind: "provider", value: "refreshed" }], evidenceHash: "new-hash" }; } },
    };
    await enqueueJob("discovery", "discovery:approved-implicit", { caseId: mappingCase.caseId, key }, { runAt: DUE });
    assert.equal((await runWorkerOnce(options)).status, "done");
    assert.equal(calls, 0);
    await enqueueJob("discovery", "discovery:approved-explicit", { caseId: mappingCase.caseId, key, allowApproved: true }, { runAt: DUE });
    assert.equal((await runWorkerOnce(options)).status, "done");
    const current = await MappingCase.findOne({ key }).lean();
    assert.equal(calls, 1);
    assert.equal(current.status, "approved");
    assert.equal(current.revision, 5);
    assert.equal(current.evidenceHash, "new-hash");
  });

  await t.test("scheduler maintains one sync job per connection revision lifecycle", async () => {
    await reset();
    const conn = await connection();
    const previous = process.env.LASTFM_SYNC_ENABLED;
    process.env.LASTFM_SYNC_ENABLED = "true";
    try {
      await scheduleDueSyncJobs({ clock: () => new Date("2026-09-25T14:00:00Z"), env: { LASTFM_SYNC_ENABLED: "true", LASTFM_PILOT_USER_IDS: "user-1" } });
      await scheduleDueSyncJobs({ clock: () => new Date("2026-09-25T14:01:00Z"), env: { LASTFM_SYNC_ENABLED: "true", LASTFM_PILOT_USER_IDS: "user-1" } });
    } finally {
      if (previous === undefined) delete process.env.LASTFM_SYNC_ENABLED;
      else process.env.LASTFM_SYNC_ENABLED = previous;
    }
    assert.equal(await Job.countDocuments({ type: "sync", "payload.connectionId": String(conn._id) }), 1);
  });

  await t.test("exact approved mappings resolve and stale catalog revisions become unavailable", async () => {
    await reset();
    const conn = await connection();
    const albumId = crypto.randomUUID();
    await AlbumCatalog.create({ albumId, title: "Standard", artistDisplayName: "Album Artist", artistCredits: [{ name: "Album Artist", role: "main" }], catalogRevision: 1 });
    const key = mappingKey("Album Artist", "Edition Label");
    await AlbumMapping.create({ mappingId: crypto.randomUUID(), key, provider: "lastfm", artist: "Album Artist", album: "Edition Label", artistKey: normalize("Album Artist"), albumKey: normalize("Edition Label"), albumId, catalogRevision: 1, revision: 1, reviewer: "moderator", reason: "verified" });
    const provider = { async recentTracks({ page }) { return { page, totalPages: 1, tracks: [track("Mapped", "2026-09-25T12:10:00Z")] }; } };
    await enqueueJob("sync", "sync:mapped", { connectionId: String(conn._id), connectionRevision: 1 }, { runAt: DUE });
    await runWorkerOnce(workerOptions(provider));
    assert.equal((await Scrobble.findOne()).resolution, "matched");
    await AlbumCatalog.updateOne({ albumId }, { $set: { catalogRevision: 2 } });
    const reprocessClock = () => new Date("2026-09-26T14:00:00Z");
    assert.equal(await scheduleStaleMappingJobs({ clock: reprocessClock }), 1);
    const result = await runWorkerOnce({ ...workerOptions(provider, reprocessClock), types: ["reprocess"] });
    assert.equal(result.status, "done");
    assert.equal((await Scrobble.findOne()).resolution, "unavailable");
    assert.equal(await Listen.countDocuments(), 0);
  });

  await t.test("reprocessing preserves blank-track unavailable evidence while updating valid events", async () => {
    await reset();
    const conn = await connection();
    const albumId = crypto.randomUUID();
    await AlbumCatalog.create({ albumId, title: "Standard", artistDisplayName: "Album Artist", artistCredits: [{ name: "Album Artist", role: "main" }], catalogRevision: 1 });
    const key = mappingKey("Album Artist", "Edition Label");
    const mapping = await AlbumMapping.create({ mappingId: crypto.randomUUID(), key, provider: "lastfm", artist: "Album Artist", album: "Edition Label", artistKey: normalize("Album Artist"), albumKey: normalize("Edition Label"), albumId, catalogRevision: 1, revision: 1, reviewer: "moderator", reason: "verified" });
    await Scrobble.create([
      {
        eventId: crypto.randomUUID(), connectionId: conn._id, connectionRevision: 1, identityKey: "blank-track",
        artist: "Album Artist", album: "Edition Label", track: "", artistKey: normalize("Album Artist"), albumKey: normalize("Edition Label"), trackKey: "",
        playedAt: new Date(DUE.getTime() + 1_000), expiresAt: new Date(DUE.getTime() + RETENTION_MS), resolution: "unavailable", mappingId: mapping.mappingId,
      },
      {
        eventId: crypto.randomUUID(), connectionId: conn._id, connectionRevision: 1, identityKey: "valid-track",
        artist: "Album Artist", album: "Edition Label", track: "Track", artistKey: normalize("Album Artist"), albumKey: normalize("Edition Label"), trackKey: normalize("Track"),
        playedAt: new Date(DUE.getTime() + 2_000), expiresAt: new Date(DUE.getTime() + RETENTION_MS), resolution: "unavailable", mappingId: mapping.mappingId,
      },
    ]);
    await enqueueJob("reprocess", "reprocess:track-identity-active", { key, mappingId: mapping.mappingId, mappingRevision: 1 }, { runAt: DUE });
    assert.equal((await runWorkerOnce({ ...workerOptions({}, () => new Date("2026-09-25T14:00:00Z")), types: ["reprocess"] })).status, "done");
    assert.equal((await Scrobble.findOne({ identityKey: "blank-track" })).resolution, "unavailable");
    assert.equal((await Scrobble.findOne({ identityKey: "valid-track" })).resolution, "matched");

    await AlbumMapping.updateOne({ _id: mapping._id }, { $set: { status: "revoked" }, $inc: { revision: 1 } });
    await enqueueJob("reprocess", "reprocess:track-identity-revoked", { key, mappingId: mapping.mappingId, mappingRevision: 2 }, { runAt: DUE });
    assert.equal((await runWorkerOnce({ ...workerOptions({}, () => new Date("2026-09-25T14:00:01Z")), types: ["reprocess"] })).status, "done");
    assert.equal((await Scrobble.findOne({ identityKey: "blank-track" })).resolution, "unavailable");
    assert.equal((await Scrobble.findOne({ identityKey: "valid-track" })).resolution, "unresolved");
  });

  await t.test("albums without a stored catalog revision resolve as revision 1 and are not stale", async () => {
    await reset();
    const conn = await connection();
    const albumId = crypto.randomUUID();
    // Legacy catalog documents predate the field; insert directly to bypass the schema default.
    await AlbumCatalog.collection.insertOne({ albumId, title: "Legacy", artistDisplayName: "Album Artist", artistCredits: [{ name: "Album Artist", role: "main" }] });
    const key = mappingKey("Album Artist", "Legacy Label");
    await AlbumMapping.create({ mappingId: crypto.randomUUID(), key, provider: "lastfm", artist: "Album Artist", album: "Legacy Label", artistKey: normalize("Album Artist"), albumKey: normalize("Legacy Label"), albumId, catalogRevision: 1, revision: 1, reviewer: "moderator", reason: "verified" });
    const provider = { async recentTracks({ page }) { return { page, totalPages: 1, tracks: [track("Mapped", "2026-09-25T12:10:00Z", "Legacy Label")] }; } };
    await enqueueJob("sync", "sync:legacy", { connectionId: String(conn._id), connectionRevision: 1 }, { runAt: DUE });
    await runWorkerOnce(workerOptions(provider));
    const event = await Scrobble.findOne().lean();
    assert.equal(event.resolution, "matched");
    assert.equal(event.catalogRevision, 1);
    assert.equal(await scheduleStaleMappingJobs({ clock: () => new Date("2026-09-26T14:00:00Z") }), 0);
  });

  await t.test("sync stays disabled without its flag and owner removal closes ingestion before cleanup", async () => {
    await reset();
    const conn = await connection();
    let providerCalls = 0;
    const provider = { async recentTracks() { providerCalls += 1; return { page: 1, totalPages: 1, tracks: [] }; } };
    await enqueueJob("sync", "sync:disabled", { connectionId: String(conn._id), connectionRevision: 1 }, { runAt: DUE });
    const disabled = await runWorkerOnce({ ...workerOptions(provider), env: { LASTFM_PILOT_USER_IDS: "user-1" } });
    assert.equal(disabled.processed, false);
    assert.equal(providerCalls, 0);

    const removed = await runWorkerOnce({ ...workerOptions(provider), ownerExists: async () => false });
    assert.equal(removed.status, "done");
    assert.equal(providerCalls, 0);
    const disconnected = await Connection.findById(conn._id).lean();
    assert.equal(disconnected.state, "disconnected");
    assert.equal(disconnected.revision, 2);
    assert.ok(disconnected.windows[0].end);
    assert.ok(await Job.findOne({ type: "cleanup", "payload.connectionId": String(conn._id) }));
  });

  await t.test("cleanup runs while syncing is disabled and scrubs connection-linked job state", async () => {
    await reset();
    const conn = await connection();
    await Connection.updateOne({ _id: conn._id }, { $set: { state: "disconnected" }, $inc: { revision: 1 } });
    await Scrobble.create({
      eventId: crypto.randomUUID(), connectionId: conn._id, connectionRevision: 1, identityKey: "cleanup-event",
      artist: "Artist", album: "Album", track: "Track", playedAt: DUE,
      expiresAt: new Date(DUE.getTime() + RETENTION_MS), resolution: "unresolved",
    });
    await enqueueJob("sync", "sync:private-state", { connectionId: String(conn._id), connectionRevision: 1 }, { runAt: DUE });
    await Job.updateOne({ key: "sync:private-state" }, { $set: { progress: { window: { from: DUE.toISOString(), to: DUE.toISOString() } } } });
    await enqueueJob("cleanup", "cleanup:private-state", { connectionId: String(conn._id), connectionRevision: 2, userId: "user-1" }, { runAt: DUE });
    const result = await runWorkerOnce({
      clock: () => new Date("2026-09-25T14:00:00Z"), env: {}, provider: {},
      discovery: { async discover() { throw new Error("unused"); } }, types: ["cleanup"],
    });
    assert.equal(result.status, "done");
    assert.equal(await Connection.countDocuments(), 0);
    assert.equal(await Scrobble.countDocuments(), 0);
    const scrubbed = await Job.findOne({ key: "sync:private-state" }).lean();
    assert.deepEqual(scrubbed.payload, {});
    assert.deepEqual(scrubbed.progress, {});
  });

  await t.test("reprocessing checkpoints updates in batches of at most 200 retained events", async () => {
    await reset();
    const conn = await connection();
    const albumId = crypto.randomUUID();
    await AlbumCatalog.create({ albumId, title: "Standard", artistDisplayName: "Artist", artistCredits: [{ name: "Artist", role: "main" }], catalogRevision: 1 });
    const key = mappingKey("Artist", "Deluxe");
    const mapping = await AlbumMapping.create({ key, provider: "lastfm", artist: "Artist", album: "Deluxe", artistKey: normalize("Artist"), albumKey: normalize("Deluxe"), albumId, catalogRevision: 1, revision: 1, reviewer: "moderator", reason: "verified" });
    const rows = Array.from({ length: 201 }, (_, index) => ({
      eventId: crypto.randomUUID(), connectionId: conn._id, connectionRevision: 1, identityKey: `event-${index}`,
      artist: "Artist", album: "Deluxe", track: `Track ${index}`, artistKey: normalize("Artist"), albumKey: normalize("Deluxe"), trackKey: `track ${index}`,
      playedAt: new Date(DUE.getTime() + index * 1_000), expiresAt: new Date(DUE.getTime() + RETENTION_MS), resolution: "unresolved",
    }));
    await Scrobble.insertMany(rows);
    await enqueueJob("reprocess", "reprocess:batching", { key, mappingId: mapping.mappingId, mappingRevision: 1 }, { runAt: DUE });
    const batchSizes = [];
    const originalUpdateMany = Scrobble.updateMany;
    Scrobble.updateMany = function trackedUpdateMany(filter, update, options) {
      if (Array.isArray(filter?._id?.$in)) batchSizes.push(filter._id.$in.length);
      return originalUpdateMany.call(Scrobble, filter, update, options);
    };
    try {
      const result = await runWorkerOnce({
        clock: () => new Date("2026-09-25T14:00:00Z"), env: {}, provider: {},
        discovery: { async discover() { throw new Error("unused"); } }, types: ["reprocess"],
      });
      assert.equal(result.status, "pending");
      const completed = await runWorkerOnce({
        clock: () => new Date("2026-09-25T14:00:02Z"), env: {}, provider: {},
        discovery: { async discover() { throw new Error("unused"); } }, types: ["reprocess"],
      });
      assert.equal(completed.status, "done");
    } finally {
      Scrobble.updateMany = originalUpdateMany;
    }
    assert.deepEqual(batchSizes, [200, 1]);
    assert.equal(await Scrobble.countDocuments({ resolution: "matched" }), 201);
    assert.deepEqual((await Job.findOne({ key: "reprocess:batching" }).lean()).progress, {});
  });

  await t.test("a provider Retry-After cooldown is shared through MongoDB", async () => {
    await reset();
    let firstCalls = 0;
    const env = { LASTFM_API_KEY: "public-key", LASTFM_API_SECRET: "private-secret", LASTFM_RETRIES: "0" };
    const limited = createLastfmProvider({
      env,
      cache: false,
      fetchImpl: async () => {
        firstCalls += 1;
        return { ok: false, status: 429, headers: { get: (name) => String(name).toLowerCase() === "retry-after" ? "60" : null }, async text() { return "{}"; } };
      },
    });
    await assert.rejects(limited.albumInfo({ artist: "Artist", album: "Album" }), (error) => {
      assert.equal(error.code, "lastfm_rate_limited", error.cause?.stack || error.stack);
      return true;
    });
    assert.equal(firstCalls, 1);
    let secondCalls = 0;
    const otherWorker = createLastfmProvider({
      env,
      cache: false,
      fetchImpl: async () => { secondCalls += 1; throw new Error("must not fetch during cooldown"); },
    });
    await assert.rejects(otherWorker.albumInfo({ artist: "Artist", album: "Album" }), (error) => error.code === "lastfm_rate_limited");
    assert.equal(secondCalls, 0);
  });
});
