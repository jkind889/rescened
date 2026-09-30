const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const AlbumCatalog = require("../models/AlbumCatalog");
const Listening = require("../models/Listening");
const Baselines = require("../models/AlbumBaseline");
const { baselineForAlbum } = require("../lib/baselines/service");
const { hashCandidateTracklist } = require("../lib/baselines/musicBrainz");
const { carryCoverRevision } = require("../lib/listening/mappingRevisions");
const { mappingKey, normalize } = require("../lib/listening/common");
const { runBackfill } = require("../scripts/backfillMissingAlbumCovers");

const BARCODE = "012345678905";
const GROUP_MBID = "11111111-1111-4111-8111-111111111111";
const RELEASE_MBID = "22222222-2222-4222-8222-222222222222";
const enabled = String(process.env.RUN_MONGO_INTEGRATION || "").toLowerCase() === "true";

let replSet;

function response(data, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] || null },
    async json() { return data; },
  };
}

async function setup() {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: "rescened_cover_backfill" });
  await AlbumCatalog.syncIndexes();
  await Promise.all([...Object.values(Listening), ...Object.values(Baselines)].map((model) => model.init()));
}

function mapping(album, artist, title, catalogRevision) {
  return { mappingId: crypto.randomUUID(), key: mappingKey(artist, title), provider: "lastfm", artist, album: title, artistKey: normalize(artist), albumKey: normalize(title), albumId: album.albumId, catalogRevision, revision: 1, status: "active", reviewer: "moderator", reason: "fixture" };
}

async function teardown() {
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
  if (replSet) await replSet.stop();
}

async function mockedProviderBackfillTest() {
  const target = await AlbumCatalog.create({
    albumId: crypto.randomUUID(),
    title: "Exact Barcode Album",
    artistDisplayName: "Exact Artist",
    artistCredits: [{ name: "Exact Artist", role: "main" }],
    releaseType: "album",
    releaseDate: "2026",
    cover: "",
    externalReferences: [{ provider: "barcode", entityType: "release", externalId: BARCODE }],
    catalogSource: "import",
  });
  const manual = await AlbumCatalog.create({
    albumId: crypto.randomUUID(),
    title: "Manual Cover Album",
    artistDisplayName: "Manual Artist",
    artistCredits: [{ name: "Manual Artist", role: "main" }],
    cover: "https://images.example.test/manual.jpg",
    catalogSource: "manual",
  });
  // One mapping was reviewed at the album's current revision; the other was
  // already stranded by an earlier change and must stay stale.
  const [current, stranded] = await Listening.AlbumMapping.create([
    mapping(target, "Exact Artist", "Exact Barcode Album", 1),
    mapping(target, "Exact Artist", "Exact Barcode Album (Deluxe)", 3),
  ]);
  // A tracklist baseline reviewed at the same revision.
  const candidate = { releaseMbid: RELEASE_MBID, releaseGroupMbid: GROUP_MBID, title: "Exact Barcode Album", artistDisplayName: "Exact Artist", date: "2026", country: "US", formats: ["CD"], disambiguation: "", status: "Official", tracks: [{ discNumber: 1, trackNumber: 1, title: "One", durationMs: 180000, artistDisplayName: "Exact Artist", releaseTrackMbid: crypto.randomUUID(), recordingMbid: crypto.randomUUID() }], retrievedAt: new Date("2026-08-01T00:00:00Z"), sourceUrl: `https://musicbrainz.org/release/${RELEASE_MBID}`, license: "CC0" };
  candidate.tracklistHash = hashCandidateTracklist(candidate);
  const [baseline] = await Baselines.Baseline.create([{ baselineId: crypto.randomUUID(), albumId: target.albumId, version: 1, catalogRevision: 1, candidate, reviewedByUserId: "moderator", reviewedAt: new Date(), reason: "Reviewed standard" }]);
  const [head] = await Baselines.Head.create([{ targetKind: "albums", targetId: target.albumId, revision: 1, status: "reviewed", targetRevision: 1, activeBaselineId: baseline._id, reason: "Reviewed standard" }]);
  assert.equal((await baselineForAlbum(target.toObject())).baselineId, baseline.baselineId);
  const calls = [];
  const dependencies = {
    AlbumCatalog,
    clock: () => new Date("2026-08-26T12:00:00.000Z"),
    sleepFn: async () => {},
    userAgent: "RescenedCoverBackfillIntegration/1.0 (integration@example.invalid)",
    fetchFn: async (url, options) => {
      calls.push({ url, method: options.method, headers: options.headers });
      if (options.method === "GET" && url.startsWith("https://musicbrainz.org/ws/2/release?")) {
        return response({
          count: 1,
          releases: [{
            id: RELEASE_MBID,
            barcode: BARCODE,
            title: "Exact Barcode Album",
            "release-group": { id: GROUP_MBID },
            "artist-credit": [{ name: "Exact Artist" }],
          }],
        });
      }
      if (options.method === "GET" && url === `https://coverartarchive.org/release-group/${GROUP_MBID}`) {
        return response({
          release: `https://musicbrainz.org/release/${RELEASE_MBID}`,
          images: [{
            approved: true,
            front: true,
            id: "98765",
            thumbnails: { "500": `https://coverartarchive.org/release/${RELEASE_MBID}/98765-500.jpg` },
          }],
        });
      }
      if (options.method === "HEAD" && url === `https://coverartarchive.org/release/${RELEASE_MBID}/front-500`) {
        return response(null, 200, { "content-type": "image/jpeg" });
      }
      throw new Error(`Unexpected provider request: ${options.method} ${url}`);
    },
  };

  const first = await runBackfill({ apply: true }, dependencies);
  assert.equal(first.counts.scanned, 1);
  assert.equal(first.counts.updated, 1);
  assert.equal(first.counts.unresolved, 0);
  const persisted = await AlbumCatalog.findById(target._id).lean();
  assert.equal(persisted.cover, `https://coverartarchive.org/release/${RELEASE_MBID}/front-500`);
  assert.equal(persisted.fieldProvenance.cover.source, "cover-art-archive");
  assert.equal(persisted.fieldProvenance.cover.releaseMbid, RELEASE_MBID);
  assert.equal(persisted.externalReferences.some((reference) => reference.externalId === RELEASE_MBID), true);
  assert.equal((await AlbumCatalog.findById(manual._id).lean()).cover, "https://images.example.test/manual.jpg");
  assert.equal(persisted.catalogRevision, 2);
  assert.equal(first.entries[0].mappingsCarried, 1);
  assert.equal(first.entries[0].baselineCarried, true);
  assert.equal(first.counts.revisionCarryFailures, 0);
  const carriedBaseline = await baselineForAlbum(persisted);
  assert.equal(carriedBaseline.baselineId, baseline.baselineId, "the same reviewed baseline stays active");
  assert.equal(carriedBaseline.version, 1);
  assert.equal(carriedBaseline.catalogRevision, 2);
  const carriedHead = await Baselines.Head.findById(head._id).lean();
  assert.equal(carriedHead.status, "reviewed");
  assert.equal(carriedHead.targetRevision, 2);
  assert.equal(carriedHead.revision, 2);
  const audit = await Baselines.Audit.findOne({ targetId: target.albumId, action: "carry_forward" }).lean();
  assert.deepEqual(audit.details, { fromCatalogRevision: 1, toCatalogRevision: 2 });
  assert.equal(audit.baselineId, baseline.baselineId);
  // A carry toward a revision the album has already moved past changes nothing.
  assert.deepEqual(await carryCoverRevision({ albumId: target.albumId, fromRevision: 2, toRevision: 3 }), { baselineCarried: false, mappingsCarried: 0 });
  assert.equal((await Baselines.Head.findById(head._id).lean()).targetRevision, 2);
  const carried = await Listening.AlbumMapping.findById(current._id).lean();
  assert.equal(carried.catalogRevision, 2, "a cover fill does not strand a reviewed mapping");
  assert.equal(carried.revision, 1, "carrying forward is not a new moderator decision");
  assert.equal((await Listening.AlbumMapping.findById(stranded._id).lean()).catalogRevision, 3);
  const jobs = await Listening.Job.find({ type: "reprocess" }).lean();
  assert.deepEqual(jobs.map((job) => job.payload.mappingId), [current.mappingId]);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].headers["User-Agent"], dependencies.userAgent);

  const second = await runBackfill({ apply: true }, dependencies);
  assert.equal(second.counts.scanned, 0);
  assert.equal(second.counts.updated, 0);
  assert.equal(calls.length, 3);
}

if (enabled) {
  test.before(setup);
  test.after(teardown);
  test("backfill resolves a stored barcode, preserves manual covers, and reruns as a no-op", mockedProviderBackfillTest);
} else {
  test("backfill resolves a stored barcode, preserves manual covers, and reruns as a no-op", {
    skip: "Set RUN_MONGO_INTEGRATION=true in an environment that permits local Mongo processes",
  }, () => {});
}
