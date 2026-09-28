const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const AlbumCatalog = require("../models/AlbumCatalog");
const AlbumSubmission = require("../models/AlbumSubmission");
const Models = require("../models/AlbumBaseline");
const Listening = require("../models/Listening");
const { hashCandidateTracklist } = require("../lib/baselines/musicBrainz");
const { baselineForAlbum, detail, invalidateAlbumBaseline, list, performCommand, queueEnrichmentCandidate, reviewStatusCounts, storeCandidate } = require("../lib/baselines/service");
const { approveAlbumSubmission } = require("../routes/utils/approval");
const { findDuplicateSignals, normalizeSubmissionPayload, snapshotForSubmission } = require("../routes/utils/submissions");

const enabled = String(process.env.RUN_MONGO_INTEGRATION || "").toLowerCase() === "true";
let replSet;

function mbid() { return crypto.randomUUID(); }
function makeCandidate({ releaseGroupMbid = mbid(), title = "Pilot", tracks } = {}) {
  const releaseMbid = mbid();
  const value = {
    releaseMbid, releaseGroupMbid, title, artistDisplayName: "Artist", date: "2026", country: "US",
    formats: ["Digital Media"], disambiguation: "", status: "Official",
    tracks: tracks || [{ discNumber: 1, trackNumber: 1, title: "One", durationMs: 1000, artistDisplayName: "Artist", releaseTrackMbid: mbid(), recordingMbid: mbid() }],
    retrievedAt: new Date(), sourceUrl: `https://musicbrainz.org/release/${releaseMbid}`, license: "CC0", tracklistHash: "",
  };
  value.tracklistHash = hashCandidateTracklist(value);
  return value;
}
function albumInput({ albumId = crypto.randomUUID(), releaseGroupMbid = mbid(), tracks = [] } = {}) {
  return { albumId, title: "Pilot", artistDisplayName: "Artist", releaseType: "album", tracks, catalogRevision: 1, externalReferences: [{ provider: "musicbrainz", entityType: "release-group", externalId: releaseGroupMbid, url: `https://musicbrainz.org/release-group/${releaseGroupMbid}` }] };
}
async function createSubmission(releaseGroupMbid) {
  const payload = normalizeSubmissionPayload({ proposedMetadata: { title: "Submitted Pilot", artistCredits: [{ name: "Artist" }], releaseType: "album", releaseDate: "2026" }, supportingSources: [{ type: "musicbrainz", url: `https://musicbrainz.org/release-group/${releaseGroupMbid}` }], externalReferences: [{ provider: "musicbrainz", entityType: "release-group", externalId: releaseGroupMbid, url: `https://musicbrainz.org/release-group/${releaseGroupMbid}` }] });
  const duplicate = await findDuplicateSignals(payload); const submittedAt = new Date();
  return AlbumSubmission.create({ submissionId: crypto.randomUUID(), submittedByUserId: "integration-user", proposedMetadata: payload.proposedMetadata, supportingSources: payload.supportingSources, externalReferences: payload.externalReferences, normalizedFingerprint: duplicate.fingerprint, status: "pending", currentRevision: 1, revisions: [snapshotForSubmission(payload, duplicate, submittedAt, 1)], moderationHistory: [{ actorUserId: "integration-user", action: "submitted", reason: "", createdAt: submittedAt }] });
}
async function command(kind, id, action, expectedRevision, expectedTargetRevision, candidate, requestId = crypto.randomUUID()) {
  return performCommand({ kind, id, action, actorUserId: "integration-moderator", body: { expectedRevision, expectedTargetRevision, reason: `${action} reviewed release`, requestId, ...(candidate ? { releaseMbid: candidate.releaseMbid, releaseGroupMbid: candidate.releaseGroupMbid, candidateHash: candidate.tracklistHash } : {}) } });
}
async function clean() {
  await Promise.all([AlbumCatalog.deleteMany({}), AlbumSubmission.deleteMany({}), Models.Baseline.deleteMany({}), Models.Candidate.deleteMany({}), Models.Head.deleteMany({}), Models.Audit.deleteMany({}), Listening.AlbumMapping.deleteMany({}), Listening.Job.deleteMany({})]);
}

test.before(async () => {
  if (!enabled) return;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: "rescened_album_baselines" });
  await Promise.all([AlbumCatalog.syncIndexes(), AlbumSubmission.syncIndexes(), ...Object.values(Models).map((model) => model.syncIndexes()), Listening.AlbumMapping.syncIndexes(), Listening.Job.syncIndexes()]);
  process.env.TRACKLIST_BASELINE_MODERATION_ENABLED = "true"; process.env.COMMUNITY_MODERATION_ENABLED = "true";
});
test.beforeEach(async () => { if (enabled) await clean(); });
test.after(async () => {
  if (!enabled) return;
  await mongoose.connection.dropDatabase(); await mongoose.disconnect(); await replSet.stop();
  delete process.env.TRACKLIST_BASELINE_MODERATION_ENABLED; delete process.env.COMMUNITY_MODERATION_ENABLED;
});

test("confirm fills empty tracks, advances unchanged mappings, and retries idempotently", { skip: !enabled }, async () => {
  const group = mbid(); const album = await AlbumCatalog.create(albumInput({ releaseGroupMbid: group })); const candidate = makeCandidate({ releaseGroupMbid: group });
  await storeCandidate("albums", album, candidate);
  await Listening.AlbumMapping.create({ mappingId: crypto.randomUUID(), key: "lastfm|artist|pilot", provider: "lastfm", artist: "Artist", album: "Pilot", artistKey: "artist", albumKey: "pilot", albumId: album.albumId, catalogRevision: 1, revision: 1, status: "active", reviewer: "moderator", reason: "reviewed" });
  const requestId = crypto.randomUUID(); const result = await command("albums", album.albumId, "confirm", 0, 1, candidate, requestId);
  assert.equal(result.status, "reviewed"); assert.equal(result.revision, 1);
  const updated = await AlbumCatalog.findOne({ albumId: album.albumId }); assert.equal(updated.catalogRevision, 2); assert.equal(updated.tracks.length, 1);
  assert.equal((await Listening.AlbumMapping.findOne({ albumId: album.albumId })).catalogRevision, 2);
  const active = await baselineForAlbum(updated); assert.equal(active.catalogRevision, 2); assert.equal(active.tracklistHash, candidate.tracklistHash); assert.equal(active.tracks.length, 1);
  assert.equal(await Listening.Job.countDocuments({ type: "reprocess" }), 1);
  const retry = await command("albums", album.albumId, "confirm", 0, 1, candidate, requestId);
  assert.equal(retry.revision, 1); assert.equal(await Models.Baseline.countDocuments({ albumId: album.albumId }), 1); assert.equal(await Models.Audit.countDocuments({ targetId: album.albumId }), 1);
});

test("replace preserves catalog tracks and revoke removes readiness while retaining versions", { skip: !enabled }, async () => {
  const group = mbid(); const trackId = crypto.randomUUID(); const album = await AlbumCatalog.create(albumInput({ releaseGroupMbid: group, tracks: [{ trackId, discNumber: 1, trackNumber: 1, title: "One", durationMs: 900, artistDisplayName: "Artist" }] }));
  const first = makeCandidate({ releaseGroupMbid: group }); await storeCandidate("albums", album, first); await command("albums", album.albumId, "confirm", 0, 1, first);
  const second = makeCandidate({ releaseGroupMbid: group }); await storeCandidate("albums", album, second); const replaced = await command("albums", album.albumId, "replace", 1, 1, second);
  assert.equal(replaced.revision, 2); assert.equal(replaced.activeBaseline.candidate.tracks[0].trackId, trackId);
  assert.equal((await AlbumCatalog.findOne({ albumId: album.albumId })).tracks[0].durationMs, 900);
  await command("albums", album.albumId, "revoke", 2, 1, null);
  assert.equal(await baselineForAlbum(await AlbumCatalog.findOne({ albumId: album.albumId })), null);
  assert.equal(await Models.Baseline.countDocuments({ albumId: album.albumId }), 2);
  assert.equal((await Models.Head.findOne({ targetId: album.albumId })).status, "revoked");
});

test("stale and concurrent commands do not partially publish", { skip: !enabled }, async () => {
  const group = mbid(); const album = await AlbumCatalog.create(albumInput({ releaseGroupMbid: group })); const candidate = makeCandidate({ releaseGroupMbid: group }); await storeCandidate("albums", album, candidate);
  await assert.rejects(command("albums", album.albumId, "confirm", 0, 2, candidate), (error) => error.code === "TARGET_REVISION_CONFLICT");
  assert.equal(await Models.Baseline.countDocuments({}), 0); assert.equal((await AlbumCatalog.findOne({ albumId: album.albumId })).tracks.length, 0);
  const attempts = await Promise.allSettled([command("albums", album.albumId, "confirm", 0, 1, candidate), command("albums", album.albumId, "confirm", 0, 1, candidate)]);
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1); assert.equal(await Models.Baseline.countDocuments({}), 1); assert.equal(await Models.Head.countDocuments({ targetId: album.albumId }), 1);
});

test("catalog revision changes invalidate readiness transactionally", { skip: !enabled }, async () => {
  const group = mbid(); const album = await AlbumCatalog.create(albumInput({ releaseGroupMbid: group, tracks: [{ trackId: crypto.randomUUID(), discNumber: 1, trackNumber: 1, title: "One", durationMs: 1, artistDisplayName: "Artist" }] })); const candidate = makeCandidate({ releaseGroupMbid: group });
  await storeCandidate("albums", album, candidate); await command("albums", album.albumId, "confirm", 0, 1, candidate);
  const changed = await AlbumCatalog.findOneAndUpdate({ albumId: album.albumId }, { $inc: { catalogRevision: 1 }, $set: { title: "Pilot corrected" } }, { returnDocument: "after" });
  assert.equal(await baselineForAlbum(changed), null);
  const session = await mongoose.startSession(); await session.withTransaction(() => invalidateAlbumBaseline(changed, { session, actorUserId: "integration-moderator", reason: "Correction changed identity" })); await session.endSession();
  assert.equal((await Models.Head.findOne({ targetId: album.albumId })).status, "stale"); assert.equal(await Models.Baseline.countDocuments({ albumId: album.albumId }), 1);
});

test("reviewed submission selection publishes atomically with approval and fills missing tracks", { skip: !enabled }, async () => {
  const group = mbid(); const submission = await createSubmission(group); const candidate = makeCandidate({ releaseGroupMbid: group, title: "Submitted Pilot" });
  await storeCandidate("submissions", submission, candidate); await command("submissions", submission.submissionId, "confirm", 0, 1, candidate);
  const approved = await approveAlbumSubmission({ submissionId: submission.submissionId, actorUserId: "integration-moderator", confirmPossibleDuplicate: true, reason: "Metadata and standard release reviewed", coverResolver: null });
  const album = await AlbumCatalog.findOne({ albumId: approved.album.albumId }); const active = await baselineForAlbum(album);
  assert.equal(album.tracks.length, 1); assert.equal(active.tracklistHash, candidate.tracklistHash);
  assert.equal((await Models.Head.findOne({ targetKind: "submissions", targetId: submission.submissionId })).status, "revoked");
  assert.equal((await Models.Head.findOne({ targetKind: "albums", targetId: album.albumId })).status, "reviewed");
});

test("reviewed backfill apply is exact, idempotent, and only queues", { skip: !enabled }, async () => {
  const group = mbid(); const album = await AlbumCatalog.create(albumInput({ releaseGroupMbid: group })); const candidate = makeCandidate({ releaseGroupMbid: group }); const planHash = "c".repeat(64);
  const session = await mongoose.startSession(); let first; await session.withTransaction(async () => { first = await queueEnrichmentCandidate({ albumId: album.albumId, expectedCatalogRevision: 1, candidate, reviewer: "integration-moderator", planHash, session }); }); await session.endSession();
  const secondSession = await mongoose.startSession(); let retry; await secondSession.withTransaction(async () => { retry = await queueEnrichmentCandidate({ albumId: album.albumId, expectedCatalogRevision: 1, candidate, reviewer: "integration-moderator", planHash, session: secondSession }); }); await secondSession.endSession();
  assert.equal(first.status, "pending"); assert.equal(retry.idempotent, true); assert.equal(await Models.Candidate.countDocuments({ targetId: album.albumId }), 1); assert.equal(await Models.Baseline.countDocuments({}), 0); assert.equal((await AlbumCatalog.findOne({ albumId: album.albumId })).tracks.length, 0);
});

test("pending queue readiness partitions candidate-backed work before pagination", { skip: !enabled }, async () => {
  const first = await AlbumCatalog.create(albumInput({ title: "Ready First" }));
  const second = await AlbumCatalog.create(albumInput({ title: "Ready Second" }));
  const unprepared = await AlbumCatalog.create(albumInput({ title: "Needs Discovery" }));
  await AlbumCatalog.collection.updateOne({ albumId: first.albumId }, { $set: { updatedAt: new Date("2026-01-01T00:00:00.000Z") } });
  await AlbumCatalog.collection.updateOne({ albumId: second.albumId }, { $set: { updatedAt: new Date("2026-01-02T00:00:00.000Z") } });
  await AlbumCatalog.collection.updateOne({ albumId: unprepared.albumId }, { $set: { updatedAt: new Date("2026-01-03T00:00:00.000Z") } });
  const queue = async (album, planHash) => {
    const session = await mongoose.startSession();
    const releaseGroupMbid = album.externalReferences[0].externalId;
    const candidate = makeCandidate({ releaseGroupMbid });
    await session.withTransaction(() => queueEnrichmentCandidate({ albumId: album.albumId, expectedCatalogRevision: 1, candidate, reviewer: "integration-moderator", planHash, session }));
    await session.endSession();
    return candidate;
  };
  const firstCandidate = await queue(first, "1".repeat(64));
  await queue(second, "2".repeat(64));

  const readyPage = await list({ status: "pending", readiness: "ready", limit: 1 });
  assert.equal(readyPage.items.length, 1);
  assert.equal(readyPage.items[0].id, first.albumId);
  assert.equal(readyPage.items[0].readyForReview, true);
  assert.ok(readyPage.nextCursor);
  const readyRemainder = await list({ status: "pending", readiness: "ready", cursor: readyPage.nextCursor, limit: 1 });
  assert.deepEqual(readyRemainder.items.map((item) => item.id), [second.albumId]);
  assert.equal(readyRemainder.items[0].readyForReview, true);

  const unpreparedRows = await list({ status: "pending", readiness: "unprepared", limit: 50 });
  assert.deepEqual(unpreparedRows.items.map((item) => item.id), [unprepared.albumId]);
  assert.equal(unpreparedRows.items[0].readyForReview, false);
  const allRows = await list({ status: "pending", readiness: "all", limit: 50 });
  assert.deepEqual(allRows.items.map((item) => item.id), [first.albumId, second.albumId, unprepared.albumId]);
  assert.deepEqual(allRows.items.map((item) => item.readyForReview), [true, true, false]);

  await command("albums", first.albumId, "confirm", 1, 1, firstCandidate);
  const reviewed = await list({ status: "reviewed", limit: 50 });
  assert.equal(reviewed.items.find((item) => item.id === first.albumId).readyForReview, false);
});

test("pending readiness rejects expired, dangling, and mismatched candidate snapshots", { skip: !enabled }, async () => {
  const makeQueued = async (album, planHash) => {
    const candidate = makeCandidate({ releaseGroupMbid: album.externalReferences[0].externalId });
    const session = await mongoose.startSession();
    await session.withTransaction(() => queueEnrichmentCandidate({ albumId: album.albumId, expectedCatalogRevision: 1, candidate, reviewer: "integration-moderator", planHash, session }));
    await session.endSession();
    return Models.Head.findOne({ targetKind: "albums", targetId: album.albumId });
  };
  const expired = await AlbumCatalog.create(albumInput({ releaseGroupMbid: mbid() }));
  const dangling = await AlbumCatalog.create(albumInput({ releaseGroupMbid: mbid() }));
  const mismatched = await AlbumCatalog.create(albumInput({ releaseGroupMbid: mbid() }));
  const expiredHead = await makeQueued(expired, "3".repeat(64));
  const danglingHead = await makeQueued(dangling, "4".repeat(64));
  const mismatchedHead = await makeQueued(mismatched, "5".repeat(64));
  await Models.Candidate.updateOne({ _id: expiredHead.selectedSnapshotId }, { $set: { expiresAt: new Date("2020-01-01T00:00:00.000Z") } });
  await Models.Head.updateOne({ _id: danglingHead._id }, { $set: { selectedSnapshotId: new mongoose.Types.ObjectId() } });
  await Models.Candidate.updateOne({ _id: mismatchedHead.selectedSnapshotId }, { $set: { targetRevision: 2 } });

  const ready = await list({ status: "pending", readiness: "ready", limit: 50 });
  assert.equal(ready.items.some((item) => [expired.albumId, dangling.albumId, mismatched.albumId].includes(item.id)), false);
  const unprepared = await list({ status: "pending", readiness: "unprepared", limit: 50 });
  assert.deepEqual(new Set(unprepared.items.map((item) => item.id)), new Set([expired.albumId, dangling.albumId, mismatched.albumId]));
  assert.equal(unprepared.items.every((item) => item.readyForReview === false), true);
  assert.equal((await reviewStatusCounts()).albums.pendingWithCandidate, 0);
});

test("pending queue searches unheaded albums beyond the former 250-row boundary", { skip: !enabled }, async () => {
  const rows = Array.from({ length: 260 }, (_, index) => ({ albumId: crypto.randomUUID(), title: index === 259 ? "Needle Album" : `Queue Album ${String(index).padStart(3, "0")}`, artistDisplayName: "Queue Artist", releaseType: "album", catalogRevision: 1 }));
  rows.push({ albumId: crypto.randomUUID(), title: "Needle Single", artistDisplayName: "Queue Artist", releaseType: "single", catalogRevision: 1 });
  await AlbumCatalog.insertMany(rows);
  const result = await list({ status: "pending", q: "Needle", limit: 10 });
  assert.equal(result.items.length, 1); assert.equal(result.items[0].title, "Needle Album"); assert.equal(result.items[0].revision, 0); assert.equal(result.nextCursor, null);
});

test("queued, invalidated-stale, and revision-stale reviews can be confirmed again", { skip: !enabled }, async () => {
  const group = mbid(); const trackId = crypto.randomUUID();
  const album = await AlbumCatalog.create(albumInput({ releaseGroupMbid: group, tracks: [{ trackId, discNumber: 1, trackNumber: 1, title: "One", durationMs: 1, artistDisplayName: "Artist" }] }));
  const queued = makeCandidate({ releaseGroupMbid: group });
  const session = await mongoose.startSession();
  await session.withTransaction(() => queueEnrichmentCandidate({ albumId: album.albumId, expectedCatalogRevision: 1, candidate: queued, reviewer: "integration-moderator", planHash: "d".repeat(64), session }));
  await session.endSession();
  let result = await command("albums", album.albumId, "confirm", 1, 1, queued);
  assert.equal(result.status, "reviewed"); assert.equal(result.activeBaseline.candidate.tracklistHash, queued.tracklistHash);

  let changed = await AlbumCatalog.findOneAndUpdate({ albumId: album.albumId }, { $inc: { catalogRevision: 1 } }, { returnDocument: "after" });
  assert.equal((await command("albums", album.albumId, "defer", 2, 2, null)).status, "deferred");
  const revisionStale = makeCandidate({ releaseGroupMbid: group }); await storeCandidate("albums", changed, revisionStale);
  result = await command("albums", album.albumId, "confirm", 3, 2, revisionStale);
  assert.equal(result.status, "reviewed"); assert.equal(result.activeBaseline.catalogRevision, 2);

  changed = await AlbumCatalog.findOneAndUpdate({ albumId: album.albumId }, { $inc: { catalogRevision: 1 } }, { returnDocument: "after" });
  assert.equal((await list({ status: "stale" })).items.some((item) => item.id === album.albumId), true);
  const derived = makeCandidate({ releaseGroupMbid: group }); await storeCandidate("albums", changed, derived);
  result = await command("albums", album.albumId, "confirm", 4, 3, derived);
  assert.equal(result.status, "reviewed"); assert.equal(result.activeBaseline.catalogRevision, 3);

  changed = await AlbumCatalog.findOneAndUpdate({ albumId: album.albumId }, { $inc: { catalogRevision: 1 } }, { returnDocument: "after" });
  const invalidation = await mongoose.startSession();
  await invalidation.withTransaction(() => invalidateAlbumBaseline(changed, { session: invalidation, actorUserId: "integration-moderator", reason: "Correction changed identity" }));
  await invalidation.endSession();
  const invalidated = makeCandidate({ releaseGroupMbid: group }); await storeCandidate("albums", changed, invalidated);
  result = await command("albums", album.albumId, "confirm", 6, 4, invalidated);
  assert.equal(result.status, "reviewed"); assert.equal(result.activeBaseline.version, 4);
  assert.equal((await AlbumCatalog.findOne({ albumId: album.albumId })).tracks[0].trackId, trackId);
  await assert.rejects(command("albums", album.albumId, "confirm", 7, 4, invalidated), (error) => error.code === "INVALID_BASELINE_STATE");
});

test("defer is limited to albums without a current reviewed baseline", { skip: !enabled }, async () => {
  const group = mbid(); const album = await AlbumCatalog.create(albumInput({ releaseGroupMbid: group })); const candidate = makeCandidate({ releaseGroupMbid: group });
  await storeCandidate("albums", album, candidate); await command("albums", album.albumId, "confirm", 0, 1, candidate);
  await assert.rejects(command("albums", album.albumId, "defer", 1, 2, null), (error) => error.code === "INVALID_BASELINE_STATE");
  const current = await baselineForAlbum(await AlbumCatalog.findOne({ albumId: album.albumId }));
  assert.equal(current.tracklistHash, candidate.tracklistHash, "a rejected defer leaves readiness intact");
  await AlbumCatalog.updateOne({ albumId: album.albumId }, { $inc: { catalogRevision: 1 } });
  assert.equal((await command("albums", album.albumId, "defer", 1, 3, null)).status, "deferred");
});

test("pilot review counts match queue statuses, including derived staleness and queued work", { skip: !enabled }, async () => {
  const make = async () => { const group = mbid(); const album = await AlbumCatalog.create(albumInput({ releaseGroupMbid: group })); return { album, group }; };
  const reviewed = await make(); const stale = await make(); const deferred = await make(); const revoked = await make(); const queued = await make(); await make();
  await AlbumCatalog.create({ ...albumInput(), releaseType: "single" });
  for (const target of [reviewed, stale, revoked]) { const candidate = makeCandidate({ releaseGroupMbid: target.group }); await storeCandidate("albums", target.album, candidate); await command("albums", target.album.albumId, "confirm", 0, 1, candidate); }
  await AlbumCatalog.updateOne({ albumId: stale.album.albumId }, { $inc: { catalogRevision: 1 } });
  await command("albums", revoked.album.albumId, "revoke", 1, 2, null);
  await command("albums", deferred.album.albumId, "defer", 0, 1, null);
  const session = await mongoose.startSession();
  await session.withTransaction(() => queueEnrichmentCandidate({ albumId: queued.album.albumId, expectedCatalogRevision: 1, candidate: makeCandidate({ releaseGroupMbid: queued.group }), reviewer: "integration-moderator", planHash: "f".repeat(64), session }));
  await session.endSession();
  const submission = await createSubmission(mbid());
  const candidate = makeCandidate({ releaseGroupMbid: submission.externalReferences[0].externalId }); await storeCandidate("submissions", submission, candidate);
  await command("submissions", submission.submissionId, "confirm", 0, 1, candidate);
  await createSubmission(mbid());
  const counts = await reviewStatusCounts();
  assert.deepEqual(counts.albums, { pending: 2, reviewed: 1, stale: 1, deferred: 1, revoked: 1, pendingWithCandidate: 1 });
  assert.deepEqual(counts.submissions, { pending: 1, reviewed: 1, stale: 0, deferred: 0, revoked: 0, pendingWithCandidate: 0 });
  for (const status of ["pending", "reviewed", "stale", "deferred", "revoked"]) {
    const rows = (await list({ status, limit: 50 })).items;
    assert.equal(rows.filter((row) => row.kind === "albums").length, counts.albums[status], `albums ${status}`);
  }
});

test("a suggestion revised after its baseline selection is approved without that baseline", { skip: !enabled }, async () => {
  const group = mbid(); const submission = await createSubmission(group); const candidate = makeCandidate({ releaseGroupMbid: group, title: "Submitted Pilot" });
  await storeCandidate("submissions", submission, candidate); await command("submissions", submission.submissionId, "confirm", 0, 1, candidate);
  // Mirror the contributor revise route: new revision snapshot, currentRevision advanced, back to pending.
  const payload = normalizeSubmissionPayload({ proposedMetadata: { title: "Submitted Pilot (Revised)", artistCredits: [{ name: "Artist" }], releaseType: "album", releaseDate: "2026" }, supportingSources: [{ type: "musicbrainz", url: `https://musicbrainz.org/release-group/${group}` }], externalReferences: [{ provider: "musicbrainz", entityType: "release-group", externalId: group, url: `https://musicbrainz.org/release-group/${group}` }] });
  const duplicate = await findDuplicateSignals(payload); const revisedAt = new Date();
  await AlbumSubmission.updateOne({ submissionId: submission.submissionId, currentRevision: 1 }, { $set: { proposedMetadata: payload.proposedMetadata, normalizedFingerprint: duplicate.fingerprint, currentRevision: 2, status: "pending" }, $push: { revisions: snapshotForSubmission(payload, duplicate, revisedAt, 2), moderationHistory: { actorUserId: "integration-user", action: "revised", reason: "", createdAt: revisedAt } } });
  assert.equal((await list({ status: "stale" })).items.some((item) => item.kind === "submissions" && item.id === submission.submissionId), true);
  const approved = await approveAlbumSubmission({ submissionId: submission.submissionId, actorUserId: "integration-moderator", confirmPossibleDuplicate: true, reason: "Revised metadata reviewed", coverResolver: null });
  const album = await AlbumCatalog.findOne({ albumId: approved.album.albumId });
  assert.equal(album.tracks.length, 0, "the stale selection's tracks are not published");
  assert.equal(await baselineForAlbum(album), null);
  assert.equal(await Models.Baseline.countDocuments({}), 0);
  assert.equal(await Models.Head.countDocuments({ targetKind: "albums", targetId: album.albumId }), 0, "enrichment stays pending");
  assert.equal((await Models.Head.findOne({ targetKind: "submissions", targetId: submission.submissionId })).status, "reviewed", "the unused selection is left as history, not consumed");
});

test("linking a suggestion to an existing album never applies its baseline or tracks", { skip: !enabled }, async () => {
  const group = mbid();
  const emptyAlbum = await AlbumCatalog.create(albumInput({ releaseGroupMbid: group }));
  const submission = await createSubmission(group); const candidate = makeCandidate({ releaseGroupMbid: group, title: "Submitted Pilot" });
  await storeCandidate("submissions", submission, candidate); await command("submissions", submission.submissionId, "confirm", 0, 1, candidate);
  const approved = await approveAlbumSubmission({ submissionId: submission.submissionId, actorUserId: "integration-moderator", albumId: emptyAlbum.albumId, reason: "Existing catalog match", coverResolver: null });
  assert.equal(approved.album.albumId, emptyAlbum.albumId);
  const album = await AlbumCatalog.findOne({ albumId: emptyAlbum.albumId });
  assert.equal(album.tracks.length, 0, "empty tracks stay empty on a linked album");
  assert.equal(album.catalogRevision, 1);
  assert.equal(await Models.Baseline.countDocuments({}), 0);
  assert.equal(await Models.Head.countDocuments({ targetKind: "albums" }), 0, "the linked album needs its own baseline review");
  assert.equal((await list({ status: "pending", q: "Pilot" })).items.some((item) => item.id === emptyAlbum.albumId), true);
});

test("legacy albums without a stored catalog revision are reviewable from the detail revision", { skip: !enabled }, async () => {
  const group = mbid(); const album = await AlbumCatalog.create(albumInput({ releaseGroupMbid: group }));
  await AlbumCatalog.collection.updateOne({ albumId: album.albumId }, { $unset: { catalogRevision: "" } });
  const legacy = await AlbumCatalog.findOne({ albumId: album.albumId }).lean();
  assert.equal(legacy.catalogRevision, undefined);
  const view = await detail("albums", album.albumId);
  assert.equal(view.target.catalogRevision, 1);
  const candidate = makeCandidate({ releaseGroupMbid: group }); await storeCandidate("albums", legacy, candidate);
  const result = await command("albums", album.albumId, "confirm", view.revision, view.target.catalogRevision, candidate);
  assert.equal(result.status, "reviewed"); assert.equal(result.target.catalogRevision, 2);
});
