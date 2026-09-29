const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const AlbumCatalog = require("../models/AlbumCatalog");
const Listen = require("../models/Listen");
const UserProfile = require("../models/UserProfile");
const Listening = require("../models/Listening");
const Baselines = require("../models/AlbumBaseline");
const Automatic = require("../models/AutomaticListen");
const { mappingKey, normalize } = require("../lib/listening/common");
const { enqueueJob, runWorkerOnce } = require("../lib/listening/worker");
const { listDetections, revalidateDetection, setTimeZone } = require("../lib/listening/detectionView");
const { resolvePlay, setAutoDiary } = require("../lib/listening/publication");
const { cleanupUserData } = require("../lib/listening/connections");
const { createListen, deleteListen, updateListen } = require("../routes/utils/listeningDiary");

const { Connection, AlbumMapping, Detection } = Listening;
const { AutomaticListenReceipt, DiaryAlbumFence } = Automatic;
const enabled = String(process.env.RUN_MONGO_INTEGRATION || "").toLowerCase() === "true";
const START = new Date("2026-09-25T12:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ENV = {
  LASTFM_SYNC_ENABLED: "true", LISTENING_DETECTION_ENABLED: "true", LISTENING_AUTO_DIARY_ENABLED: "true", LASTFM_PILOT_USER_IDS: "user-1",
};
let replSet;
let album;

const at = (offset) => new Date(START.getTime() + offset);
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index);
function rows(numbers, startOffset) {
  return numbers.map((number, index) => ({ artist: "Album Artist", album: "Album", track: `Track ${number}`, playedAt: at(startOffset + index * 4 * MINUTE), nowPlaying: false }));
}
function provider(tracks) {
  return { async recentTracks({ from, to, page }) { return { page, totalPages: 1, tracks: tracks.filter((row) => row.playedAt >= new Date(from) && row.playedAt <= new Date(to)) }; } };
}
function options(source, clock, types, env = ENV) {
  return { provider: source, clock: () => clock, env, ownerExists: async () => true, types, discovery: { async discover() { return { candidates: [], evidence: [], evidenceHash: "h" }; } } };
}
async function sync(conn, tracks, clock) {
  const current = await Connection.findById(conn._id).lean();
  await enqueueJob("sync", `sync:${conn._id}`, { connectionId: String(conn._id), connectionRevision: current.revision }, { reopenDone: true, runAt: clock });
  return runWorkerOnce(options(provider(tracks), clock, ["sync"]));
}
async function detect(conn, clock, env = ENV) {
  await enqueueJob("detect", `detect:${conn._id}`, { connectionId: String(conn._id) }, { reopenDone: true, runAt: clock });
  return runWorkerOnce(options(provider([]), clock, ["detect"], env));
}
const optIn = (clock) => setAutoDiary({ userId: "user-1", body: { enabled: true }, env: ENV, clock: () => clock });
const autoListens = () => Listen.find({ userId: "user-1", source: "automatic" }).sort({ createdAt: 1 }).lean();
const plays = async () => (await Detection.find().sort({ startedAt: 1 }).lean()).flatMap((row) => row.plays);

async function setup() {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: "rescened_listening_publication" });
  await Promise.all([AlbumCatalog, Listen, UserProfile, ...Object.values(Listening), ...Object.values(Baselines), ...Object.values(Automatic)].map((Model) => Model.init()));
}
async function teardown() {
  if (mongoose.connection.readyState === 1) { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); }
  if (replSet) await replSet.stop();
}
async function reset({ timeZone = "UTC" } = {}) {
  await Promise.all(Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({})));
  const albumId = crypto.randomUUID();
  album = await AlbumCatalog.create({ albumId, title: "Album", artistDisplayName: "Album Artist", releaseType: "album" });
  const releaseMbid = crypto.randomUUID();
  const baseline = await Baselines.Baseline.create({
    albumId, version: 1, catalogRevision: 1, reviewedByUserId: "moderator", reviewedAt: START, reason: "Reviewed standard",
    candidate: {
      releaseMbid, releaseGroupMbid: crypto.randomUUID(), title: "Album", artistDisplayName: "Album Artist",
      tracks: range(1, 10).map((number) => ({ discNumber: 1, trackNumber: number, title: `Track ${number}`, durationMs: 200_000, artistDisplayName: "Album Artist", releaseTrackMbid: crypto.randomUUID(), recordingMbid: crypto.randomUUID() })),
      retrievedAt: START, sourceUrl: `https://musicbrainz.org/release/${releaseMbid}`, license: "CC0", tracklistHash: crypto.randomBytes(32).toString("hex"),
    },
  });
  await Baselines.Head.create({ targetKind: "albums", targetId: albumId, status: "reviewed", targetRevision: 1, activeBaselineId: baseline._id });
  await AlbumMapping.create({
    key: mappingKey("Album Artist", "Album"), artist: "Album Artist", album: "Album", artistKey: normalize("Album Artist"), albumKey: normalize("Album"),
    albumId, catalogRevision: 1, revision: 1, status: "active", reviewer: "moderator", reason: "Reviewed name pair",
  });
  return Connection.create({ userId: "user-1", username: "listener", usernameKey: "listener", state: "active", revision: 1, connectedAt: START, windows: [{ start: START, end: null }], nextSyncAt: START, timeZone });
}

test("automatic diary publication MongoDB integration", { skip: !enabled }, async (t) => {
  await setup();
  t.after(teardown);

  await t.test("nothing publishes without the flag, the opt-in, and a saved time zone", async () => {
    const conn = await reset({ timeZone: null });
    await sync(conn, rows(range(1, 10), 10 * MINUTE), at(HOUR));
    await detect(conn, at(HOUR));
    assert.equal((await autoListens()).length, 0);
    await assert.rejects(optIn(at(HOUR)), { code: "TIME_ZONE_REQUIRED" });
    await assert.rejects(setAutoDiary({ userId: "user-1", body: { enabled: true }, env: { ...ENV, LISTENING_AUTO_DIARY_ENABLED: "false" } }), { code: "LISTENING_AUTO_DIARY_DISABLED" });
    await assert.rejects(setAutoDiary({ userId: "user-1", body: { enabled: "yes" }, env: ENV }), { code: "INVALID_REQUEST" });
  });

  await t.test("plays qualifying after opt-in publish once, with receipts, and replays publish separately", async () => {
    const conn = await reset();
    // Qualified before opt-in: never imported.
    await sync(conn, rows(range(1, 10), 10 * MINUTE), at(HOUR));
    await optIn(at(HOUR));
    await detect(conn, at(HOUR));
    assert.equal((await autoListens()).length, 0);
    const later = [...rows(range(1, 10), 10 * MINUTE), ...rows(range(1, 10), 5 * HOUR), ...rows(range(1, 10), 5 * HOUR + 45 * MINUTE)];
    await sync(conn, later, at(7 * HOUR));
    await detect(conn, at(7 * HOUR));
    const listens = await autoListens();
    assert.deepEqual(listens.map((row) => row.listenedOn), ["2026-09-25", "2026-09-25"]);
    assert.equal(await AutomaticListenReceipt.countDocuments({ outcome: "published" }), 2);
    const published = (await plays()).filter((play) => play.publication === "published");
    assert.deepEqual(published.map((play) => play.listenId).sort(), listens.map((row) => row.listenId).sort());
    await detect(conn, at(8 * HOUR));
    assert.equal((await autoListens()).length, 2, "reconciliation never republishes");
    const receipt = await AutomaticListenReceipt.findOne().lean();
    assert.equal(receipt.expiresAt.getUTCHours(), 0);
    assert.ok(!("playedAt" in receipt) && !("eventIds" in receipt));
  });

  await t.test("deleted automatic listens stay deleted and date corrections are kept", async () => {
    const conn = await reset();
    await optIn(START);
    await sync(conn, [...rows(range(1, 10), 10 * MINUTE), ...rows(range(1, 10), 5 * HOUR)], at(7 * HOUR));
    await detect(conn, at(7 * HOUR));
    const [first, second] = await autoListens();
    await deleteListen("user-1", first.listenId);
    await updateListen("user-1", second.listenId, { listenedOn: "2026-09-20", timeZone: "UTC" });
    await detect(conn, at(9 * HOUR));
    // Even a lost lineage cannot resurrect it: the receipt matches the play's events.
    await Detection.deleteMany({});
    await detect(conn, at(9 * HOUR));
    const remaining = await autoListens();
    assert.deepEqual(remaining.map((row) => [row.listenId, row.listenedOn]), [[second.listenId, "2026-09-20"]]);
    assert.deepEqual((await plays()).map((play) => play.publication), ["suppressed", "suppressed"]);
  });

  await t.test("pause blocks automatic publication", async () => {
    const conn = await reset();
    await optIn(START);
    await sync(conn, rows(range(1, 10), 10 * MINUTE), at(HOUR));
    await Connection.updateOne({ _id: conn._id }, { $set: { state: "paused", "windows.0.end": at(2 * HOUR) }, $inc: { revision: 1 } });
    await detect(conn, at(2 * HOUR));
    assert.equal((await autoListens()).length, 0);
    assert.deepEqual((await plays()).map((play) => play.publication), [null]);
  });

  await t.test("older qualifications become owner suggestions that can be confirmed or dismissed", async () => {
    const conn = await reset();
    await optIn(START);
    await sync(conn, [...rows(range(1, 10), 10 * MINUTE), ...rows(range(1, 10), 55 * MINUTE)], at(7 * HOUR));
    const late = at(8 * DAY + 7 * HOUR);
    await detect(conn, late);
    assert.equal((await autoListens()).length, 0);
    const [session] = await Detection.find().lean();
    assert.deepEqual(session.plays.map((play) => play.publication), ["needs_confirmation", "needs_confirmation"]);
    const request = (playId, action) => resolvePlay({ userId: "user-1", sessionId: session.sessionId, playId, action, env: ENV, clock: () => late, revalidate: revalidateDetection });
    const confirmed = await request(session.plays[0].playId, "confirm");
    assert.equal(confirmed.publication, "published");
    assert.equal((await request(session.plays[0].playId, "confirm")).listenId, confirmed.listenId, "confirm is idempotent");
    assert.equal((await request(session.plays[1].playId, "dismiss")).publication, "dismissed");
    await assert.rejects(request(session.plays[1].playId, "confirm"), { code: "PLAY_NOT_RESOLVABLE" });
    await detect(conn, at(8 * DAY + 8 * HOUR));
    assert.deepEqual((await plays()).map((play) => play.publication), ["published", "dismissed"]);
    assert.equal((await autoListens()).length, 1);
    const owner = await listDetections({ userId: "user-1", env: ENV, clock: () => late });
    assert.deepEqual(owner.items[0].plays.map((play) => play.publication), ["published", "dismissed"]);
  });

  await t.test("a manual entry within one day holds automatic publication for owner resolution", async () => {
    const conn = await reset();
    await optIn(START);
    await Listen.create({ userId: "user-1", albumCatalogId: album._id, listenedOn: "2026-09-26" });
    await sync(conn, rows(range(1, 10), 10 * MINUTE), at(HOUR));
    await detect(conn, at(HOUR));
    assert.equal((await autoListens()).length, 0);
    const [session] = await Detection.find().lean();
    assert.equal(session.plays[0].publication, "manual_duplicate");
    const result = await resolvePlay({ userId: "user-1", sessionId: session.sessionId, playId: session.plays[0].playId, action: "confirm", env: ENV, clock: () => at(HOUR), revalidate: revalidateDetection });
    assert.equal(result.publication, "published");
    assert.equal((await autoListens()).length, 1);

    const farther = await reset();
    await optIn(START);
    await Listen.create({ userId: "user-1", albumCatalogId: album._id, listenedOn: "2026-09-23" });
    await sync(farther, rows(range(1, 10), 10 * MINUTE), at(HOUR));
    await detect(farther, at(HOUR));
    assert.equal((await autoListens()).length, 1, "two days away is not a duplicate");
  });

  await t.test("held detections cannot be confirmed", async () => {
    const conn = await reset();
    await optIn(START);
    await Listen.create({ userId: "user-1", albumCatalogId: album._id, listenedOn: "2026-09-25" });
    await sync(conn, rows(range(1, 10), 10 * MINUTE), at(HOUR));
    await detect(conn, at(HOUR));
    const [session] = await Detection.find().lean();
    await AlbumMapping.updateOne({}, { $set: { status: "revoked" }, $inc: { revision: 1 } });
    await assert.rejects(
      resolvePlay({ userId: "user-1", sessionId: session.sessionId, playId: session.plays[0].playId, action: "confirm", env: ENV, clock: () => at(HOUR), revalidate: revalidateDetection }),
      { code: "DETECTION_HELD" },
    );
    assert.equal((await autoListens()).length, 0);
  });

  await t.test("a published play is fixed when later evidence would move it", async () => {
    const conn = await reset();
    await optIn(START);
    const first = rows(range(1, 10), 30 * MINUTE);
    await sync(conn, first, at(2 * HOUR));
    await detect(conn, at(2 * HOUR));
    const [listen] = await autoListens();
    // A late scrobble just before the play would become its first event.
    await Listening.Scrobble.create({
      connectionId: conn._id, connectionRevision: 1, identityKey: "late", artist: "Album Artist", album: "Album", track: "Track 4",
      artistKey: normalize("Album Artist"), albumKey: normalize("Album"), trackKey: normalize("Track 4"), playedAt: at(20 * MINUTE),
      expiresAt: new Date(at(20 * MINUTE).getTime() + 30 * DAY), resolution: "matched",
    });
    await detect(conn, at(3 * HOUR));
    const [session] = await Detection.find().lean();
    assert.deepEqual(session.holds, ["reconciliation_required"]);
    assert.deepEqual((await autoListens()).map((row) => [row.listenId, row.listenedOn]), [[listen.listenId, listen.listenedOn]]);
  });

  await t.test("manual and automatic creation share an album fence", async () => {
    const conn = await reset();
    await optIn(START);
    await sync(conn, rows(range(1, 10), 10 * MINUTE), at(HOUR));
    await Promise.all([
      detect(conn, at(HOUR)),
      createListen("user-1", { albumId: album.albumId, listenedOn: "2026-09-25", timeZone: "UTC" }, crypto.randomUUID()),
    ]);
    const manual = await Listen.countDocuments({ source: "manual" });
    const automatic = await autoListens();
    const [play] = await plays();
    assert.equal(manual, 1);
    // Either the automatic entry committed first, or it saw the manual one and held.
    if (automatic.length) assert.equal(play.publication, "published");
    else assert.equal(play.publication, "manual_duplicate");
    assert.ok((await DiaryAlbumFence.findOne({ userId: "user-1" }).lean()).revision >= 2);
  });

  await t.test("opting out keeps published entries and account deletion removes them with receipts and fences", async () => {
    const conn = await reset();
    await optIn(START);
    await sync(conn, rows(range(1, 10), 10 * MINUTE), at(HOUR));
    await detect(conn, at(HOUR));
    await setAutoDiary({ userId: "user-1", body: { enabled: false }, env: ENV, clock: () => at(2 * HOUR) });
    await detect(conn, at(2 * HOUR));
    assert.equal((await autoListens()).length, 1);
    assert.equal((await Connection.findById(conn._id).lean()).autoDiaryEnabledAt, null);
    await cleanupUserData("user-1");
    assert.equal(await AutomaticListenReceipt.countDocuments(), 0);
    assert.equal(await DiaryAlbumFence.countDocuments(), 0);
    assert.equal(await Listen.countDocuments({ userId: "user-1" }), 0);
  });

  await t.test("opting in dates later sessions in the saved zone", async () => {
    const conn = await reset({ timeZone: null });
    await setTimeZone({ userId: "user-1", body: { timeZone: "Asia/Tokyo" }, env: ENV, clock: () => START });
    await optIn(START);
    // 16:00 UTC on September 25 is already September 26 in Tokyo.
    await sync(conn, rows(range(1, 10), 4 * HOUR), at(6 * HOUR));
    await detect(conn, at(6 * HOUR));
    assert.deepEqual((await autoListens()).map((row) => row.listenedOn), ["2026-09-26"]);
  });
});
