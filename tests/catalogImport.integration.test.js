const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const AlbumCatalog = require("../models/AlbumCatalog");
const Artist = require("../models/Artist");
const persistence = require("../lib/catalogImport/persistence");

// Imports resolve credit MBIDs through the real Artist registry here.
const preflightImport = (options) => persistence.preflightImport({ Artist, ...options });
const applyImport = (options) => persistence.applyImport({ Artist, ...options });

const integrationEnabled = String(process.env.RUN_MONGO_INTEGRATION || "").toLowerCase() === "true";
let replSet;

function row(releaseGroupMbid, title, overrides = {}) {
  return {
    releaseGroupMbid,
    representativeReleaseMbid: null,
    selectedRange: "all_time",
    selectionSignals: [{ range: "all_time", rank: 1, listenCount: 100 }],
    title,
    artistDisplayName: "Integration Artist",
    artistCredits: [{
      artistMbid: "197450cd-0124-4164-b723-3c22dd16494d",
      name: "Integration Artist",
      joinPhrase: "",
    }],
    releaseType: "album",
    releaseDate: "2026",
    releaseDatePrecision: "year",
    releaseYear: 2026,
    cover: null,
    sourceFetchedAt: {
      listenbrainz: "2026-08-14T12:00:00.000Z",
      musicbrainz: "2026-08-14T12:00:01.000Z",
    },
    ...overrides,
  };
}

function validation(rows) {
  return {
    dataset: {
      schemaVersion: "1.0.0",
      datasetId: "catalog-import-integration",
      generatedAt: "2026-08-14T12:01:00.000Z",
      sourceLicenses: {},
      albums: rows,
    },
    validAlbums: rows.map((album, index) => ({ row: album, index })),
    quarantined: [],
    errors: [],
  };
}

async function setup() {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: "rescened_catalog_import" });
  await Promise.all([AlbumCatalog.syncIndexes(), Artist.syncIndexes()]);
}

async function teardown() {
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
  if (replSet) await replSet.stop();
}

async function insertAndIdempotencyTest() {
  const source = validation([row("52caa37a-fa51-4e57-88cf-8d1108bbaa65", "Transaction Seed")]);
  const first = await preflightImport({ validation: source, AlbumCatalog });
  assert.equal(first.counts.inserted, 1);
  await applyImport({ plan: first, AlbumCatalog, mongoose });
  const inserted = await AlbumCatalog.findOne({ title: "Transaction Seed" }).lean();
  assert.ok(inserted);
  assert.equal(inserted.catalogSource, "import");
  assert.match(inserted.albumId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  const second = await preflightImport({ validation: source, AlbumCatalog });
  assert.equal(second.counts.unchanged, 1);
  assert.equal(second.operations.length, 0);
  assert.equal(second.accepted[0].document.albumId, inserted.albumId);
  await applyImport({ plan: second, AlbumCatalog, mongoose });
  assert.equal(await AlbumCatalog.countDocuments({ title: "Transaction Seed" }), 1);
}

async function refreshPreservationTest() {
  const releaseGroupMbid = "51f6e6b4-aadc-4509-b5a9-e1c32f977f37";
  const initial = validation([row(releaseGroupMbid, "Refresh Seed")]);
  const insertPlan = await preflightImport({ validation: initial, AlbumCatalog });
  await applyImport({ plan: insertPlan, AlbumCatalog, mongoose });
  const inserted = await AlbumCatalog.findOne({ title: "Refresh Seed" });
  const originalAlbumId = inserted.albumId;
  inserted.title = "Manual Refresh Title";
  inserted.tracks = [{
    trackId: "manual-track",
    discNumber: 1,
    trackNumber: 1,
    title: "Manual Track",
    durationMs: 0,
    artistDisplayName: "Integration Artist",
  }];
  inserted.label = "Manual Label";
  inserted.fieldProvenance = {
    ...inserted.fieldProvenance,
    title: { source: "manual" },
    tracks: { source: "manual" },
    label: { source: "manual" },
  };
  await inserted.save();

  const refreshedSource = validation([row(releaseGroupMbid, "New Imported Title", {
    releaseDate: "2025",
    releaseDatePrecision: "year",
    releaseYear: 2025,
  })]);
  const refreshPlan = await preflightImport({ validation: refreshedSource, AlbumCatalog });
  assert.equal(refreshPlan.counts.refreshed, 1);
  assert.ok(refreshPlan.operations[0].updateOne.filter.updatedAt);
  await applyImport({ plan: refreshPlan, AlbumCatalog, mongoose });

  const refreshed = await AlbumCatalog.findOne({ albumId: originalAlbumId }).lean();
  assert.equal(refreshed.albumId, originalAlbumId);
  assert.equal(refreshed.title, "Manual Refresh Title");
  assert.equal(refreshed.tracks[0].title, "Manual Track");
  assert.equal(refreshed.label, "Manual Label");
  assert.equal(refreshed.releaseDate, "2025");
}

async function caseInsensitiveAndReferenceConflictTest() {
  const uppercaseReleaseGroup = "90B2D9D5-3B1C-4D26-8300-15F53C166DB8";
  await AlbumCatalog.create({
    albumId: crypto.randomUUID(),
    title: "Uppercase Community Owner",
    artistDisplayName: "Community Artist",
    externalReferences: [{
      provider: "musicbrainz",
      entityType: "release-group",
      externalId: uppercaseReleaseGroup,
      url: "",
    }],
    catalogSource: "community",
  });
  const casePlan = await preflightImport({
    validation: validation([row(uppercaseReleaseGroup.toLowerCase(), "Should Conflict")]),
    AlbumCatalog,
  });
  assert.equal(casePlan.operations.length, 0);
  assert.equal(casePlan.quarantined[0].code, "EXISTING_CATALOG_CONFLICT");

  const representativeReleaseMbid = "3da56899-5c99-4e4c-8050-c5f5210f12c6";
  await AlbumCatalog.create({
    albumId: crypto.randomUUID(),
    title: "Representative Release Owner",
    artistDisplayName: "Manual Artist",
    externalReferences: [
      {
        provider: "musicbrainz",
        entityType: "release-group",
        externalId: "40c0e10b-17e3-4d83-814f-c978d363168a",
        url: "",
      },
      {
        provider: "musicbrainz",
        entityType: "release",
        externalId: representativeReleaseMbid,
        url: "",
      },
    ],
    catalogSource: "manual",
  });
  const referencePlan = await preflightImport({
    validation: validation([row("5d32d12f-daa2-40a7-8596-e9a746d4c058", "Release Collision", {
      representativeReleaseMbid,
      cover: null,
    })]),
    AlbumCatalog,
  });
  assert.equal(referencePlan.operations.length, 0);
  assert.equal(referencePlan.quarantined[0].code, "EXISTING_REFERENCE_CONFLICT");
}

async function optimisticConcurrencyTest() {
  const releaseGroupMbid = "70594b22-a3aa-4e21-b8d5-07bd604e2d25";
  const first = await preflightImport({
    validation: validation([row(releaseGroupMbid, "Concurrency Seed")]),
    AlbumCatalog,
  });
  await applyImport({ plan: first, AlbumCatalog, mongoose });
  const refresh = await preflightImport({
    validation: validation([row(releaseGroupMbid, "Importer Refresh", {
      releaseDate: "2024",
      releaseDatePrecision: "year",
      releaseYear: 2024,
    })]),
    AlbumCatalog,
  });
  assert.equal(refresh.counts.refreshed, 1);

  const concurrent = await AlbumCatalog.findOne({ title: "Concurrency Seed" });
  const originalAlbumId = concurrent.albumId;
  concurrent.title = "Concurrent Manual Edit";
  concurrent.fieldProvenance = {
    ...concurrent.fieldProvenance,
    title: { source: "manual" },
  };
  await new Promise((resolve) => setTimeout(resolve, 10));
  await concurrent.save();

  await assert.rejects(
    applyImport({ plan: refresh, AlbumCatalog, mongoose }),
    (error) => error.code === "CONCURRENT_CATALOG_CHANGE" && error.transactionState === "rolled-back",
  );
  const preserved = await AlbumCatalog.findOne({ albumId: originalAlbumId }).lean();
  assert.equal(preserved.title, "Concurrent Manual Edit");
  assert.equal(preserved.releaseDate, "2026");
}

async function rollbackTest() {
  const rows = [
    row("308edab7-7257-4905-a441-8ab55e243360", "Rollback Seed One"),
    row("a6e40322-15d8-469a-8c0e-8b383210b38d", "Rollback Seed Two"),
  ];
  const plan = await preflightImport({ validation: validation(rows), AlbumCatalog });
  assert.equal(plan.operations.length, 2);

  const originalBulkWrite = AlbumCatalog.bulkWrite;
  AlbumCatalog.bulkWrite = async function forcedFailure(operations, options) {
    await originalBulkWrite.call(this, operations, options);
    throw new Error("forced post-write transaction failure");
  };
  try {
    await assert.rejects(
      applyImport({ plan, AlbumCatalog, mongoose }),
      /forced post-write transaction failure/,
    );
  } finally {
    AlbumCatalog.bulkWrite = originalBulkWrite;
  }
  assert.equal(await AlbumCatalog.countDocuments({ title: /^Rollback Seed/ }), 0);
}

if (integrationEnabled) {
  test.before(setup);
  test.after(teardown);
  test("catalog import is transactional and reruns are idempotent", insertAndIdempotencyTest);
  test("catalog import rolls back the accepted batch after a write failure", rollbackTest);
  test("catalog refresh preserves UUID and manual catalog enrichments", refreshPreservationTest);
  test("catalog preflight detects case-insensitive and representative-release conflicts", caseInsensitiveAndReferenceConflictTest);
  test("catalog refresh rejects concurrent changes after preflight", optimisticConcurrencyTest);
} else {
  test("catalog import is transactional and reruns are idempotent", {
    skip: "Set RUN_MONGO_INTEGRATION=true in an environment that permits local Mongo processes",
  }, () => {});
  test("catalog import rolls back the accepted batch after a write failure", {
    skip: "Set RUN_MONGO_INTEGRATION=true in an environment that permits local Mongo processes",
  }, () => {});
  test("catalog refresh preserves UUID and manual catalog enrichments", {
    skip: "Set RUN_MONGO_INTEGRATION=true in an environment that permits local Mongo processes",
  }, () => {});
  test("catalog preflight detects case-insensitive and representative-release conflicts", {
    skip: "Set RUN_MONGO_INTEGRATION=true in an environment that permits local Mongo processes",
  }, () => {});
  test("catalog refresh rejects concurrent changes after preflight", {
    skip: "Set RUN_MONGO_INTEGRATION=true in an environment that permits local Mongo processes",
  }, () => {});
}
