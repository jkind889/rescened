const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const AlbumCatalog = require("../models/AlbumCatalog");
const AlbumSubmission = require("../models/AlbumSubmission");
const Artist = require("../models/Artist");
const { AlbumMapping, Job } = require("../models/Listening");
const { artistMbidOf, newArtistDocument } = require("../lib/artists/identity");
const { applyPlan, createPlan } = require("../lib/artists/backfill");
const { applyImport, buildCatalogInput, preflightImport } = require("../lib/catalogImport/persistence");
const { approveAlbumSubmission } = require("../routes/utils/approval");
const {
  correctionSnapshot,
  findDuplicateSignals,
  normalizeCorrectionPayload,
  normalizeSubmissionPayload,
  snapshotForSubmission,
} = require("../routes/utils/submissions");

const integrationEnabled = String(process.env.RUN_MONGO_INTEGRATION || "").toLowerCase() === "true";
const DB_NAME = "rescened_artist_identity";
const MBID_A = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
const MBID_B = "83096042-3785-481e-8843-dee69f1aad12";
const MBID_C = "e941e097-0f9e-496d-a381-dd74a953682c";
const MBID_D = "5b11f4ce-a62d-471e-81fc-a69a8278c7da";
let replSet;

async function setup() {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: DB_NAME });
  await Promise.all([AlbumCatalog.syncIndexes(), AlbumSubmission.syncIndexes(), Artist.syncIndexes(), AlbumMapping.syncIndexes(), Job.syncIndexes()]);
}

async function teardown() {
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
  if (replSet) await replSet.stop();
}

function datasetRow(releaseGroupMbid, title, credits) {
  return {
    releaseGroupMbid,
    representativeReleaseMbid: null,
    selectedRange: "all_time",
    selectionSignals: [{ range: "all_time", rank: 1, listenCount: 10 }],
    title,
    artistDisplayName: credits.map((credit) => `${credit.name}${credit.joinPhrase}`).join(""),
    artistCredits: credits,
    releaseType: "album",
    releaseDate: "2021",
    releaseDatePrecision: "year",
    releaseYear: 2021,
    cover: null,
    sourceFetchedAt: { listenbrainz: "2026-08-14T12:00:00.000Z", musicbrainz: "2026-08-14T12:00:01.000Z" },
  };
}

function validation(rows, datasetId = "identity-integration") {
  return {
    dataset: { schemaVersion: "1.0.0", datasetId, generatedAt: "2026-08-14T12:01:00.000Z", sourceLicenses: {}, albums: rows },
    validAlbums: rows.map((row, index) => ({ row, index })),
    quarantined: [],
    errors: [],
    sha256: "e".repeat(64),
  };
}

function rgRef(mbid) {
  return { provider: "musicbrainz", entityType: "release-group", externalId: mbid, url: `https://musicbrainz.org/release-group/${mbid}` };
}

async function importRegistersAndLinksTest() {
  const group = crypto.randomUUID();
  const rows = [datasetRow(group, "Imported Identity", [
    { artistMbid: MBID_A, name: "Alpha", joinPhrase: " & " },
    { artistMbid: MBID_B, name: "Beta", joinPhrase: "" },
  ])];
  const first = await preflightImport({ validation: validation(rows), AlbumCatalog, Artist });
  assert.deepEqual(first.artistCounts, { registered: 2, reused: 0 });
  await applyImport({ plan: first, AlbumCatalog, Artist, mongoose });

  const album = await AlbumCatalog.findOne({ "externalReferences.externalId": group }).lean();
  const artists = await Artist.find({}).lean();
  const byMbid = new Map(artists.map((artist) => [artistMbidOf(artist), artist]));
  assert.deepEqual(album.artistCredits, [
    { name: "Alpha", role: "main", artistId: byMbid.get(MBID_A).artistId, artistMbid: MBID_A },
    { name: "Beta", role: "main", artistId: byMbid.get(MBID_B).artistId, artistMbid: MBID_B },
  ]);

  const second = await preflightImport({ validation: validation(rows), AlbumCatalog, Artist });
  assert.equal(second.counts.unchanged, 1);
  assert.deepEqual(second.artistCounts, { registered: 0, reused: 0 });
  assert.equal(second.artistOperations.length, 0);

  await assert.rejects(
    Artist.create(newArtistDocument({ name: "Duplicate", artistMbid: MBID_A, source: "manual" })),
    (error) => error.code === 11000,
    "one registry artist per MusicBrainz MBID",
  );
}

async function createSubmission(title, credits) {
  const payload = normalizeSubmissionPayload({
    proposedMetadata: { title, artistCredits: credits, releaseType: "album", releaseDate: "2026" },
    supportingSources: [{ type: "other", url: "https://example.com/evidence" }],
    externalReferences: [],
  });
  const duplicate = await findDuplicateSignals(payload);
  const submittedAt = new Date();
  return AlbumSubmission.create({
    submissionId: crypto.randomUUID(),
    submittedByUserId: "identity-user",
    proposedMetadata: payload.proposedMetadata,
    supportingSources: payload.supportingSources,
    externalReferences: payload.externalReferences,
    normalizedFingerprint: duplicate.fingerprint,
    candidateAlbumCatalogId: duplicate.candidateAlbumCatalogId,
    candidateSubmissionIds: duplicate.candidateSubmissionIds,
    duplicateSignals: duplicate.duplicateSignals,
    status: "pending",
    currentRevision: 1,
    revisions: [snapshotForSubmission(payload, duplicate, submittedAt, 1)],
    moderationHistory: [{ actorUserId: "identity-user", action: "submitted", reason: "", createdAt: submittedAt }],
  });
}

async function createCorrection(target, proposedChanges) {
  const payload = normalizeCorrectionPayload({
    albumId: target.albumId,
    proposedChanges,
    supportingSources: [{ type: "official_label", url: "https://example.com/correction" }],
  }, target);
  const submittedAt = new Date();
  return AlbumSubmission.create({
    submissionId: crypto.randomUUID(),
    submittedByUserId: "identity-correction-user",
    submissionType: "catalog_correction",
    targetAlbumCatalogId: payload.targetAlbumCatalogId,
    baseCatalogRevision: payload.baseCatalogRevision,
    baseValues: payload.baseValues,
    baseProvenance: payload.baseProvenance,
    proposedChanges: payload.proposedChanges,
    supportingSources: payload.supportingSources,
    externalReferences: [],
    normalizedFingerprint: payload.normalizedFingerprint,
    status: "pending",
    currentRevision: 1,
    revisions: [correctionSnapshot(payload, submittedAt, 1)],
    moderationHistory: [{ actorUserId: "identity-correction-user", action: "submitted", reason: "", createdAt: submittedAt }],
  });
}

async function approvalResolvesIdentityTest() {
  const first = await createSubmission("Community Identity One", [
    { name: "Gamma", artistMbid: MBID_C },
    { name: "Unlinked Guest", role: "featured" },
  ]);
  await approveAlbumSubmission({ submissionId: first.submissionId, actorUserId: "moderator", confirmPossibleDuplicate: true, coverResolver: null });
  const firstAlbum = await AlbumCatalog.findOne({ title: "Community Identity One" }).lean();
  const gamma = await Artist.findOne({ artistId: firstAlbum.artistCredits[0].artistId }).lean();
  assert.equal(artistMbidOf(gamma), MBID_C);
  assert.equal(gamma.artistSource, "community");
  assert.equal(gamma.fieldProvenance.externalReferences.submissionId, first.submissionId);
  assert.deepEqual(firstAlbum.artistCredits[1], { name: "Unlinked Guest", role: "featured" });

  const second = await createSubmission("Community Identity Two", [{ name: "Gamma (credited)", artistMbid: MBID_C }]);
  await approveAlbumSubmission({ submissionId: second.submissionId, actorUserId: "moderator", confirmPossibleDuplicate: true, coverResolver: null });
  const secondAlbum = await AlbumCatalog.findOne({ title: "Community Identity Two" }).lean();
  assert.equal(secondAlbum.artistCredits[0].artistId, gamma.artistId, "the registered MBID is reused");
  assert.equal(secondAlbum.artistCredits[0].name, "Gamma (credited)", "credit names stay as submitted");
  assert.equal(await Artist.countDocuments({ "externalReferences.externalId": MBID_C }), 1);

  // A correction that keeps the identified credit and fixes the display name
  // keeps the identity; one naming an unknown artistId is a conflict.
  const kept = await createCorrection(firstAlbum, {
    artists: { artistDisplayName: "Gamma feat. Unlinked Guest", artistCredits: firstAlbum.artistCredits },
  });
  await approveAlbumSubmission({ submissionId: kept.submissionId, actorUserId: "moderator", applyFields: ["artists"], reason: "Display name" });
  const corrected = await AlbumCatalog.findById(firstAlbum._id).lean();
  assert.equal(corrected.artistDisplayName, "Gamma feat. Unlinked Guest");
  assert.deepEqual(corrected.artistCredits, firstAlbum.artistCredits);

  const ghost = await createCorrection(corrected, {
    artists: { artistDisplayName: "Ghost", artistCredits: [{ name: "Ghost", artistId: crypto.randomUUID() }] },
  });
  await assert.rejects(
    approveAlbumSubmission({ submissionId: ghost.submissionId, actorUserId: "moderator", applyFields: ["artists"], reason: "Ghost" }),
    (error) => error.status === 409 && error.code === "ARTIST_IDENTITY_CONFLICT" && error.details[0].code === "ARTIST_NOT_FOUND",
  );
  assert.equal((await AlbumSubmission.findOne({ submissionId: ghost.submissionId }).lean()).status, "pending");
  assert.equal((await AlbumCatalog.findById(firstAlbum._id).lean()).catalogRevision, corrected.catalogRevision);
}

async function backfillPlanApplyTest() {
  await Promise.all([AlbumCatalog.deleteMany({}), Artist.deleteMany({}), AlbumMapping.deleteMany({}), Job.deleteMany({})]);
  const groups = Array.from({ length: 6 }, () => crypto.randomUUID());
  const existingDelta = await Artist.create(newArtistDocument({ name: "Delta", artistMbid: MBID_D, source: "import" }));
  const link = await AlbumCatalog.create({
    albumId: crypto.randomUUID(), title: "Backfill Link", artistDisplayName: "Alpha & Beta",
    artistCredits: [{ name: "Alpha", role: "main" }, { name: "Beta", role: "featured" }],
    externalReferences: [rgRef(groups[0])], fieldProvenance: { artistCredits: { source: "musicbrainz" } },
    catalogSource: "import", catalogRevision: 4,
  });
  const legacy = await AlbumCatalog.create({
    albumId: crypto.randomUUID(), title: "Backfill Legacy", artistDisplayName: "Delta",
    artistCredits: [{ name: "Delta", role: "main" }], externalReferences: [rgRef(groups[1])], catalogSource: "import",
  });
  await AlbumCatalog.collection.updateOne({ _id: legacy._id }, { $unset: { catalogRevision: "" } });
  const community = await AlbumCatalog.create({
    albumId: crypto.randomUUID(), title: "Backfill Community", artistDisplayName: "Alpha",
    artistCredits: [{ name: "Alpha", role: "main" }], externalReferences: [rgRef(groups[2])],
    fieldProvenance: { artistCredits: { source: "community", submissionId: "s" } }, catalogSource: "community",
  });
  const renamed = await AlbumCatalog.create({
    albumId: crypto.randomUUID(), title: "Backfill Renamed", artistDisplayName: "ALPHA",
    artistCredits: [{ name: "ALPHA", role: "main" }], externalReferences: [rgRef(groups[3])], catalogSource: "import",
  });
  const racing = await AlbumCatalog.create({
    albumId: crypto.randomUUID(), title: "Backfill Racing", artistDisplayName: "Beta",
    artistCredits: [{ name: "Beta", role: "main" }], externalReferences: [rgRef(groups[4])], catalogSource: "import", catalogRevision: 2,
  });
  // Legacy migration wrote credits with raw driver calls: folded join phrase
  // with trailing space, a missing role, and a different key order.
  const rawLegacyId = crypto.randomUUID();
  await AlbumCatalog.collection.insertOne({
    albumId: rawLegacyId, title: "Backfill Raw Legacy", artistDisplayName: "Alpha & Beta",
    artistCredits: [{ name: "Alpha & " }, { role: "main", name: "Beta" }],
    externalReferences: [rgRef(groups[5])], catalogSource: "import", catalogRevision: 3,
  });
  await AlbumMapping.create({
    mappingId: crypto.randomUUID(), key: `lastfm:alpha:backfill-link`, artist: "Alpha", album: "Backfill Link",
    artistKey: "alpha", albumKey: "backfill link", albumId: link.albumId, catalogRevision: 4, reviewer: "moderator", reason: "seed",
  });

  const rows = [
    datasetRow(groups[0], "Backfill Link", [{ artistMbid: MBID_A, name: "Alpha", joinPhrase: " & " }, { artistMbid: MBID_B, name: "Beta", joinPhrase: "" }]),
    datasetRow(groups[1], "Backfill Legacy", [{ artistMbid: MBID_D, name: "Delta", joinPhrase: "" }]),
    datasetRow(groups[2], "Backfill Community", [{ artistMbid: MBID_A, name: "Alpha", joinPhrase: "" }]),
    datasetRow(groups[3], "Backfill Renamed", [{ artistMbid: MBID_A, name: "Alpha", joinPhrase: "" }]),
    datasetRow(groups[4], "Backfill Racing", [{ artistMbid: MBID_B, name: "Beta", joinPhrase: "" }]),
    datasetRow(groups[5], "Backfill Raw Legacy", [{ artistMbid: MBID_A, name: "Alpha", joinPhrase: " & " }, { artistMbid: MBID_B, name: "Beta", joinPhrase: "" }]),
  ];
  const catalogBefore = await AlbumCatalog.find({}).sort({ albumId: 1 }).lean();
  const plan = await createPlan({ validations: [validation(rows, "seed-integration")], AlbumCatalog, Artist, databaseName: DB_NAME });
  assert.deepEqual(await AlbumCatalog.find({}).sort({ albumId: 1 }).lean(), catalogBefore, "planning never writes the catalog");
  assert.equal(await Artist.countDocuments({}), 1, "planning never writes the registry");
  assert.equal(plan.counts.link, 4);
  assert.equal(plan.counts.review, 1);
  assert.equal(plan.counts.flagged, 1);
  assert.equal(plan.review[0].albumId, community.albumId);
  assert.equal(plan.flagged[0].albumId, renamed.albumId);
  assert.deepEqual(plan.reusedArtists, [{ artistId: existingDelta.artistId, artistMbid: MBID_D }]);

  await assert.rejects(
    applyPlan({ plan, expectedSha256: plan.planSha256, confirmTarget: "rescened_prod", databaseName: DB_NAME, AlbumCatalog, Artist, mongoose }),
    (error) => error.code === "TARGET_MISMATCH",
  );
  assert.equal(await Artist.countDocuments({}), 1);

  // Another writer changes one album after the plan was reviewed.
  await AlbumCatalog.updateOne({ _id: racing._id }, { $set: { title: "Raced" }, $inc: { catalogRevision: 1 } });

  const report = await applyPlan({ plan, expectedSha256: plan.planSha256, confirmTarget: DB_NAME, databaseName: DB_NAME, AlbumCatalog, Artist, mongoose });
  assert.equal(report.completed, true);
  assert.equal(report.databaseCommitted, true);
  assert.deepEqual(report.registry, { registered: 2, alreadyRegistered: 0 });
  assert.equal(report.counts.applied, 3);
  assert.equal(report.counts.conflict, 1);
  assert.equal(report.counts.mappingsCarried, 1);

  const linked = await AlbumCatalog.findById(link._id).lean();
  const alpha = await Artist.findOne({ "externalReferences.externalId": MBID_A }).lean();
  const beta = await Artist.findOne({ "externalReferences.externalId": MBID_B }).lean();
  assert.deepEqual(linked.artistCredits, [
    { name: "Alpha", role: "main", artistId: alpha.artistId, artistMbid: MBID_A },
    { name: "Beta", role: "featured", artistId: beta.artistId, artistMbid: MBID_B },
  ]);
  assert.equal(linked.catalogRevision, 5);
  assert.equal(linked.fieldProvenance.artistCredits.source, "musicbrainz", "credit provenance is unchanged");
  assert.equal(linked.fieldProvenance.artistIdentity.planSha256, plan.planSha256);
  assert.equal((await AlbumMapping.findOne({ albumId: link.albumId }).lean()).catalogRevision, 5, "active mappings follow the album");

  const rawAfter = await AlbumCatalog.collection.findOne({ albumId: rawLegacyId });
  assert.deepEqual(rawAfter.artistCredits, [
    { name: "Alpha & ", artistId: alpha.artistId, artistMbid: MBID_A },
    { role: "main", name: "Beta", artistId: beta.artistId, artistMbid: MBID_B },
  ], "stored names, keys, and order stay byte-exact");
  assert.equal(rawAfter.catalogRevision, 4);

  const legacyAfter = await AlbumCatalog.findById(legacy._id).lean();
  assert.equal(legacyAfter.catalogRevision, 2);
  assert.equal(legacyAfter.artistCredits[0].artistId, existingDelta.artistId);
  assert.deepEqual((await AlbumCatalog.findById(community._id).lean()).artistCredits, [{ name: "Alpha", role: "main" }]);
  assert.deepEqual((await AlbumCatalog.findById(renamed._id).lean()).artistCredits, [{ name: "ALPHA", role: "main" }]);
  assert.deepEqual((await AlbumCatalog.findById(racing._id).lean()).artistCredits, [{ name: "Beta", role: "main" }]);

  const rerun = await applyPlan({ plan, expectedSha256: plan.planSha256, confirmTarget: DB_NAME, databaseName: DB_NAME, AlbumCatalog, Artist, mongoose });
  assert.deepEqual(rerun.registry, { registered: 0, alreadyRegistered: 2 });
  assert.equal(rerun.counts.applied, 0);
  assert.equal(rerun.counts.alreadyApplied, 3);
  assert.equal(rerun.counts.conflict, 1);
  assert.equal((await AlbumCatalog.findById(link._id).lean()).catalogRevision, 5, "a rerun does not advance revisions again");

  // A fresh plan sees the new registry state; registry drift blocks the old plan.
  await Artist.deleteOne({ artistId: beta.artistId });
  await Artist.create(newArtistDocument({ name: "Beta", artistMbid: MBID_B, source: "manual" }));
  await assert.rejects(
    applyPlan({ plan, expectedSha256: plan.planSha256, confirmTarget: DB_NAME, databaseName: DB_NAME, AlbumCatalog, Artist, mongoose }),
    (error) => error.code === "ARTIST_REGISTRY_CHANGED" && error.backfillReport.databaseCommitted === false,
  );
}

async function reimportAfterBackfillTest() {
  await Promise.all([AlbumCatalog.deleteMany({}), Artist.deleteMany({})]);
  const group = crypto.randomUUID();
  const rows = [datasetRow(group, "Imported Before Identity", [{ artistMbid: MBID_A, name: "Alpha", joinPhrase: "" }])];
  const source = validation(rows, "reimport-dataset");
  // A row imported before this change: name-only credits.
  await AlbumCatalog.create(buildCatalogInput(rows[0], source.dataset));
  const plan = await createPlan({ validations: [source], AlbumCatalog, Artist, databaseName: DB_NAME });
  assert.equal(plan.counts.link, 1);
  await applyPlan({ plan, expectedSha256: plan.planSha256, confirmTarget: DB_NAME, databaseName: DB_NAME, AlbumCatalog, Artist, mongoose });
  const linked = await AlbumCatalog.findOne({ title: "Imported Before Identity" }).lean();
  assert.equal(linked.catalogRevision, 2);

  const reimport = await preflightImport({ validation: source, AlbumCatalog, Artist });
  assert.equal(reimport.counts.unchanged, 1, "re-importing the same dataset after the backfill changes nothing");
  assert.equal(reimport.operations.length, 0);
  assert.equal(reimport.artistOperations.length, 0);
}

const TESTS = [
  ["catalog import registers artists once and links imported credits", importRegistersAndLinksTest],
  ["approval resolves proposed artist identities inside the publication transaction", approvalResolvesIdentityTest],
  ["artist backfill plans without writing and applies only guarded, exact links", backfillPlanApplyTest],
  ["re-importing a dataset after the backfill leaves linked albums unchanged", reimportAfterBackfillTest],
];

if (integrationEnabled) {
  test.before(setup);
  test.after(teardown);
  for (const [name, run] of TESTS) test(name, run);
} else {
  for (const [name] of TESTS) {
    test(name, { skip: "Set RUN_MONGO_INTEGRATION=true in an environment that permits local Mongo processes" }, () => {});
  }
}
