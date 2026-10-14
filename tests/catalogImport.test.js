const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const mongoose = require("mongoose");

const RealAlbumCatalog = require("../models/AlbumCatalog");
const {
  CatalogImportError,
  parseImportArgs,
  buildCatalogInput,
  mergeImportedCatalog,
  preflightImport,
  applyImport,
  assertFinalDocumentSemantics,
  runImport,
} = require("../lib/catalogImport/persistence");
const {
  main: importMain,
  resolveArtifactTargets,
  stageJsonAtomic,
} = require("../scripts/importCatalogDataset");
const {
  main: validateMain,
  parseValidateArgs,
  validationReportPath,
} = require("../scripts/validateCatalogDataset");

const RELEASE_GROUP_MBID = "b84ee12a-09ef-421b-82de-0441a926375b";
const RELEASE_MBID = "59211ea4-ffd2-4ad9-9a4e-e4f9a8c2fdf1";
const ARTIST_MBID = "f27ec8db-af05-4f36-916e-3d57f91ecf5e";

function albumRow(overrides = {}) {
  return {
    releaseGroupMbid: RELEASE_GROUP_MBID,
    representativeReleaseMbid: RELEASE_MBID,
    selectedRange: "all_time",
    selectionSignals: [{ range: "all_time", rank: 1, listenCount: 500000 }],
    title: "Test Album",
    artistDisplayName: "Test Artist",
    artistCredits: [{ artistMbid: ARTIST_MBID, name: "Test Artist", joinPhrase: "" }],
    releaseType: "album",
    releaseDate: "2020-02-03",
    releaseDatePrecision: "day",
    releaseYear: 2020,
    cover: {
      releaseMbid: RELEASE_MBID,
      imageId: 12345,
      url500: `https://coverartarchive.org/release/${RELEASE_MBID}/front-500`,
    },
    sourceFetchedAt: {
      listenbrainz: "2026-08-14T12:00:00.000Z",
      musicbrainz: "2026-08-14T12:00:01.000Z",
    },
    ...overrides,
  };
}

function dataset(overrides = {}) {
  const albums = overrides.albums || [albumRow()];
  return {
    schemaVersion: "1.0.0",
    datasetId: "b793c456-3490-497f-a523-2f394be340cc",
    generatedAt: "2026-08-14T12:01:00.000Z",
    selection: {
      targetAlbumCount: albums.length,
      maxPerPrimaryArtist: 5,
      ranges: [
        {
          range: "all_time",
          quota: albums.length,
          candidateLimit: 1000,
          from: null,
          to: null,
          fetchedAt: "2026-08-14T12:00:00.000Z",
        },
        {
          range: "year",
          quota: 0,
          candidateLimit: 1000,
          from: "2025-01-01",
          to: "2026-01-01",
          fetchedAt: "2026-08-14T12:00:00.000Z",
        },
        {
          range: "month",
          quota: 0,
          candidateLimit: 1000,
          from: "2026-07-01",
          to: "2026-08-01",
          fetchedAt: "2026-08-14T12:00:00.000Z",
        },
      ],
    },
    sourceLicenses: {
      listenbrainz: { license: "CC0-1.0", url: "https://listenbrainz.org/data/" },
      musicbrainz: { license: "CC0-1.0", url: "https://musicbrainz.org/doc/About/Data_License" },
      coverArtArchive: {
        license: "varies-by-image",
        url: "https://musicbrainz.org/doc/Cover_Art_Archive",
        notice: "Cover artwork licensing varies by image.",
      },
    },
    albums,
    ...overrides,
  };
}

function validation(rows = [albumRow()], quarantined = []) {
  const source = dataset({ albums: rows });
  return {
    dataset: source,
    validAlbums: rows.map((row, index) => ({ row, index })),
    quarantined,
    errors: [],
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fakeModel(existing = [], hooks = {}) {
  function FakeAlbumCatalog(document) {
    return new RealAlbumCatalog(document);
  }
  FakeAlbumCatalog.find = hooks.find || (() => Promise.resolve(clone(existing)));
  FakeAlbumCatalog.bulkWrite = hooks.bulkWrite || (async () => ({ matchedCount: 0 }));
  return FakeAlbumCatalog;
}

test("import argument parsing defaults to dry-run and rejects ambiguous input", () => {
  assert.deepEqual(parseImportArgs(["--input", "seed.json"]), {
    input: "seed.json",
    report: "",
    quarantineReport: "",
    apply: false,
    dryRun: true,
    help: false,
  });
  assert.equal(parseImportArgs(["--input", "seed.json", "--apply"]).apply, true);
  assert.throws(
    () => parseImportArgs(["--input", "seed.json", "--apply", "--dry-run"]),
    (error) => error instanceof CatalogImportError && error.code === "INVALID_ARGUMENTS",
  );
  assert.throws(() => parseImportArgs(["--input", "seed.json", "--wat"]), /Unknown argument/);
  assert.throws(() => parseImportArgs([]), /--input is required/);
});

test("validation argument parsing is strict and database independent", () => {
  assert.deepEqual(parseValidateArgs(["--input", "seed.json", "--report", "out.json"]), {
    input: "seed.json",
    report: "out.json",
    help: false,
  });
  assert.throws(() => parseValidateArgs(["seed.json"]), /Unknown argument/);
  assert.throws(() => parseValidateArgs(["--input"]), /requires a value/);
});

test("catalog mapping creates provider-neutral identity, MusicBrainz references, and source provenance", () => {
  const input = buildCatalogInput(albumRow(), dataset());
  assert.match(input.albumId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(input.catalogSource, "import");
  assert.equal(input.title, "Test Album");
  assert.deepEqual(input.artistCredits, [{ name: "Test Artist", role: "main" }]);
  assert.equal(input.tracks.length, 0);
  assert.equal(input.label, "");
  assert.deepEqual(input.externalReferences.map(({ provider, entityType, externalId }) => ({
    provider,
    entityType,
    externalId,
  })), [
    { provider: "musicbrainz", entityType: "release-group", externalId: RELEASE_GROUP_MBID },
    { provider: "musicbrainz", entityType: "release", externalId: RELEASE_MBID },
  ]);
  assert.equal(input.fieldProvenance.title.source, "musicbrainz");
  assert.equal(input.fieldProvenance.cover.source, "cover-art-archive");
  assert.equal(input.fieldProvenance.selectionSignals.source, "listenbrainz");
  assert.equal(input.fieldProvenance._import.sourceLicenses.musicbrainz.license, "CC0-1.0");
});

test("refresh preserves local enrichments, non-MusicBrainz references, user-owned fields, and nonempty cover", () => {
  const original = buildCatalogInput(albumRow(), dataset());
  const existing = {
    ...original,
    _id: new mongoose.Types.ObjectId(),
    albumId: crypto.randomUUID(),
    title: "Community Corrected Title",
    tracks: [{ trackId: "local-track", title: "Local Track", discNumber: 1, trackNumber: 1, durationMs: 0, artistDisplayName: "" }],
    label: "Local Label",
    cover: "https://example.com/existing-cover.jpg",
    externalReferences: [
      ...original.externalReferences,
      { provider: "discogs", entityType: "release", externalId: "42", url: "https://www.discogs.com/release/42" },
    ],
    fieldProvenance: {
      ...original.fieldProvenance,
      title: { source: "community", submissionId: "submission-1" },
      tracks: { source: "manual" },
      label: { source: "manual" },
    },
  };
  const incoming = buildCatalogInput(albumRow({
    title: "New Imported Title",
    representativeReleaseMbid: null,
    cover: null,
  }), dataset());
  const merged = mergeImportedCatalog(existing, incoming);

  assert.equal(merged.albumId, existing.albumId);
  assert.equal(merged.title, "Community Corrected Title");
  assert.deepEqual(merged.fieldProvenance.title, existing.fieldProvenance.title);
  assert.deepEqual(merged.tracks, existing.tracks);
  assert.equal(merged.label, "Local Label");
  assert.equal(merged.cover, existing.cover);
  assert.ok(merged.externalReferences.some((reference) => reference.provider === "discogs"));
  assert.equal(merged.externalReferences.some((reference) => (
    reference.entityType === "release"
    && reference.provider === "musicbrainz"
    && reference.externalId === RELEASE_MBID
  )), true);
  assert.equal(merged.fieldProvenance.externalReferences.representativeReleaseMbid, RELEASE_MBID);
});

test("refresh never writes album genres and keeps their provenance", () => {
  const original = buildCatalogInput(albumRow(), dataset());
  const genreProvenance = { source: "community", submissionId: crypto.randomUUID(), approvedBy: "moderator-1" };
  const existing = {
    ...original,
    albumId: crypto.randomUUID(),
    genres: [new mongoose.Types.ObjectId()],
    genresRevision: 3,
    fieldProvenance: { ...original.fieldProvenance, genres: genreProvenance },
  };
  const merged = mergeImportedCatalog(existing, buildCatalogInput(albumRow({ title: "Refreshed" }), dataset()));

  assert.deepEqual(merged.fieldProvenance.genres, genreProvenance);
  // The refresh $sets DATA_FIELDS only, so genre values are left to the genre service.
  assert.equal("genres" in merged, false);
  assert.equal("genresRevision" in merged, false);
});

test("refresh keeps the representative release for a user-owned CAA cover", () => {
  const original = buildCatalogInput(albumRow(), dataset());
  const existing = {
    ...original,
    albumId: crypto.randomUUID(),
    fieldProvenance: {
      ...original.fieldProvenance,
      cover: { source: "community", releaseMbid: RELEASE_MBID },
    },
  };
  const replacementRelease = "806739ec-6e17-4d21-93ba-c23352276890";
  const incoming = buildCatalogInput(albumRow({
    representativeReleaseMbid: replacementRelease,
    cover: {
      releaseMbid: replacementRelease,
      imageId: 67890,
      url500: `https://coverartarchive.org/release/${replacementRelease}/front-500`,
    },
  }), dataset());
  const merged = mergeImportedCatalog(existing, incoming);

  assert.equal(merged.cover, original.cover);
  assert.ok(merged.externalReferences.some((reference) => (
    reference.provider === "musicbrainz"
    && reference.entityType === "release"
    && reference.externalId === RELEASE_MBID
  )));
  assert.doesNotThrow(() => assertFinalDocumentSemantics(merged, RELEASE_GROUP_MBID));
});

test("refresh preserves a complete user-owned date tuple and final semantics reject inconsistent tuples", () => {
  const incoming = buildCatalogInput(albumRow(), dataset());
  const existing = {
    ...incoming,
    albumId: crypto.randomUUID(),
    releaseDate: "1999",
    releaseDatePrecision: "year",
    releaseYear: 1999,
    fieldProvenance: {
      ...incoming.fieldProvenance,
      releaseDate: { source: "manual" },
    },
  };
  const merged = mergeImportedCatalog(existing, incoming);
  assert.deepEqual({
    releaseDate: merged.releaseDate,
    releaseDatePrecision: merged.releaseDatePrecision,
    releaseYear: merged.releaseYear,
  }, {
    releaseDate: "1999",
    releaseDatePrecision: "year",
    releaseYear: 1999,
  });
  assert.doesNotThrow(() => assertFinalDocumentSemantics(merged, RELEASE_GROUP_MBID));
  assert.throws(
    () => assertFinalDocumentSemantics({ ...merged, releaseDatePrecision: "day" }, RELEASE_GROUP_MBID),
    (error) => error.code === "FINAL_DOCUMENT_SEMANTIC_INVALID",
  );
});

test("preflight quarantines model-invalid rows before any database write", async () => {
  let writeCalls = 0;
  const Model = fakeModel([], {
    bulkWrite: async () => {
      writeCalls += 1;
      return {};
    },
  });
  const invalid = albumRow({
    releaseGroupMbid: "168d1f7c-5a78-4c9d-8469-bc7c91a53cd8",
    title: "",
  });
  const result = await runImport({
    validation: validation([albumRow(), invalid], [{
      rowIndex: 9,
      sourceMbid: null,
      code: "SCHEMA_INVALID",
      pointer: "/albums/9/title",
      message: "title is required",
    }]),
    AlbumCatalog: Model,
    mongoose: {},
    apply: false,
  });

  assert.equal(writeCalls, 0);
  assert.equal(result.plan.operations.length, 1);
  assert.equal(result.report.counts.inserted, 1);
  assert.equal(result.report.counts.quarantined, 2);
  assert.equal(result.exitCode, 2);
  assert.ok(result.plan.quarantined.some((entry) => entry.code === "MODEL_VALIDATION_FAILED"));
});

test("manual or community source collisions are quarantined and never updated", async () => {
  const imported = buildCatalogInput(albumRow(), dataset());
  const existing = {
    ...imported,
    _id: new mongoose.Types.ObjectId(),
    albumId: crypto.randomUUID(),
    catalogSource: "manual",
  };
  const plan = await preflightImport({ validation: validation(), AlbumCatalog: fakeModel([existing]) });
  assert.equal(plan.operations.length, 0);
  assert.equal(plan.counts.conflicted, 1);
  assert.equal(plan.counts.quarantined, 1);
  assert.equal(plan.quarantined[0].code, "EXISTING_CATALOG_CONFLICT");
});

test("MusicBrainz lookups are case-insensitive so uppercase community identities still conflict", async () => {
  const imported = buildCatalogInput(albumRow(), dataset());
  const existing = {
    ...imported,
    _id: new mongoose.Types.ObjectId(),
    albumId: crypto.randomUUID(),
    catalogSource: "community",
    externalReferences: imported.externalReferences.map((reference) => ({
      ...reference,
      externalId: reference.externalId.toUpperCase(),
    })),
  };
  let capturedQuery;
  const Model = fakeModel([existing], {
    find(query) {
      capturedQuery = query;
      return Promise.resolve(clone([existing]));
    },
  });
  const plan = await preflightImport({ validation: validation(), AlbumCatalog: Model });
  assert.equal(plan.counts.conflicted, 1);
  assert.equal(plan.quarantined[0].code, "EXISTING_CATALOG_CONFLICT");
  const clauses = capturedQuery.$or || [capturedQuery];
  const externalIdPatterns = clauses.flatMap((clause) => (
    clause.externalReferences.$elemMatch.externalId.$in
  ));
  assert.ok(externalIdPatterns.some((pattern) => pattern.test(RELEASE_GROUP_MBID.toUpperCase())));
});

test("preflight quarantines MusicBrainz release collisions within the batch and against another catalog album", async () => {
  const secondReleaseGroup = "52caa37a-fa51-4e57-88cf-8d1108bbaa65";
  const rows = [
    albumRow(),
    albumRow({ releaseGroupMbid: secondReleaseGroup, title: "Second Album" }),
  ];
  const batchPlan = await preflightImport({ validation: validation(rows), AlbumCatalog: fakeModel([]) });
  assert.equal(batchPlan.counts.inserted, 1);
  assert.equal(batchPlan.counts.conflicted, 1);
  assert.equal(batchPlan.quarantined[0].code, "DUPLICATE_MUSICBRAINZ_REFERENCE");

  const otherRow = albumRow({
    releaseGroupMbid: "308edab7-7257-4905-a441-8ab55e243360",
    title: "Existing Other Album",
  });
  const existing = {
    ...buildCatalogInput(otherRow, dataset()),
    _id: new mongoose.Types.ObjectId(),
    albumId: crypto.randomUUID(),
    catalogSource: "manual",
  };
  const existingPlan = await preflightImport({
    validation: validation(),
    AlbumCatalog: fakeModel([existing]),
  });
  assert.equal(existingPlan.operations.length, 0);
  assert.equal(existingPlan.quarantined[0].code, "EXISTING_REFERENCE_CONFLICT");
});

test("preflight checks a representative release preserved with an existing cover", async () => {
  const target = {
    ...buildCatalogInput(albumRow(), dataset()),
    _id: new mongoose.Types.ObjectId(),
    albumId: crypto.randomUUID(),
    catalogSource: "import",
  };
  const otherRow = albumRow({
    releaseGroupMbid: "c98e3f67-36a6-4977-8e40-c9e4c90b67f1",
    title: "Other Catalog Album",
  });
  const otherOwner = {
    ...buildCatalogInput(otherRow, dataset()),
    _id: new mongoose.Types.ObjectId(),
    albumId: crypto.randomUUID(),
    catalogSource: "manual",
  };
  let findCalls = 0;
  const Model = fakeModel([], {
    find() {
      findCalls += 1;
      return Promise.resolve(clone(findCalls === 1 ? [target] : [target, otherOwner]));
    },
  });
  const incoming = albumRow({ representativeReleaseMbid: null, cover: null });
  const plan = await preflightImport({ validation: validation([incoming]), AlbumCatalog: Model });

  assert.equal(findCalls, 2);
  assert.equal(plan.operations.length, 0);
  assert.equal(plan.counts.conflicted, 1);
  assert.equal(plan.quarantined[0].code, "EXISTING_REFERENCE_CONFLICT");
  assert.equal(plan.quarantined[0].pointer, "/albums/0/representativeReleaseMbid");
});

test("a repeated import of the same dataset is idempotent", async () => {
  const first = await preflightImport({ validation: validation(), AlbumCatalog: fakeModel([]) });
  assert.equal(first.counts.inserted, 1);
  const persisted = {
    ...clone(first.accepted[0].document),
    _id: new mongoose.Types.ObjectId(),
  };
  const second = await preflightImport({ validation: validation(), AlbumCatalog: fakeModel([persisted]) });
  assert.deepEqual(second.counts, {
    inserted: 0,
    refreshed: 0,
    unchanged: 1,
    quarantined: 0,
    conflicted: 0,
  });
  assert.equal(second.operations.length, 0);
});

test("refresh plans preserve UUID/manual fields and guard updates with updatedAt", async () => {
  const existing = {
    ...buildCatalogInput(albumRow({ title: "Old Imported Title" }), dataset()),
    _id: new mongoose.Types.ObjectId(),
    albumId: crypto.randomUUID(),
    updatedAt: new Date("2026-08-14T12:30:00.000Z"),
  };
  existing.title = "Manual Title";
  existing.fieldProvenance.title = { source: "manual" };
  const plan = await preflightImport({
    validation: validation([albumRow({ releaseDate: "2021", releaseDatePrecision: "year", releaseYear: 2021 })]),
    AlbumCatalog: fakeModel([existing]),
  });
  assert.equal(plan.counts.refreshed, 1);
  assert.equal(plan.accepted[0].document.albumId, existing.albumId);
  assert.equal(plan.accepted[0].document.title, "Manual Title");
  assert.equal(plan.operations[0].updateOne.filter.catalogSource, "import");
  assert.equal(
    new Date(plan.operations[0].updateOne.filter.updatedAt).toISOString(),
    existing.updatedAt.toISOString(),
  );
});

test("apply uses one ordered bulk write inside one transaction", async () => {
  const events = [];
  const session = {
    async withTransaction(callback) {
      events.push("transaction:start");
      await callback();
      events.push("transaction:commit");
    },
    async endSession() {
      events.push("session:end");
    },
  };
  const Model = fakeModel([], {
    bulkWrite: async (operations, options) => {
      events.push(`bulk:${operations.length}:${options.ordered}:${options.session === session}`);
      return { matchedCount: 0 };
    },
  });
  const plan = await preflightImport({ validation: validation(), AlbumCatalog: Model });
  await applyImport({
    plan,
    AlbumCatalog: Model,
    mongoose: { startSession: async () => session },
  });
  assert.deepEqual(events, ["transaction:start", "bulk:1:true:true", "transaction:commit", "session:end"]);
});

test("a failed bulk write propagates and the transaction can roll back all mutations", async () => {
  const stored = [];
  const session = {
    async withTransaction(callback) {
      const before = clone(stored);
      try {
        await callback();
      } catch (error) {
        stored.splice(0, stored.length, ...before);
        throw error;
      }
    },
    async endSession() {},
  };
  const Model = fakeModel([], {
    bulkWrite: async (operations) => {
      stored.push(clone(operations[0].insertOne.document));
      throw new Error("forced write failure");
    },
  });
  const plan = await preflightImport({ validation: validation(), AlbumCatalog: Model });
  await assert.rejects(
    applyImport({ plan, AlbumCatalog: Model, mongoose: { startSession: async () => session } }),
    (error) => {
      assert.match(error.message, /forced write failure/);
      assert.equal(error.importPlan.counts.inserted, 1);
      assert.equal(error.transactionState, "rolled-back");
      return true;
    },
  );
  assert.equal(stored.length, 0);
});

function temporaryDirectory(context, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function outputCapture() {
  const messages = { log: [], error: [] };
  return {
    messages,
    output: {
      log(value) { messages.log.push(String(value)); },
      error(value) { messages.error.push(String(value)); },
    },
  };
}

function transactionDatabase() {
  const session = {
    async withTransaction(callback) { await callback(); },
    async endSession() {},
  };
  return {
    connection: { readyState: 1 },
    startSession: async () => session,
  };
}

test("import artifact paths cannot alias the input or one another", () => {
  assert.throws(
    () => resolveArtifactTargets({ input: "seed.json", report: "seed.json", quarantineReport: "q.json" }),
    (error) => error.code === "INVALID_ARTIFACT_PATHS",
  );
  assert.throws(
    () => resolveArtifactTargets({ input: "seed.json", report: "same.json", quarantineReport: "same.json" }),
    (error) => error.code === "INVALID_ARTIFACT_PATHS",
  );
  assert.throws(
    () => validationReportPath("seed.json", "seed.json"),
    (error) => error.code === "INVALID_ARTIFACT_PATHS",
  );
});

test("artifact staging failure happens before apply and cleans partial temp files", async (context) => {
  const directory = temporaryDirectory(context, "rescened-stage-failure-");
  const input = path.join(directory, "seed.json");
  const report = path.join(directory, "report.json");
  const quarantine = path.join(directory, "quarantine.json");
  let stageCalls = 0;
  let bulkWrites = 0;
  const Model = fakeModel([], {
    bulkWrite: async () => { bulkWrites += 1; return { matchedCount: 0 }; },
  });
  const capture = outputCapture();
  const exitCode = await importMain([
    "--input", input,
    "--report", report,
    "--quarantine-report", quarantine,
    "--apply",
  ], {
    output: capture.output,
    readDatasetFile: async () => validation(),
    AlbumCatalog: Model,
    mongoose: transactionDatabase(),
    artifactIO: {
      stage(target, value) {
        stageCalls += 1;
        if (stageCalls === 2) throw new Error("forced quarantine staging failure");
        return stageJsonAtomic(target, value);
      },
    },
  });
  assert.equal(exitCode, 1);
  assert.equal(bulkWrites, 0);
  assert.equal(fs.readdirSync(directory).some((name) => name.endsWith(".tmp")), false);
});

test("rolled-back apply writes preflight counts and quarantine details", async (context) => {
  const directory = temporaryDirectory(context, "rescened-rollback-report-");
  const input = path.join(directory, "seed.json");
  const reportPath = path.join(directory, "report.json");
  const quarantinePath = path.join(directory, "quarantine.json");
  const knownQuarantine = {
    rowIndex: 3,
    sourceMbid: null,
    code: "INVALID_ALBUM",
    pointer: "/albums/3/title",
    message: "invalid title",
  };
  const Model = fakeModel([], {
    bulkWrite: async () => { throw new Error("forced transaction failure"); },
  });
  const capture = outputCapture();
  const exitCode = await importMain([
    "--input", input,
    "--report", reportPath,
    "--quarantine-report", quarantinePath,
    "--apply",
  ], {
    output: capture.output,
    readDatasetFile: async () => validation([albumRow()], [knownQuarantine]),
    AlbumCatalog: Model,
    mongoose: transactionDatabase(),
  });
  assert.equal(exitCode, 1);
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const quarantine = JSON.parse(fs.readFileSync(quarantinePath, "utf8"));
  assert.equal(report.fatal, true);
  assert.equal(report.transactionState, "rolled-back");
  assert.equal(report.counts.inserted, 1);
  assert.deepEqual(report.quarantine, [knownQuarantine]);
  assert.deepEqual(quarantine.entries, [knownQuarantine]);
});

test("post-apply artifact finalization failure is explicitly reported as committed", async (context) => {
  const directory = temporaryDirectory(context, "rescened-committed-report-");
  const input = path.join(directory, "seed.json");
  let bulkWrites = 0;
  const Model = fakeModel([], {
    bulkWrite: async () => { bulkWrites += 1; return { matchedCount: 0 }; },
  });
  const capture = outputCapture();
  const exitCode = await importMain(["--input", input, "--apply"], {
    output: capture.output,
    readDatasetFile: async () => validation(),
    AlbumCatalog: Model,
    mongoose: transactionDatabase(),
    artifactIO: {
      finalize() { throw new CatalogImportError("forced rename failure", "ARTIFACT_FINALIZATION_FAILED"); },
    },
  });
  assert.equal(exitCode, 1);
  assert.equal(bulkWrites, 1);
  assert.ok(capture.messages.error.some((message) => /Database changes were committed/.test(message)));
  assert.equal(fs.existsSync(path.join(directory, "seed.import-report.json")), false);
});

test("fatal validation reports retain DatasetValidationError quarantine details", async (context) => {
  const directory = temporaryDirectory(context, "rescened-validation-report-");
  const input = path.join(directory, "seed.json");
  const report = path.join(directory, "validation.json");
  const knownQuarantine = [{ rowIndex: 0, code: "INVALID_ALBUM", pointer: "/albums/0" }];
  const error = new Error("zero valid rows");
  error.code = "NO_VALID_ALBUMS";
  error.quarantined = knownQuarantine;
  const capture = outputCapture();
  const exitCode = await validateMain(["--input", input, "--report", report], {
    output: capture.output,
    readDatasetFile: async () => { throw error; },
  });
  assert.equal(exitCode, 1);
  const payload = JSON.parse(fs.readFileSync(report, "utf8"));
  assert.deepEqual(payload.quarantine, knownQuarantine);
  assert.deepEqual(payload.error.quarantined, knownQuarantine);
});
