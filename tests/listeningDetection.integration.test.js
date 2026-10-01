const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const AlbumCatalog = require("../models/AlbumCatalog");
const Listen = require("../models/Listen");
const Listening = require("../models/Listening");
const Baselines = require("../models/AlbumBaseline");
const { mappingKey, normalize } = require("../lib/listening/common");
const { listDetections, setTimeZone } = require("../lib/listening/detectionView");
const { enqueueJob, runWorkerOnce, scheduleDueDetectionJobs, scheduleDueSweepJobs, SWEEP_INTERVAL_MS } = require("../lib/listening/worker");

const { Connection, Scrobble, AlbumMapping, Job, Detection, DetectionEvidence } = Listening;
const enabled = String(process.env.RUN_MONGO_INTEGRATION || "").toLowerCase() === "true";
const START = new Date("2026-09-25T12:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ENV = {
  LASTFM_SYNC_ENABLED: "true", LASTFM_DISCOVERY_ENABLED: "false", LISTENING_DETECTION_ENABLED: "true",
  LASTFM_DEEP_SWEEP_ENABLED: "true", LASTFM_PILOT_USER_IDS: "user-1",
};
let replSet;
let albumId;

const hex = () => crypto.randomBytes(32).toString("hex");
const at = (offset) => new Date(START.getTime() + offset);
function row(number, offset, extra = {}) {
  return { artist: "Album Artist", album: "Album", track: `Track ${number}`, playedAt: at(offset), nowPlaying: false, ...extra };
}
function rows(numbers, startOffset) { return numbers.map((number, index) => row(number, startOffset + index * 4 * MINUTE)); }
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index);
function provider(pages) {
  const calls = [];
  return {
    calls,
    async recentTracks({ from, to, page }) {
      calls.push({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), page });
      const tracks = pages.filter((item) => item.playedAt >= new Date(from) && item.playedAt <= new Date(to));
      return { page, totalPages: 1, tracks };
    },
  };
}
function options(source, clock, types, env = ENV) {
  return { provider: source, clock: () => clock, env, ownerExists: async () => true, types, discovery: { async discover() { return { candidates: [], evidence: [], evidenceHash: "hash" }; } } };
}

async function setup() {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: "rescened_listening_detection" });
  await Promise.all([AlbumCatalog, Listen, ...Object.values(Listening), ...Object.values(Baselines)].map((Model) => Model.init()));
}
async function teardown() {
  if (mongoose.connection.readyState === 1) { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); }
  if (replSet) await replSet.stop();
}
async function reset() {
  await Promise.all(Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({})));
  albumId = crypto.randomUUID();
  await AlbumCatalog.create({ albumId, title: "Album", artistDisplayName: "Album Artist", releaseType: "album" });
  const releaseMbid = crypto.randomUUID();
  const baseline = await Baselines.Baseline.create({
    albumId, version: 1, catalogRevision: 1, reviewedByUserId: "moderator", reviewedAt: START, reason: "Reviewed standard",
    candidate: {
      releaseMbid, releaseGroupMbid: crypto.randomUUID(), title: "Album", artistDisplayName: "Album Artist", tracks: range(1, 10).map((number) => ({
        discNumber: 1, trackNumber: number, title: `Track ${number}`, durationMs: 200_000, artistDisplayName: "Album Artist",
        releaseTrackMbid: crypto.randomUUID(), recordingMbid: crypto.randomUUID(),
      })),
      retrievedAt: START, sourceUrl: `https://musicbrainz.org/release/${releaseMbid}`, license: "CC0", tracklistHash: hex(),
    },
  });
  await Baselines.Head.create({ targetKind: "albums", targetId: albumId, status: "reviewed", targetRevision: 1, activeBaselineId: baseline._id });
  await AlbumMapping.create({
    key: mappingKey("Album Artist", "Album"), artist: "Album Artist", album: "Album", artistKey: normalize("Album Artist"), albumKey: normalize("Album"),
    albumId, catalogRevision: 1, revision: 1, status: "active", reviewer: "moderator", reason: "Reviewed name pair",
  });
  return Connection.create({ userId: "user-1", username: "listener", usernameKey: "listener", state: "active", revision: 1, connectedAt: START, windows: [{ start: START, end: null }], nextSyncAt: START });
}
async function sync(conn, source, clock, env = ENV) {
  await enqueueJob("sync", `sync:${conn._id}`, { connectionId: String(conn._id), connectionRevision: (await Connection.findById(conn._id)).revision }, { reopenDone: true, runAt: clock });
  return runWorkerOnce(options(source, clock, ["sync"], env));
}
async function detect(conn, clock, env = ENV) {
  await enqueueJob("detect", `detect:${conn._id}`, { connectionId: String(conn._id) }, { reopenDone: true, runAt: clock });
  return runWorkerOnce(options(provider([]), clock, ["detect"], env));
}

test("listening detection MongoDB integration", { skip: !enabled }, async (t) => {
  await setup();
  t.after(teardown);

  await t.test("a completed sync window queues private detection with no diary writes", async () => {
    const conn = await reset();
    const clock = at(4 * HOUR);
    assert.equal((await sync(conn, provider(rows(range(1, 10), 10 * MINUTE)), clock)).status, "done");
    const job = await Job.findOne({ key: `detect:${conn._id}` }).lean();
    assert.equal(job.status, "pending");
    assert.equal((await detect(conn, clock)).status, "done");
    const [detection] = await Detection.find().lean();
    assert.equal(detection.albumId, albumId);
    assert.equal(detection.coverage, "qualified");
    assert.equal(detection.lifecycle, "closed");
    assert.equal(detection.baseline.version, 1);
    assert.deepEqual(detection.plays.map((item) => [item.ordinal, item.distinct, item.required]), [[1, 10, 8]]);
    assert.ok(detection.plays[0].evidenceExpiresAt);
    assert.equal(await DetectionEvidence.countDocuments({ sessionId: detection.sessionId }), 10);
    assert.equal(await Listen.countDocuments(), 0);
  });

  await t.test("detection is not queued when its flag is off", async () => {
    const conn = await reset();
    await sync(conn, provider(rows(range(1, 10), 10 * MINUTE)), at(4 * HOUR), { ...ENV, LISTENING_DETECTION_ENABLED: "false" });
    assert.equal(await Job.countDocuments({ type: "detect" }), 0);
    assert.equal((await detect(conn, at(4 * HOUR), { ...ENV, LISTENING_DETECTION_ENABLED: "false" })).processed, false);
  });

  await t.test("recomputation keeps stable identity and replays become a second play", async () => {
    const conn = await reset();
    const first = rows(range(1, 10), 10 * MINUTE);
    await sync(conn, provider(first), at(HOUR));
    await detect(conn, at(HOUR));
    const original = await Detection.findOne().lean();
    assert.equal(original.lifecycle, "open");
    await detect(conn, at(HOUR));
    assert.equal((await Detection.findOne().lean()).processingRevision, original.processingRevision, "no-op rerun does not rewrite");
    await sync(conn, provider([...first, ...rows(range(1, 10), 55 * MINUTE)]), at(4 * HOUR));
    await detect(conn, at(4 * HOUR));
    const replayed = await Detection.find().lean();
    assert.equal(replayed.length, 1);
    assert.equal(replayed[0].sessionId, original.sessionId);
    assert.equal(replayed[0].plays[0].playId, original.plays[0].playId);
    assert.deepEqual(replayed[0].plays.map((item) => item.coverage), ["qualified", "qualified"]);
    assert.equal(replayed[0].processingRevision, original.processingRevision + 1);
  });

  await t.test("mapping revocation revalidates paused connections and holds the session", async () => {
    const conn = await reset();
    await sync(conn, provider(rows(range(1, 10), 10 * MINUTE)), at(4 * HOUR));
    await detect(conn, at(4 * HOUR));
    await Connection.updateOne({ _id: conn._id }, { $set: { state: "paused", "windows.0.end": at(5 * HOUR) }, $inc: { revision: 1 } });
    const mapping = await AlbumMapping.findOneAndUpdate({}, { $set: { status: "revoked" }, $inc: { revision: 1 } }, { returnDocument: "after" }).lean();
    await enqueueJob("reprocess", `reprocess:${mapping.key}:${mapping.revision}`, { key: mapping.key, mappingId: mapping.mappingId, mappingRevision: mapping.revision }, { runAt: at(6 * HOUR) });
    assert.equal((await runWorkerOnce(options(provider([]), at(6 * HOUR), ["reprocess"]))).status, "done");
    assert.equal((await Job.findOne({ key: `detect:${conn._id}` }).lean()).status, "pending");
    await detect(conn, at(6 * HOUR));
    const held = await Detection.findOne().lean();
    assert.deepEqual(held.holds, ["stale_mapping"]);
    assert.equal(held.coverage, "qualified");
  });

  await t.test("expired evidence leaves a visible expired detection", async () => {
    const conn = await reset();
    await sync(conn, provider(rows(range(1, 10), 10 * MINUTE)), at(4 * HOUR));
    await detect(conn, at(4 * HOUR));
    await Connection.updateOne({ _id: conn._id }, { $set: { state: "paused", "windows.0.end": at(5 * HOUR) }, $inc: { revision: 1 } });
    assert.equal(await scheduleDueDetectionJobs({ clock: () => at(10 * DAY), env: ENV }), 0);
    // Paused connections never sync, so expiry itself must schedule the recheck.
    assert.equal(await scheduleDueDetectionJobs({ clock: () => at(31 * DAY), env: ENV }), 1);
    await runWorkerOnce(options(provider([]), at(31 * DAY), ["detect"]));
    assert.equal(await scheduleDueDetectionJobs({ clock: () => at(32 * DAY), env: ENV }), 0);
    const expired = await Detection.findOne().lean();
    assert.deepEqual(expired.holds, ["evidence_expired"]);
    assert.ok(expired.expiresAt > at(31 * DAY));
  });

  await t.test("duplicate deliveries that disagree on IDs are marked and held from counting", async () => {
    const conn = await reset();
    const clock = at(4 * HOUR);
    const base = rows(range(1, 10), 10 * MINUTE);
    await sync(conn, provider(base.map((item, index) => (index === 0 ? { ...item, trackMbid: crypto.randomUUID() } : item))), clock);
    await sync(conn, provider(base.map((item, index) => (index === 0 ? { ...item, trackMbid: crypto.randomUUID() } : item))), clock);
    assert.equal(await Scrobble.countDocuments(), 10);
    assert.equal(await Scrobble.countDocuments({ identityConflict: true }), 1);
    assert.equal(await Scrobble.countDocuments({ identityConflictFields: ["trackMbid"] }), 1);
    await detect(conn, clock);
    const detection = await Detection.findOne().lean();
    assert.equal(detection.plays[0].distinct, 9);
  });

  await t.test("duplicate deliveries that disagree only on album or artist IDs are recorded but still counted", async () => {
    const conn = await reset();
    const clock = at(4 * HOUR);
    const base = rows(range(1, 10), 10 * MINUTE);
    const release = (albumMbid) => base.map((item, index) => (index < 4 ? { ...item, albumMbid, artistMbid: albumMbid } : item));
    await sync(conn, provider(release(crypto.randomUUID())), clock);
    await sync(conn, provider(release(crypto.randomUUID())), clock);
    assert.equal(await Scrobble.countDocuments(), 10);
    assert.equal(await Scrobble.countDocuments({ identityConflict: true }), 0);
    const recorded = await Scrobble.find({ "identityConflictFields.0": { $exists: true } }).lean();
    assert.equal(recorded.length, 4);
    recorded.forEach((item) => assert.deepEqual([...item.identityConflictFields].sort(), ["albumMbid", "artistMbid"]));
    await detect(conn, clock);
    const detection = await Detection.findOne().lean();
    assert.equal(detection.plays[0].distinct, 10);
  });

  await t.test("deep sweep fetches late back-dated scrobbles without moving the sync cursor", async () => {
    const conn = await reset();
    const live = rows([1, 2, 3, 4, 5], 10 * MINUTE);
    const offline = rows([6, 7, 8, 9, 10], 30 * MINUTE);
    const clock = at(3 * DAY);
    await sync(conn, provider(live), clock);
    const cursor = (await Connection.findById(conn._id).lean()).completedThrough;
    // Next regular sync starts 48 hours before the cursor, so the offline plays stay unseen.
    await sync(conn, provider([...live, ...offline]), at(3 * DAY + 10 * MINUTE));
    assert.equal(await Scrobble.countDocuments(), 5);
    assert.equal(await scheduleDueSweepJobs({ clock: () => clock, env: ENV }), 1);
    const source = provider([...live, ...offline]);
    assert.equal((await runWorkerOnce(options(source, clock, ["sweep"]))).status, "done");
    assert.equal(source.calls[0].from, START.toISOString());
    assert.equal(await Scrobble.countDocuments(), 10);
    const after = await Connection.findById(conn._id).lean();
    assert.ok(after.completedThrough >= cursor);
    assert.equal(after.lastSweepAt.toISOString(), clock.toISOString());
    assert.equal(await scheduleDueSweepJobs({ clock: () => new Date(clock.getTime() + HOUR), env: ENV }), 0);
    assert.equal(await scheduleDueSweepJobs({ clock: () => new Date(clock.getTime() + SWEEP_INTERVAL_MS), env: ENV }), 1);
    await detect(conn, clock);
    assert.equal((await Detection.findOne().lean()).coverage, "qualified");
  });

  await t.test("deep sweep is off by default and yields to regular jobs", async () => {
    const conn = await reset();
    const clock = at(4 * HOUR);
    await sync(conn, provider([]), clock);
    assert.equal(await scheduleDueSweepJobs({ clock: () => clock, env: { ...ENV, LASTFM_DEEP_SWEEP_ENABLED: "false" } }), 0);
    await enqueueJob("sweep", `sweep:${conn._id}`, { connectionId: String(conn._id), connectionRevision: 1 }, { runAt: at(0) });
    await enqueueJob("sync", `sync:${conn._id}`, { connectionId: String(conn._id), connectionRevision: 1 }, { reopenDone: true, runAt: clock });
    const next = await runWorkerOnce(options(provider([]), clock, ["sync", "sweep"]));
    assert.equal(next.type, "sync");
  });

  await t.test("a detection request during a running detect job reruns it once", async () => {
    const conn = await reset();
    await sync(conn, provider(rows(range(1, 10), 10 * MINUTE)), at(4 * HOUR));
    await Job.updateOne({ key: `detect:${conn._id}` }, { $set: { status: "running", leaseToken: "held", leaseUntil: at(5 * HOUR) } });
    await enqueueJob("detect", `detect:${conn._id}`, { connectionId: String(conn._id) }, { reopenDone: true, rerunRunning: true, runAt: at(4 * HOUR) });
    await Job.updateOne({ key: `detect:${conn._id}` }, { $set: { status: "pending", leaseToken: "", leaseUntil: null } });
    assert.equal((await runWorkerOnce(options(provider([]), at(4 * HOUR), ["detect"]))).status, "pending");
    assert.equal((await runWorkerOnce(options(provider([]), at(4 * HOUR), ["detect"]))).status, "done");
    assert.equal(await Detection.countDocuments(), 1);
  });

  await t.test("a saved time zone dates sessions, and later changes date only later sessions", async () => {
    const conn = await reset();
    await sync(conn, provider(rows(range(1, 10), 10 * MINUTE)), at(4 * HOUR));
    await detect(conn, at(4 * HOUR));
    assert.equal((await Detection.findOne().lean()).plays[0].proposedDate, null);
    const saved = await setTimeZone({ userId: "user-1", body: { timeZone: "america/new_york" }, env: ENV, clock: () => at(4 * HOUR) });
    assert.equal(saved.timeZone, "America/New_York");
    assert.equal((await Job.findOne({ key: `detect:${conn._id}` }).lean()).status, "pending");
    await runWorkerOnce(options(provider([]), at(4 * HOUR), ["detect"]));
    const dated = await Detection.findOne().lean();
    assert.equal(dated.timeZone, "America/New_York");
    assert.equal(dated.plays[0].proposedDate, "2026-09-25");
    await setTimeZone({ userId: "user-1", body: { timeZone: "Asia/Tokyo" }, env: ENV, clock: () => at(5 * HOUR) });
    // 23:00 UTC on September 26 is already September 27 in Tokyo.
    const later = rows(range(1, 10), 35 * HOUR);
    await sync(conn, provider([...rows(range(1, 10), 10 * MINUTE), ...later]), at(40 * HOUR));
    await detect(conn, at(40 * HOUR));
    const sessions = await Detection.find().sort({ startedAt: 1 }).lean();
    assert.deepEqual(sessions.map((item) => [item.timeZone, item.plays[0].proposedDate]), [["America/New_York", "2026-09-25"], ["Asia/Tokyo", "2026-09-27"]]);
  });

  await t.test("time zone input accepts only IANA names for connected pilot owners", async () => {
    await reset();
    for (const timeZone of ["Mars/Olympus", "+05:00", "", 5]) {
      await assert.rejects(setTimeZone({ userId: "user-1", body: { timeZone }, env: ENV }), { code: "INVALID_TIME_ZONE" });
    }
    await assert.rejects(setTimeZone({ userId: "user-1", body: { timeZone: "UTC", extra: true }, env: ENV }), { code: "INVALID_REQUEST" });
    await assert.rejects(setTimeZone({ userId: "user-2", body: { timeZone: "UTC" }, env: ENV }), { code: "LASTFM_PILOT_REQUIRED" });
    await assert.rejects(setTimeZone({ userId: "user-2", body: { timeZone: "UTC" }, env: { ...ENV, LASTFM_PILOT_USER_IDS: "user-1,user-2" } }), { code: "LASTFM_NOT_CONNECTED" });
    await assert.rejects(setTimeZone({ userId: "user-1", body: { timeZone: "UTC" }, env: { ...ENV, LISTENING_DETECTION_ENABLED: "false" } }), { code: "LISTENING_DETECTION_DISABLED" });
  });

  await t.test("owner reads summarize detections and revalidate without persisting", async () => {
    const conn = await reset();
    await setTimeZone({ userId: "user-1", body: { timeZone: "UTC" }, env: ENV, clock: () => START });
    await sync(conn, provider([...rows(range(1, 10), 10 * MINUTE), ...rows([1, 2, 3], 5 * HOUR)]), at(8 * HOUR));
    await detect(conn, at(8 * HOUR));
    const first = await listDetections({ userId: "user-1", limit: 1, env: ENV, clock: () => at(8 * HOUR) });
    assert.equal(first.items.length, 1);
    assert.ok(first.nextCursor);
    const [latest] = first.items;
    assert.equal(latest.album.title, "Album");
    assert.equal(latest.coverage, "below_threshold");
    assert.deepEqual(latest.plays.map((item) => [item.distinct, item.required, item.proposedDate]), [[3, 8, "2026-09-25"]]);
    assert.deepEqual(Object.keys(latest).sort(), ["album", "countable", "coverage", "holds", "lifecycle", "plays", "sessionId", "timeZone"]);
    assert.ok(!JSON.stringify(first).includes("eventId"));
    const second = await listDetections({ userId: "user-1", cursor: first.nextCursor, env: ENV, clock: () => at(8 * HOUR) });
    assert.equal(second.items[0].coverage, "qualified");
    assert.equal((await listDetections({ userId: "user-1", coverage: "qualified", env: ENV, clock: () => at(8 * HOUR) })).items.length, 1);

    await AlbumMapping.updateOne({}, { $set: { status: "revoked" }, $inc: { revision: 1 } });
    const revoked = await listDetections({ userId: "user-1", coverage: "qualified", env: ENV, clock: () => at(8 * HOUR) });
    assert.deepEqual(revoked.items[0].holds, ["stale_mapping"]);
    await AlbumMapping.updateOne({}, { $set: { status: "active" } });
    const lapsed = await listDetections({ userId: "user-1", coverage: "qualified", env: ENV, clock: () => at(31 * DAY) });
    assert.deepEqual(lapsed.items[0].holds, ["evidence_expired"]);
    assert.ok((await Detection.find().lean()).every((item) => item.holds.length === 0), "reads never persist holds");

    await assert.rejects(listDetections({ userId: "user-1", env: { ...ENV, LISTENING_DETECTION_ENABLED: "false" } }), { code: "LISTENING_DETECTION_DISABLED" });
    await assert.rejects(listDetections({ userId: "user-2", env: ENV }), { code: "LASTFM_PILOT_REQUIRED" });
    assert.deepEqual(await listDetections({ userId: "user-2", env: { ...ENV, LASTFM_PILOT_USER_IDS: "user-1,user-2" } }), { items: [], nextCursor: null });
    await assert.rejects(listDetections({ userId: "user-1", coverage: "held", env: ENV }), { code: "INVALID_STATUS" });
    await assert.rejects(listDetections({ userId: "user-1", limit: 51, env: ENV }), { code: "INVALID_LIMIT" });
    await assert.rejects(listDetections({ userId: "user-1", cursor: "bogus", env: ENV }), { code: "INVALID_CURSOR" });
  });

  await t.test("disconnect cleanup removes private detections and evidence", async () => {
    const conn = await reset();
    await sync(conn, provider(rows(range(1, 10), 10 * MINUTE)), at(4 * HOUR));
    await detect(conn, at(4 * HOUR));
    await Connection.updateOne({ _id: conn._id }, { $set: { state: "disconnected" }, $inc: { revision: 1 } });
    await enqueueJob("cleanup", `cleanup:${conn._id}:2`, { connectionId: String(conn._id), connectionRevision: 2, userId: "user-1" }, { runAt: at(5 * HOUR) });
    await runWorkerOnce(options(provider([]), at(5 * HOUR), ["cleanup"]));
    assert.equal(await Detection.countDocuments(), 0);
    assert.equal(await DetectionEvidence.countDocuments(), 0);
  });
});
