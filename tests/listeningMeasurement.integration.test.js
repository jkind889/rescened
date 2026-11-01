const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const AlbumCatalog = require("../models/AlbumCatalog");
const Baselines = require("../models/AlbumBaseline");
const Listening = require("../models/Listening");
const { mappingKey } = require("../lib/listening/common");
const { manifestTemplate } = require("../lib/listening/measurement");
const { collectMeasurement } = require("../scripts/listeningMeasurement");

const enabled = String(process.env.RUN_MONGO_INTEGRATION || "").toLowerCase() === "true";
const NOW = new Date("2026-11-10T06:00:00Z");
let replSet;

test("measurement collector reads real collections without writing", { skip: !enabled }, async (t) => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: "rescened_listening_measurement" });
  t.after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); await replSet.stop(); });
  await Promise.all([AlbumCatalog.syncIndexes(), ...Object.values(Listening).map((model) => model.syncIndexes()), ...Object.values(Baselines).map((model) => model.syncIndexes())]);

  const standard = await AlbumCatalog.create({ albumId: crypto.randomUUID(), title: "Standard", artistDisplayName: "Album Artist", releaseType: "album", catalogRevision: 1 });
  const credited = await AlbumCatalog.create({ albumId: crypto.randomUUID(), title: "Duet", artistDisplayName: "Lead", artistCredits: [{ name: "Lead", role: "main" }, { name: "Album Artist", role: "featured" }], releaseType: "single", catalogRevision: 1 });
  const caseFor = (album, fields = {}) => Listening.MappingCase.create({ key: mappingKey("Album Artist", album), artist: "Album Artist", album, artistKey: "album artist", albumKey: album.toLowerCase(), status: "pending", ...fields });
  const edition = await caseFor("Standard (Deluxe Edition)", { evidence: [{ source: "candidate_discovery", candidateQueryLimitReached: false, candidatesFound: 0, candidatesShown: 0 }] });
  const duet = await caseFor("Duet", { status: "no_catalog_match" });
  await caseFor("Standard", { status: "rejected" });
  await Listening.Job.create({ key: `discovery:catalog:${edition.caseId}:${standard._id}`, type: "discovery", payload: { caseId: edition.caseId, key: edition.key, catalogAlbumId: String(standard._id) }, status: "pending", attempts: 0 });

  const connection = await Listening.Connection.create({ userId: "user-1", username: "listener", usernameKey: "listener", state: "active", connectedAt: NOW, windows: [{ start: NOW }] });
  const scrobble = (album, track) => ({ connectionId: connection._id, connectionRevision: 1, identityKey: crypto.randomUUID(), artist: "Album Artist", album, track, artistKey: "album artist", albumKey: album.toLowerCase(), trackKey: track, playedAt: NOW, expiresAt: new Date(NOW.getTime() + 86_400_000), resolution: "matched" });
  await Listening.Scrobble.create([scrobble("Standard", "one"), scrobble("Standard", "two"), scrobble("Unmapped", "three")]);
  await Listening.AlbumMapping.create({ key: mappingKey("Album Artist", "Standard"), artist: "Album Artist", album: "Standard", artistKey: "album artist", albumKey: "standard", albumId: standard.albumId, catalogRevision: 1, reviewer: "moderator", reason: "fixture" });
  // Raw inserts keep the fixture small; the collector only reads the baseline's album and revision.
  const baseline = await Baselines.Baseline.collection.insertOne({ baselineId: crypto.randomUUID(), albumId: standard.albumId, version: 1, catalogRevision: 1 });
  await Baselines.Head.create({ targetKind: "albums", targetId: standard.albumId, status: "reviewed", targetRevision: 1, activeBaselineId: baseline.insertedId });
  // A reviewed head whose active baseline is missing is not usable, matching baselineForAlbum.
  const orphan = await AlbumCatalog.create({ albumId: crypto.randomUUID(), title: "Orphan", artistDisplayName: "Other Artist", releaseType: "album", catalogRevision: 1 });
  await Listening.AlbumMapping.create({ key: mappingKey("Other Artist", "Orphan"), artist: "Other Artist", album: "Orphan", artistKey: "other artist", albumKey: "orphan", albumId: orphan.albumId, catalogRevision: 1, reviewer: "moderator", reason: "fixture" });
  await Listening.Scrobble.create({ ...scrobble("Orphan", "four"), artist: "Other Artist", artistKey: "other artist" });
  await Baselines.Head.create({ targetKind: "albums", targetId: orphan.albumId, status: "reviewed", targetRevision: 1, activeBaselineId: new mongoose.Types.ObjectId() });

  const counts = async () => Promise.all([AlbumCatalog, ...Object.values(Listening), ...Object.values(Baselines)].map((model) => model.countDocuments()));
  const before = await counts();
  const manifest = { ...manifestTemplate(), environment: "integration", windows: { intakeDays: 14, followUpDays: 7, snapshotTimeUtc: "06:00" } };
  const report = await collectMeasurement({ manifest, now: NOW });

  assert.equal(report.collection.complete, true);
  assert.equal(report.rediscoveryCensus.albumsScanned, 3);
  assert.equal(report.rediscoveryCensus.pairs, 2, "edition-label and credited-artist pairs are eligible; the rejected case is not");
  assert.equal(report.rediscoveryCensus.jobState.queued, 1);
  assert.equal(report.rediscoveryCensus.jobState.notEnqueued, 1);
  assert.equal(report.rediscoveryCensus.matchingCandidate.absent, 2);
  assert.equal(report.mappingEvidence.cases, 1);
  assert.equal(report.mappingEvidence.coverageFieldsKnown.numerator, 1);
  assert.equal(report.demandReadiness.names.observed, 3);
  assert.equal(report.demandReadiness.names.mapped, 2);
  assert.equal(report.demandReadiness.names.withUsableBaseline, 1);
  assert.deepEqual(report.demandReadiness.albums.status, { readyPending: 0, unpreparedPending: 0, reviewed: 1, stale: 0, deferred: 0, revoked: 0, unknown: 1, total: 2, reconciles: true });
  assert.deepEqual(await counts(), before, "collection is read-only");
  assert.equal(JSON.stringify(report).includes(duet.caseId), false);
});
