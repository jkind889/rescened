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
const { applyPlan, buildPlan, createPlan } = require("../lib/artists/backfill");
const { buildEvidence, evidenceBackfillSource } = require("../lib/artists/enrichmentEvidence");
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

async function cliReadOnlyGuardsTest(context) {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { spawnSync } = require("node:child_process");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "artist-cli-guards-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.resolve(__dirname, "..");
  const planDatabase = `${DB_NAME}_cli_plan`;
  const refusedDatabase = `${DB_NAME}_cli_refused`;
  const client = mongoose.connection.getClient();
  context.after(async () => {
    await client.db(planDatabase).dropDatabase();
    await client.db(refusedDatabase).dropDatabase();
  });
  const run = (database, args) => spawnSync(process.execPath, ["scripts/backfillArtistIdentity.js", ...args], {
    cwd: root,
    env: { ...process.env, MONGO_URI: replSet.getUri(database) },
    encoding: "utf8",
    timeout: 30_000,
  });
  const collections = async (database) => (await client.db(database).listCollections({}, { nameOnly: true }).toArray()).map((row) => row.name);

  const planPath = path.join(directory, "dry-run.plan.json");
  const dryRun = run(planDatabase, [
    "--dry-run", "--input", "data/catalog-import/seeds/listenbrainz-2026-08-14.json", "--out", planPath,
  ]);
  assert.equal(dryRun.error, undefined);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(JSON.parse(fs.readFileSync(planPath, "utf8")).target.databaseName, planDatabase);
  assert.deepEqual(await collections(planDatabase), [], "dry-run must not create collections or indexes on a fresh database");

  const plan = buildPlan({ albums: [], validations: [], artistsByMbid: new Map(), artistsById: new Map(), databaseName: planDatabase });
  const applyPath = path.join(directory, "apply.plan.json");
  const reportPath = path.join(directory, "refused.report.json");
  fs.writeFileSync(applyPath, JSON.stringify(plan));
  const refused = run(refusedDatabase, [
    "--apply", "--plan", applyPath, "--plan-sha256", plan.planSha256,
    "--confirm-target", planDatabase, "--report", reportPath,
  ]);
  assert.equal(refused.error, undefined);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /TARGET_MISMATCH/);
  assert.deepEqual(await collections(refusedDatabase), [], "a mismatched target must not receive an artist collection or indexes");
  assert.equal(JSON.parse(fs.readFileSync(reportPath, "utf8")).databaseCommitted, false);
}

async function canonicalImportNameTest() {
  const artistMbid = crypto.randomUUID();
  const creditName = "Jorge Rivera-Herrans, Luke Holt, Anna Lea, Armando Julián, Cast of EPIC";
  const rows = [datasetRow(crypto.randomUUID(), "Canonical artist name", [{ artistMbid, name: creditName, artistName: "Jorge Rivera-Herrans", joinPhrase: "" }])];
  const imported = await preflightImport({ validation: validation(rows, "canonical-names"), AlbumCatalog, Artist });
  await applyImport({ plan: imported, AlbumCatalog, Artist, mongoose });
  const artist = await Artist.findOne({ "externalReferences.externalId": artistMbid }).lean();
  const album = await AlbumCatalog.findOne({ title: "Canonical artist name" }).lean();
  assert.equal(artist.name, "Jorge Rivera-Herrans");
  assert.equal(artist.fieldProvenance.name.nameSource, "musicbrainz-artist");
  assert.equal(album.artistCredits[0].name, creditName);
  assert.equal(album.artistDisplayName, creditName);
  assert.equal(album.artistCredits[0].artistId, artist.artistId);
  assert.equal(album.artistCredits[0].artistName, undefined, "canonical metadata is not copied into album credits");
}


function enrichmentSource(results, generatedAt = "2026-11-12T11:00:00.000Z") {
  const evidence = buildEvidence({ ids: results.map((row) => row.releaseGroupMbid), results, generatedAt });
  return { evidence, ...evidenceBackfillSource({ evidence, sourcePath: "/ops/evidence.json", sha256: "f".repeat(64) }) };
}

function evidenceRow(releaseGroupMbid, credits) {
  return { releaseGroupMbid, status: "resolved", observedAt: "2026-11-12T10:00:00.000Z", title: "Evidence", credits };
}

async function enrichmentPlanApplyTest() {
  await Promise.all([AlbumCatalog.deleteMany({}), Artist.deleteMany({}), AlbumMapping.deleteMany({}), Job.deleteMany({})]);
  const groups = Array.from({ length: 4 }, () => crypto.randomUUID());
  const existingDelta = await Artist.create(newArtistDocument({ name: "Delta (registry)", artistMbid: MBID_D, source: "import" }));
  const link = await AlbumCatalog.create({
    albumId: crypto.randomUUID(), title: "Enriched Link", artistDisplayName: "Alpha with Delta",
    artistCredits: [{ name: "Alpha", role: "main" }, { name: "Delta", role: "featured" }],
    externalReferences: [rgRef(groups[0])], fieldProvenance: { artistCredits: { source: "musicbrainz" } },
    catalogSource: "import", catalogRevision: 6,
  });
  const rawLegacyId = crypto.randomUUID();
  await AlbumCatalog.collection.insertOne({
    albumId: rawLegacyId, title: "Enriched Raw Legacy", artistDisplayName: "Cast with Beta",
    artistCredits: [{ name: "Cast with " }, { role: "main", name: "Beta" }],
    externalReferences: [rgRef(groups[1])], catalogSource: "import", catalogRevision: 2,
  });
  const community = await AlbumCatalog.create({
    albumId: crypto.randomUUID(), title: "Enriched Community", artistDisplayName: "Alpha",
    artistCredits: [{ name: "Alpha", role: "main" }], externalReferences: [rgRef(groups[2])],
    fieldProvenance: { artistCredits: { source: "community", submissionId: "s" } }, catalogSource: "community",
  });
  const missing = await AlbumCatalog.create({
    albumId: crypto.randomUUID(), title: "Enriched Missing", artistDisplayName: "Gamma",
    artistCredits: [{ name: "Gamma", role: "main" }], externalReferences: [rgRef(groups[3])], catalogSource: "import",
  });
  await AlbumMapping.create({
    mappingId: crypto.randomUUID(), key: "lastfm:alpha:enriched-link", artist: "Alpha", album: "Enriched Link",
    artistKey: "alpha", albumKey: "enriched link", albumId: link.albumId, catalogRevision: 6, reviewer: "moderator", reason: "seed",
  });

  const { evidence, validation: source, unresolved } = enrichmentSource([
    evidenceRow(groups[0], [
      { name: "Alpha", joinPhrase: " with ", artistMbid: MBID_A, artistName: "Alpha Canonical" },
      { name: "Delta", joinPhrase: "", artistMbid: MBID_D, artistName: "Delta" },
    ]),
    evidenceRow(groups[1], [
      { name: "Cast", joinPhrase: " with ", artistMbid: MBID_C, artistName: "The Cast" },
      { name: "Beta", joinPhrase: "", artistMbid: MBID_B, artistName: "Beta" },
    ]),
    evidenceRow(groups[2], [{ name: "Alpha", joinPhrase: "", artistMbid: MBID_A, artistName: "Alpha Canonical" }]),
    { releaseGroupMbid: groups[3], status: "unresolved", observedAt: "2026-11-12T10:00:00.000Z", reason: "NOT_FOUND", httpStatus: 404 },
  ]);
  const catalogBefore = await AlbumCatalog.find({}).sort({ albumId: 1 }).lean();
  const plan = await createPlan({ validations: [source], unresolved, AlbumCatalog, Artist, databaseName: DB_NAME });
  assert.deepEqual(await AlbumCatalog.find({}).sort({ albumId: 1 }).lean(), catalogBefore, "planning never writes the catalog");
  assert.equal(await Artist.countDocuments({}), 1, "planning never writes the registry");
  assert.deepEqual([plan.counts.link, plan.counts.review, plan.counts.flagged, plan.counts.artistRegistrations, plan.counts.reusedArtists], [2, 1, 1, 3, 1]);
  assert.equal(plan.review[0].albumId, community.albumId);
  assert.deepEqual([plan.flagged[0].albumId, plan.flagged[0].code, plan.flagged[0].details.reason], [missing.albumId, "ENRICHMENT_UNRESOLVED", "NOT_FOUND"]);
  assert.equal(plan.inputs[0].evidenceSha256, evidence.evidenceSha256);

  const report = await applyPlan({ plan, expectedSha256: plan.planSha256, confirmTarget: DB_NAME, databaseName: DB_NAME, AlbumCatalog, Artist, mongoose });
  assert.equal(report.completed, true);
  assert.deepEqual(report.registry, { registered: 3, alreadyRegistered: 0 });
  assert.equal(report.counts.applied, 2);
  assert.equal(report.counts.mappingsCarried, 1);

  const alpha = await Artist.findOne({ "externalReferences.externalId": MBID_A }).lean();
  const cast = await Artist.findOne({ "externalReferences.externalId": MBID_C }).lean();
  const beta = await Artist.findOne({ "externalReferences.externalId": MBID_B }).lean();
  assert.equal(alpha.name, "Alpha Canonical", "new registry artists take the verified canonical name");
  assert.equal(alpha.fieldProvenance.name.nameSource, "musicbrainz-artist");
  assert.equal(alpha.fieldProvenance.name.evidenceSha256, evidence.evidenceSha256);
  assert.equal(alpha.fieldProvenance.externalReferences.datasetId, evidence.datasetId);
  assert.equal(cast.name, "The Cast");
  assert.equal((await Artist.findOne({ artistId: existingDelta.artistId }).lean()).name, "Delta (registry)", "existing registry names are unchanged");

  const linked = await AlbumCatalog.findById(link._id).lean();
  assert.deepEqual(linked.artistCredits, [
    { name: "Alpha", role: "main", artistId: alpha.artistId, artistMbid: MBID_A },
    { name: "Delta", role: "featured", artistId: existingDelta.artistId, artistMbid: MBID_D },
  ], "credit wording, roles, and order are unchanged");
  assert.equal(linked.catalogRevision, 7);
  assert.equal(linked.fieldProvenance.artistCredits.source, "musicbrainz");
  assert.deepEqual(linked.fieldProvenance.artistIdentity.datasetIds, [evidence.datasetId]);
  assert.equal(linked.fieldProvenance.artistIdentity.planSha256, plan.planSha256);
  assert.equal((await AlbumMapping.findOne({ albumId: link.albumId }).lean()).catalogRevision, 7, "active mappings follow the album");

  const rawAfter = await AlbumCatalog.collection.findOne({ albumId: rawLegacyId });
  assert.deepEqual(rawAfter.artistCredits, [
    { name: "Cast with ", artistId: cast.artistId, artistMbid: MBID_C },
    { role: "main", name: "Beta", artistId: beta.artistId, artistMbid: MBID_B },
  ], "legacy folded join phrases stay byte-exact");
  assert.deepEqual((await AlbumCatalog.findById(community._id).lean()).artistCredits, [{ name: "Alpha", role: "main" }], "community credits are protected");
  assert.deepEqual((await AlbumCatalog.findById(missing._id).lean()).artistCredits, [{ name: "Gamma", role: "main" }]);

  const rerun = await applyPlan({ plan, expectedSha256: plan.planSha256, confirmTarget: DB_NAME, databaseName: DB_NAME, AlbumCatalog, Artist, mongoose });
  assert.deepEqual(rerun.registry, { registered: 0, alreadyRegistered: 3 });
  assert.deepEqual([rerun.counts.applied, rerun.counts.alreadyApplied, rerun.counts.conflict], [0, 2, 0]);
  assert.equal((await AlbumCatalog.findById(link._id).lean()).catalogRevision, 7, "a rerun does not advance revisions again");

  const fresh = await createPlan({ validations: [source], unresolved, AlbumCatalog, Artist, databaseName: DB_NAME });
  assert.deepEqual([fresh.counts.link, fresh.counts.unchanged, fresh.counts.artistRegistrations], [0, 2, 0], "a fresh plan from the same evidence finds nothing left to link");
}

async function correctionBetweenPlanAndApplyTest() {
  await Promise.all([AlbumCatalog.deleteMany({}), Artist.deleteMany({}), AlbumSubmission.deleteMany({})]);
  const group = crypto.randomUUID();
  const album = await AlbumCatalog.create({
    albumId: crypto.randomUUID(), title: "Corrected Before Apply", artistDisplayName: "Alpha",
    artistCredits: [{ name: "Alpha", role: "main" }], externalReferences: [rgRef(group)],
    fieldProvenance: { artistCredits: { source: "musicbrainz" } }, catalogSource: "import", catalogRevision: 1,
  });
  const { validation: source, unresolved } = enrichmentSource([evidenceRow(group, [{ name: "Alpha", joinPhrase: "", artistMbid: MBID_A, artistName: "Alpha" }])]);
  const plan = await createPlan({ validations: [source], unresolved, AlbumCatalog, Artist, databaseName: DB_NAME });
  assert.equal(plan.counts.link, 1);

  // A moderator approves a display-name correction after the plan was reviewed.
  const current = await AlbumCatalog.findById(album._id).lean();
  const correction = await createCorrection(current, { artists: { artistDisplayName: "Alpha (corrected)", artistCredits: current.artistCredits } });
  await approveAlbumSubmission({ submissionId: correction.submissionId, actorUserId: "moderator", applyFields: ["artists"], reason: "Display name" });
  const corrected = await AlbumCatalog.findById(album._id).lean();
  assert.equal(corrected.catalogRevision, 2);

  const report = await applyPlan({ plan, expectedSha256: plan.planSha256, confirmTarget: DB_NAME, databaseName: DB_NAME, AlbumCatalog, Artist, mongoose });
  assert.equal(report.counts.conflict, 1);
  assert.equal(report.counts.applied, 0);
  assert.equal(report.albums[0].reason, "album changed after the plan was created");
  const after = await AlbumCatalog.findById(album._id).lean();
  assert.deepEqual(after.artistCredits, corrected.artistCredits, "the corrected album is not overwritten");
  assert.equal(after.artistDisplayName, "Alpha (corrected)");
  assert.equal(after.catalogRevision, 2);
}


async function userOwnedEnrichmentTest() {
  await Promise.all([AlbumCatalog.deleteMany({}), Artist.deleteMany({}), AlbumSubmission.deleteMany({})]);
  const groups = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const communityProvenance = { source: "community", submissionId: "community-submission", approvedByUserId: "moderator" };
  const community = await AlbumCatalog.create({
    albumId: crypto.randomUUID(), title: "Owned Community", artistDisplayName: "Alpha & Beta",
    artistCredits: [{ name: "Alpha", role: "main" }, { name: "Beta", role: "featured" }], externalReferences: [rgRef(groups[0])],
    fieldProvenance: { artistCredits: communityProvenance }, catalogSource: "community", catalogRevision: 3,
  });
  const manual = await AlbumCatalog.create({
    albumId: crypto.randomUUID(), title: "Owned Manual", artistDisplayName: "Alpha",
    artistCredits: [{ name: "Alpha", role: "main" }], externalReferences: [rgRef(groups[1])],
    fieldProvenance: { artistCredits: { source: "manual", editedBy: "moderator" } }, catalogSource: "manual", catalogRevision: 1,
  });
  const corrected = await AlbumCatalog.create({
    albumId: crypto.randomUUID(), title: "Owned Then Corrected", artistDisplayName: "Beta",
    artistCredits: [{ name: "Beta", role: "main" }], externalReferences: [rgRef(groups[2])],
    fieldProvenance: { artistCredits: { source: "community" } }, catalogSource: "community", catalogRevision: 1,
  });
  const { validation: source, unresolved } = enrichmentSource([
    evidenceRow(groups[0], [
      { name: "Alpha", joinPhrase: " & ", artistMbid: MBID_A, artistName: "Alpha" },
      { name: "Beta", joinPhrase: "", artistMbid: MBID_B, artistName: "Beta" },
    ]),
    evidenceRow(groups[1], [{ name: "Alpha", joinPhrase: "", artistMbid: MBID_A, artistName: "Alpha" }]),
    evidenceRow(groups[2], [{ name: "Beta", joinPhrase: "", artistMbid: MBID_B, artistName: "Beta" }]),
  ]);
  // An open correction on the manual album will go stale once it is linked.
  const openCorrection = await createCorrection(await AlbumCatalog.findById(manual._id).lean(), { artists: { artistDisplayName: "Alpha (open)", artistCredits: [{ name: "Alpha", role: "main" }] } });
  // A needs-changes correction is rebased when revised, so it is not counted.
  const needsChanges = await createCorrection(await AlbumCatalog.findById(community._id).lean(), { artists: { artistDisplayName: "Alpha and Beta", artistCredits: [{ name: "Alpha", role: "main" }, { name: "Beta", role: "featured" }] } });
  await AlbumSubmission.updateOne({ _id: needsChanges._id }, { $set: { status: "needs_changes" } });
  const reviewOnly = await createPlan({ validations: [source], unresolved, AlbumCatalog, AlbumSubmission, Artist, databaseName: DB_NAME });
  assert.deepEqual([reviewOnly.counts.link, reviewOnly.counts.review], [0, 3], "without the option user-owned credits are only proposed");
  assert.equal(reviewOnly.counts.pendingCorrectionsMadeStale, undefined);
  const plan = await createPlan({ validations: [source], unresolved, linkUserOwned: true, AlbumCatalog, AlbumSubmission, Artist, databaseName: DB_NAME });
  assert.deepEqual([plan.counts.link, plan.counts.review, plan.counts.userOwnedLinks], [3, 0, 3]);
  assert.deepEqual([plan.counts.linkedAlbumsWithPendingCorrections, plan.counts.pendingCorrectionsMadeStale], [1, 1]);
  assert.equal(plan.albumUpdates.find((update) => update.albumId === manual.albumId).pendingCorrections, 1);

  // A moderator approves a correction for one album after planning.
  const current = await AlbumCatalog.findById(corrected._id).lean();
  const correction = await createCorrection(current, { artists: { artistDisplayName: "Beta (corrected)", artistCredits: current.artistCredits } });
  await approveAlbumSubmission({ submissionId: correction.submissionId, actorUserId: "moderator", applyFields: ["artists"], reason: "Display name" });

  const report = await applyPlan({ plan, expectedSha256: plan.planSha256, confirmTarget: DB_NAME, databaseName: DB_NAME, AlbumCatalog, Artist, mongoose });
  assert.deepEqual([report.counts.applied, report.counts.conflict], [2, 1]);
  assert.deepEqual(report.options, { linkUserOwnedCredits: true });
  assert.ok(report.albums.filter((outcome) => outcome.status === "applied").every((outcome) => outcome.userOwnedCredits === true));
  const alpha = await Artist.findOne({ "externalReferences.externalId": MBID_A }).lean();
  const beta = await Artist.findOne({ "externalReferences.externalId": MBID_B }).lean();
  const linked = await AlbumCatalog.findById(community._id).lean();
  assert.deepEqual(linked.artistCredits, [
    { name: "Alpha", role: "main", artistId: alpha.artistId, artistMbid: MBID_A },
    { name: "Beta", role: "featured", artistId: beta.artistId, artistMbid: MBID_B },
  ], "wording, roles, and order are kept");
  assert.deepEqual(linked.fieldProvenance.artistCredits, communityProvenance, "the original credit provenance is unchanged");
  assert.equal(linked.fieldProvenance.artistIdentity.planSha256, plan.planSha256);
  assert.equal(linked.fieldProvenance.artistIdentity.userOwnedCredits, true);
  assert.equal(linked.fieldProvenance.artistIdentity.creditProvenance, "community");
  assert.equal(linked.catalogRevision, 4);
  assert.equal(linked.artistDisplayName, "Alpha & Beta");
  const manualAfter = await AlbumCatalog.findById(manual._id).lean();
  assert.equal(manualAfter.fieldProvenance.artistCredits.source, "manual");
  assert.equal(manualAfter.artistCredits[0].artistId, alpha.artistId);
  assert.equal((await AlbumSubmission.findOne({ submissionId: openCorrection.submissionId }).lean()).status, "pending", "linking never changes a submission; it only advances the album revision");
  const correctedAfter = await AlbumCatalog.findById(corrected._id).lean();
  assert.deepEqual(correctedAfter.artistCredits, [{ name: "Beta", role: "main" }], "a correction approved after planning wins");
  assert.equal(correctedAfter.artistDisplayName, "Beta (corrected)");

  const rerun = await applyPlan({ plan, expectedSha256: plan.planSha256, confirmTarget: DB_NAME, databaseName: DB_NAME, AlbumCatalog, Artist, mongoose });
  assert.deepEqual([rerun.counts.applied, rerun.counts.alreadyApplied, rerun.counts.conflict], [0, 2, 1]);
}

const TESTS = [
  ["imported canonical names stay separate from album credited display", canonicalImportNameTest],
  ["artist backfill CLI dry-run and refused apply never initialize database collections", cliReadOnlyGuardsTest],
  ["catalog import registers artists once and links imported credits", importRegistersAndLinksTest],
  ["approval resolves proposed artist identities inside the publication transaction", approvalResolvesIdentityTest],
  ["artist backfill plans without writing and applies only guarded, exact links", backfillPlanApplyTest],
  ["re-importing a dataset after the backfill leaves linked albums unchanged", reimportAfterBackfillTest],
  ["enrichment evidence plans and applies guarded links with verified names and protected credits", enrichmentPlanApplyTest],
  ["a catalog correction approved between enrichment planning and apply is a conflict", correctionBetweenPlanAndApplyTest],
  ["opted-in plans link user-owned credits additively and keep their provenance", userOwnedEnrichmentTest],
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
