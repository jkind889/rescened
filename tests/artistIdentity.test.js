const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const mongoose = require("mongoose");

const AlbumCatalog = require("../models/AlbumCatalog");
const Artist = require("../models/Artist");
const {
  ArtistIdentityError,
  artistMbidOf,
  creditWithIdentity,
  newArtistDocument,
  resolveCreditIdentities,
} = require("../lib/artists/identity");
const {
  ArtistBackfillError,
  applyPlan,
  buildPlan,
  buildSourceIndex,
  parseBackfillArgs,
  sealPlan,
  verifySealedPlan,
} = require("../lib/artists/backfill");
const { buildCatalogInput, createImportReport, preflightImport, applyImport } = require("../lib/catalogImport/persistence");
const { readDatasetFile } = require("../lib/catalogImport/dataset");
const { normalizeAlbumInput } = require("../routes/utils/albumCatalog");
const { normalizeCorrectionPayload, normalizeSubmissionPayload } = require("../routes/utils/submissions");

const MBID_A = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
const MBID_B = "83096042-3785-481e-8843-dee69f1aad12";
const MBID_C = "e941e097-0f9e-496d-a381-dd74a953682c";
const GROUP_1 = "b1392450-e666-3926-a536-22c65f834433";
const GROUP_2 = "1b022e01-4da6-387b-8658-8678046e4cef";
const GROUP_3 = "f5093c06-23e3-404f-aeaa-40f72885ee3a";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// In-memory stand-in for the Artist registry that understands the two query
// shapes the identity helpers issue.
function fakeRegistry(rows = [], { createError } = {}) {
  const artists = clone(rows);
  const created = [];
  return {
    artists,
    created,
    find(query) {
      let result = artists;
      if (query.artistId) result = artists.filter((artist) => query.artistId.$in.includes(artist.artistId));
      if (query.externalReferences) {
        const wanted = query.externalReferences.$elemMatch.externalId.$in;
        result = artists.filter((artist) => wanted.includes(artistMbidOf(artist)));
      }
      return Promise.resolve(clone(result));
    },
    async create(documents) {
      if (createError) throw createError;
      created.push(...clone(documents));
      artists.push(...clone(documents));
      return documents;
    },
    async bulkWrite(operations) {
      created.push(...operations.map((operation) => clone(operation.insertOne.document)));
      return { insertedCount: operations.length };
    },
  };
}

function registered(mbid, name = "Registered Artist", artistId = crypto.randomUUID()) {
  return newArtistDocument({ artistId, name, artistMbid: mbid, source: "import", provenance: { source: "musicbrainz" } });
}

test("credit identity keeps name and role, lowercases IDs, and omits blank identity keys", () => {
  const artistId = crypto.randomUUID();
  assert.deepEqual(creditWithIdentity({ name: "A", role: "main" }, { artistId: artistId.toUpperCase(), artistMbid: MBID_A.toUpperCase() }), {
    name: "A", role: "main", artistId, artistMbid: MBID_A,
  });
  assert.deepEqual(creditWithIdentity({ name: "A" }, { artistId: "", artistMbid: "not-an-mbid" }), { name: "A", role: "main" });
});

test("artist documents use random UUID v4 IDs and never reuse the MBID as the public ID", () => {
  const artist = newArtistDocument({ name: " Radiohead ", artistMbid: MBID_A, source: "import" });
  assert.match(artist.artistId, UUID_V4);
  assert.notEqual(artist.artistId, MBID_A);
  assert.equal(artist.name, "Radiohead");
  assert.equal(artistMbidOf(artist), MBID_A);
  assert.throws(() => newArtistDocument({ name: "x", artistMbid: "bad", source: "import" }), (error) => error.code === "INVALID_ARTIST_MBID");
  assert.throws(() => newArtistDocument({ name: "x", artistMbid: MBID_A, source: "spotify" }), (error) => error.code === "INVALID_ARTIST_SOURCE");
});

test("resolving name-only credits never reads the registry", async () => {
  const registry = { find: () => assert.fail("registry must not be queried"), create: () => assert.fail("no writes") };
  const result = await resolveCreditIdentities([{ name: "Only Name", role: "main" }], { Artist: registry, source: "community" });
  assert.deepEqual(result.credits, [{ name: "Only Name", role: "main" }]);
  assert.deepEqual(result.createdArtists, []);
});

test("resolving reuses registered MBIDs and registers each unknown MBID once", async () => {
  const known = registered(MBID_A, "Known");
  const registry = fakeRegistry([known]);
  const result = await resolveCreditIdentities([
    { name: "Known", role: "main", artistMbid: MBID_A },
    { name: "New", role: "main", artistMbid: MBID_B },
    { name: "New Again", role: "featured", artistMbid: MBID_B },
    { name: "Plain", role: "main" },
  ], { Artist: registry, source: "community", provenance: { source: "community", submissionId: "s-1" } });
  assert.equal(result.createdArtists.length, 1);
  assert.equal(registry.created.length, 1);
  assert.equal(registry.created[0].artistSource, "community");
  assert.equal(registry.created[0].fieldProvenance.externalReferences.submissionId, "s-1");
  assert.deepEqual(result.credits.map((credit) => credit.artistId), [known.artistId, result.createdArtists[0].artistId, result.createdArtists[0].artistId, undefined]);
  assert.deepEqual(result.credits.map((credit) => credit.name), ["Known", "New", "New Again", "Plain"]);
  assert.equal(result.credits[2].role, "featured");
});

test("an artistId-only credit gains its registered MBID; unknown or contradictory IDs are conflicts", async () => {
  const known = registered(MBID_A);
  const registry = fakeRegistry([known]);
  const filled = await resolveCreditIdentities([{ name: "Known", role: "main", artistId: known.artistId }], { Artist: registry, source: "community" });
  assert.deepEqual(filled.credits[0], { name: "Known", role: "main", artistId: known.artistId, artistMbid: MBID_A });

  await assert.rejects(
    resolveCreditIdentities([{ name: "Ghost", artistId: crypto.randomUUID() }], { Artist: registry, source: "community" }),
    (error) => error instanceof ArtistIdentityError && error.code === "ARTIST_IDENTITY_CONFLICT" && error.details[0].code === "ARTIST_NOT_FOUND",
  );
  await assert.rejects(
    resolveCreditIdentities([{ name: "Known", artistId: known.artistId, artistMbid: MBID_B }], { Artist: registry, source: "community" }),
    (error) => error.details[0].code === "ARTIST_MBID_MISMATCH" && error.details[0].registeredMbid === MBID_A,
  );
  assert.equal(registry.created.length, 0);
});

test("a concurrent registration of the same MBID becomes a retryable identity conflict", async () => {
  const registry = fakeRegistry([], { createError: Object.assign(new Error("dup"), { code: 11000 }) });
  await assert.rejects(
    resolveCreditIdentities([{ name: "Racer", artistMbid: MBID_C }], { Artist: registry, source: "community" }),
    (error) => error.code === "ARTIST_IDENTITY_CONFLICT" && error.details[0].code === "ARTIST_REGISTRATION_RACE",
  );
});

test("catalog credits accept identity only as a registry-resolved pair", () => {
  const base = {
    albumId: crypto.randomUUID(), title: "Identity", artistDisplayName: "Artist", releaseType: "album",
  };
  const artistId = crypto.randomUUID();
  assert.equal(new AlbumCatalog({ ...base, artistCredits: [{ name: "Artist", artistId, artistMbid: MBID_A }] }).validateSync(), undefined);
  assert.equal(new AlbumCatalog({ ...base, artistCredits: [{ name: "Artist" }] }).validateSync(), undefined);
  assert.match(String(new AlbumCatalog({ ...base, artistCredits: [{ name: "Artist", artistMbid: MBID_A }] }).validateSync()), /Rescened artistId/);
  assert.ok(new AlbumCatalog({ ...base, artistCredits: [{ name: "Artist", artistId: MBID_A.replace(/^a/, "z") }] }).validateSync());
  const stored = new AlbumCatalog({ ...base, artistCredits: [{ name: "Artist" }] }).toObject();
  assert.deepEqual(stored.artistCredits, [{ name: "Artist", role: "main" }], "identity keys are absent, not blank, when unset");
});

test("the artist model enforces UUID v4 IDs and at most one MusicBrainz reference", () => {
  const artist = new Artist(registered(MBID_A));
  assert.equal(artist.validateSync(), undefined);
  assert.ok(new Artist({ ...registered(MBID_A), artistId: "11111111-1111-1111-8111-111111111111" }).validateSync(), "a version-1 UUID is not a Rescened artist ID");
  const doubled = registered(MBID_A);
  doubled.externalReferences.push({ provider: "musicbrainz", entityType: "artist", externalId: MBID_B, url: "" });
  assert.match(String(new Artist(doubled).validateSync()), /at most one MusicBrainz/);
});

test("catalog creation input preserves credit identity", () => {
  const artistId = crypto.randomUUID();
  const normalized = normalizeAlbumInput({
    title: "T", artistDisplayName: "A", artistCredits: [{ name: "A", role: "main", artistId, artistMbid: MBID_A, extra: "dropped" }],
  });
  assert.deepEqual(normalized.artistCredits, [{ name: "A", role: "main", artistId, artistMbid: MBID_A }]);
});

function submissionBody(credits) {
  return {
    proposedMetadata: { title: "Identity Album", artistCredits: credits, releaseType: "album", releaseDate: "2024" },
    supportingSources: [{ type: "musicbrainz", url: "https://musicbrainz.org/release-group/x" }],
  };
}

test("submission credits accept optional, validated identity fields", () => {
  const artistId = crypto.randomUUID();
  const payload = normalizeSubmissionPayload(submissionBody([
    { name: "With MBID", artistMbid: MBID_A.toUpperCase() },
    { name: "With Both", role: "featured", artistId, artistMbid: MBID_B },
    { name: "Blank Identity", artistId: "", artistMbid: "  " },
  ]));
  assert.deepEqual(payload.proposedMetadata.artistCredits, [
    { name: "With MBID", role: "main", artistMbid: MBID_A },
    { name: "With Both", role: "featured", artistId, artistMbid: MBID_B },
    { name: "Blank Identity", role: "main" },
  ]);
  assert.throws(() => normalizeSubmissionPayload(submissionBody([{ name: "X", artistMbid: "spotify:artist:1" }])), /artistMbid must be a MusicBrainz artist MBID/);
  assert.throws(() => normalizeSubmissionPayload(submissionBody([{ name: "X", artistId: MBID_A.replace(/^a/, "z") }])), /artistId must be a Rescened artist ID/);
  assert.throws(() => normalizeSubmissionPayload(submissionBody([{ name: "X", artistId: 42 }])), /artistId must be/);
  assert.throws(() => normalizeSubmissionPayload(submissionBody([{ name: "X", spotifyArtistId: "1" }])), /is not allowed/);
});

test("a correction that only resends the current identified credits is not an effective change", () => {
  const artistId = crypto.randomUUID();
  const album = {
    _id: new mongoose.Types.ObjectId(),
    albumId: crypto.randomUUID(),
    title: "Target",
    artistDisplayName: "Artist",
    artistCredits: [{ name: "Artist", role: "main", artistId, artistMbid: MBID_A }],
    catalogRevision: 3,
  };
  const body = (credits, artistDisplayName = "Artist") => ({
    albumId: album.albumId,
    proposedChanges: { artists: { artistDisplayName, artistCredits: credits } },
    supportingSources: [{ type: "other", url: "https://example.com/source" }],
  });
  assert.throws(() => normalizeCorrectionPayload(body([{ name: "Artist", role: "main", artistId, artistMbid: MBID_A }]), album), /effective change/);
  const changed = normalizeCorrectionPayload(body([{ name: "Artist", role: "main", artistId, artistMbid: MBID_A }], "Artist (Remastered)"), album);
  assert.deepEqual(changed.proposedChanges.artists.artistCredits, album.artistCredits);
  assert.deepEqual(changed.baseValues.artists.artistCredits, album.artistCredits);
});

function datasetRow(overrides = {}) {
  return {
    releaseGroupMbid: GROUP_1,
    representativeReleaseMbid: null,
    selectedRange: "all_time",
    selectionSignals: [{ range: "all_time", rank: 1, listenCount: 10 }],
    title: "Imported",
    artistDisplayName: "Alpha with Beta",
    artistCredits: [{ artistMbid: MBID_A, name: "Alpha", joinPhrase: " with " }, { artistMbid: MBID_B, name: "Beta", joinPhrase: "" }],
    releaseType: "album",
    releaseDate: "2020",
    releaseDatePrecision: "year",
    releaseYear: 2020,
    cover: null,
    sourceFetchedAt: { listenbrainz: "2026-08-14T12:00:00.000Z", musicbrainz: "2026-08-14T12:00:01.000Z" },
    ...overrides,
  };
}

function importValidation(rows, quarantined = []) {
  return {
    dataset: { schemaVersion: "1.0.0", datasetId: "identity-dataset", generatedAt: "2026-08-14T12:01:00.000Z", sourceLicenses: {}, albums: rows },
    validAlbums: rows.map((row, index) => ({ row, index })),
    quarantined,
    errors: [],
  };
}

function fakeCatalog(existing = [], hooks = {}) {
  function FakeAlbumCatalog(document) {
    return new AlbumCatalog(document);
  }
  FakeAlbumCatalog.find = () => Promise.resolve(clone(existing));
  FakeAlbumCatalog.bulkWrite = hooks.bulkWrite || (async () => ({ matchedCount: 0 }));
  return FakeAlbumCatalog;
}

test("catalog input without a registry map stays name-only; with one, credits carry both IDs", () => {
  const nameOnly = buildCatalogInput(datasetRow(), { datasetId: "d" });
  assert.deepEqual(nameOnly.artistCredits, [{ name: "Alpha", role: "main" }, { name: "Beta", role: "main" }]);
  const ids = new Map([[MBID_A, crypto.randomUUID()], [MBID_B, crypto.randomUUID()]]);
  const linked = buildCatalogInput(datasetRow(), { datasetId: "d" }, ids);
  assert.deepEqual(linked.artistCredits, [
    { name: "Alpha", role: "main", artistId: ids.get(MBID_A), artistMbid: MBID_A },
    { name: "Beta", role: "main", artistId: ids.get(MBID_B), artistMbid: MBID_B },
  ]);
  assert.throws(() => buildCatalogInput(datasetRow(), { datasetId: "d" }, new Map()), (error) => error.code === "ARTIST_IDENTITY_UNRESOLVED");
});

test("import preflight registers each new MBID once, reuses registry artists, and reports both", async () => {
  const known = registered(MBID_A, "Alpha");
  const registry = fakeRegistry([known]);
  const rows = [
    datasetRow(),
    datasetRow({ releaseGroupMbid: GROUP_2, title: "Second", artistDisplayName: "Beta", artistCredits: [{ artistMbid: MBID_B, name: "Beta", joinPhrase: "" }] }),
  ];
  const plan = await preflightImport({ validation: importValidation(rows), AlbumCatalog: fakeCatalog(), Artist: registry });
  assert.equal(plan.counts.inserted, 2);
  assert.deepEqual(plan.artistCounts, { registered: 1, reused: 1 });
  assert.equal(plan.artistOperations.length, 1);
  const newArtist = plan.artistOperations[0].insertOne.document;
  assert.equal(artistMbidOf(newArtist), MBID_B);
  assert.equal(newArtist.artistSource, "import");
  assert.equal(newArtist.fieldProvenance.externalReferences.datasetId, "identity-dataset");
  const [first, second] = plan.accepted.map((record) => record.document);
  assert.equal(first.artistCredits[0].artistId, known.artistId);
  assert.equal(first.artistCredits[1].artistId, newArtist.artistId);
  assert.equal(second.artistCredits[0].artistId, newArtist.artistId);
  assert.deepEqual(createImportReport(plan).artistRegistry, { registered: 1, reused: 1 });
});

test("quarantined import rows never register artists", async () => {
  const plan = await preflightImport({
    validation: importValidation([datasetRow({ title: "" })]),
    AlbumCatalog: fakeCatalog(),
    Artist: fakeRegistry(),
  });
  assert.equal(plan.counts.quarantined, 1);
  assert.equal(plan.artistOperations.length, 0);
});

test("import refresh keeps user-owned credits untouched instead of adding identity", async () => {
  const original = buildCatalogInput(datasetRow(), { datasetId: "d" });
  const existing = {
    ...original,
    _id: new mongoose.Types.ObjectId(),
    artistCredits: [{ name: "Alpha (community)", role: "main" }, { name: "Beta", role: "main" }],
    fieldProvenance: { ...original.fieldProvenance, artistCredits: { source: "community", submissionId: "s" } },
  };
  const plan = await preflightImport({ validation: importValidation([datasetRow()]), AlbumCatalog: fakeCatalog([existing]), Artist: fakeRegistry() });
  assert.equal(plan.counts.refreshed, 1);
  assert.deepEqual(plan.accepted[0].document.artistCredits, existing.artistCredits);
  assert.equal(plan.artistOperations.length, 0, "artists referenced only by preserved credits are not registered");
});

test("import apply registers artists before catalog writes in the same transaction", async () => {
  const calls = [];
  const session = {
    async withTransaction(work) { await work(); },
    async endSession() {},
  };
  const registry = fakeRegistry();
  registry.bulkWrite = async (operations, options) => {
    calls.push(["artists", operations.length, options.session]);
    return {};
  };
  const catalog = fakeCatalog([], {
    bulkWrite: async (operations, options) => {
      calls.push(["albums", operations.length, options.session]);
      return { matchedCount: 0 };
    },
  });
  const plan = await preflightImport({ validation: importValidation([datasetRow()]), AlbumCatalog: catalog, Artist: registry });
  const result = await applyImport({ plan, AlbumCatalog: catalog, Artist: registry, mongoose: { startSession: async () => session } });
  assert.deepEqual(calls, [["artists", 2, session], ["albums", 1, session]]);
  assert.equal(result.writeCount, 3);
  await assert.rejects(applyImport({ plan, AlbumCatalog: catalog, mongoose: { startSession: async () => session } }), (error) => error.code === "ARTIST_REGISTRY_UNAVAILABLE");
});

test("backfill arguments default to planning and gate apply behind a sealed plan and confirmed target", () => {
  assert.deepEqual(parseBackfillArgs(["--input", "a.json", "--input", "b.json", "--out", "plan.json"]).inputs, ["a.json", "b.json"]);
  assert.equal(parseBackfillArgs(["--dry-run", "--input", "a.json", "--out", "p.json"]).mode, "plan");
  assert.throws(() => parseBackfillArgs(["--input", "a.json"]), /--out/);
  assert.throws(() => parseBackfillArgs(["--out", "p.json"]), /--input/);
  assert.throws(() => parseBackfillArgs(["--apply", "--plan", "p.json", "--plan-sha256", "a".repeat(64), "--report", "r.json"]), /--confirm-target/);
  assert.throws(() => parseBackfillArgs(["--apply", "--input", "a.json"]), /sealed plan/);
  assert.throws(() => parseBackfillArgs(["--apply", "--dry-run"]), ArtistBackfillError);
  assert.throws(() => parseBackfillArgs(["--apply", "--plan", "p", "--plan-sha256", "short", "--confirm-target", "db", "--report", "r"]), /SHA-256/);
  const apply = parseBackfillArgs(["--apply", "--plan", "p.json", "--plan-sha256", "A".repeat(64), "--confirm-target", "rescened_dev", "--report", "r.json"]);
  assert.equal(apply.mode, "apply");
  assert.equal(apply.planSha256, "a".repeat(64));
});

function rgRef(mbid) {
  return { provider: "musicbrainz", entityType: "release-group", externalId: mbid, url: `https://musicbrainz.org/release-group/${mbid}` };
}

function catalogAlbum(overrides = {}) {
  return {
    albumId: crypto.randomUUID(),
    title: "Album",
    artistCredits: [{ name: "Alpha", role: "main" }, { name: "Beta", role: "main" }],
    externalReferences: [rgRef(GROUP_1)],
    fieldProvenance: { artistCredits: { source: "musicbrainz" } },
    catalogSource: "import",
    catalogRevision: 2,
    ...overrides,
  };
}

function backfillValidation(rows, datasetId = "seed-a") {
  return { dataset: { datasetId, schemaVersion: "1.0.0" }, validAlbums: rows.map((row, index) => ({ row, index })), quarantined: [], sha256: "f".repeat(64), sourcePath: `/ops/${datasetId}.json` };
}

function sequentialIds() {
  let next = 0;
  return () => {
    next += 1;
    return `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`;
  };
}

test("backfill planning links exact matches and flags everything it cannot prove", () => {
  const known = registered(MBID_C, "Gamma", "11111111-1111-4111-8111-111111111111");
  const albums = {
    link: catalogAlbum({ title: "Link" }),
    reuse: catalogAlbum({
      title: "Reuse",
      artistCredits: [{ name: "Gamma", role: "main" }],
      externalReferences: [rgRef(GROUP_2)],
    }),
    legacyFolded: catalogAlbum({
      title: "Legacy fold",
      artistCredits: [{ name: "Alpha with", role: "main" }, { name: "Beta", role: "featured" }],
      externalReferences: [rgRef(GROUP_3)],
      catalogRevision: undefined,
      fieldProvenance: {},
    }),
    community: catalogAlbum({ title: "Community", fieldProvenance: { artistCredits: { source: "community" } }, catalogSource: "community" }),
    noProvenanceCommunity: catalogAlbum({ title: "Legacy community", fieldProvenance: {}, catalogSource: "community" }),
    renamed: catalogAlbum({ title: "Renamed", artistCredits: [{ name: "alpha", role: "main" }, { name: "Beta", role: "main" }] }),
    count: catalogAlbum({ title: "Count", artistCredits: [{ name: "Alpha", role: "main" }] }),
    otherMbid: catalogAlbum({ title: "Other MBID", artistCredits: [{ name: "Alpha", role: "main", artistId: crypto.randomUUID(), artistMbid: MBID_C }, { name: "Beta", role: "main" }] }),
    twoGroups: catalogAlbum({ title: "Two groups", externalReferences: [rgRef(GROUP_1), rgRef(GROUP_2)] }),
    noSource: catalogAlbum({ title: "No source", externalReferences: [rgRef("9d4f1e2a-0000-4000-8000-000000000000")] }),
    noGroup: catalogAlbum({ title: "No group", externalReferences: [] }),
  };
  const rows = [
    datasetRow(),
    datasetRow({ releaseGroupMbid: GROUP_2, artistCredits: [{ artistMbid: MBID_C, name: "Gamma", joinPhrase: "" }] }),
    datasetRow({ releaseGroupMbid: GROUP_3 }),
  ];
  const plan = buildPlan({
    albums: Object.values(albums),
    validations: [backfillValidation(rows)],
    artistsByMbid: new Map([[MBID_C, known]]),
    artistsById: new Map([[known.artistId, known]]),
    databaseName: "rescened_test",
    now: new Date("2026-11-10T00:00:00.000Z"),
    newArtistId: sequentialIds(),
  });

  const byTitle = (list) => new Map(list.map((entry) => [entry.title, entry]));
  const updates = byTitle(plan.albumUpdates);
  assert.deepEqual([...updates.keys()].sort(), ["Legacy fold", "Link", "Reuse"]);
  assert.deepEqual(plan.counts, {
    scanned: 11, withoutReleaseGroup: 1, link: 3, unchanged: 0, review: 2, flagged: 4, noSource: 1, artistRegistrations: 2, reusedArtists: 1,
  });

  // One registration per MBID, shared across albums; the registry artist is reused.
  assert.deepEqual(
    Object.fromEntries(plan.artistRegistrations.map((artist) => [artistMbidOf(artist), artist.name])),
    { [MBID_A]: "Alpha", [MBID_B]: "Beta" },
  );
  const idFor = new Map(plan.artistRegistrations.map((artist) => [artistMbidOf(artist), artist.artistId]));
  assert.deepEqual(updates.get("Link").afterCredits, [
    { name: "Alpha", role: "main", artistId: idFor.get(MBID_A), artistMbid: MBID_A },
    { name: "Beta", role: "main", artistId: idFor.get(MBID_B), artistMbid: MBID_B },
  ]);
  assert.equal(updates.get("Reuse").afterCredits[0].artistId, known.artistId);
  assert.deepEqual(plan.reusedArtists, [{ artistId: known.artistId, artistMbid: MBID_C }]);

  // Names, roles, and order are preserved exactly, including legacy folded join phrases.
  const legacy = updates.get("Legacy fold");
  assert.deepEqual(legacy.afterCredits.map(({ name, role }) => ({ name, role })), legacy.beforeCredits);
  assert.equal(legacy.storedCatalogRevision, null);
  assert.equal(legacy.catalogRevision, 1);
  assert.equal(updates.get("Link").catalogRevision, 2);

  const review = byTitle(plan.review);
  assert.deepEqual([...review.keys()].sort(), ["Community", "Legacy community"]);
  assert.equal(review.get("Community").code, "USER_OWNED_CREDITS");
  assert.equal(review.get("Community").proposedIdentities[0].artistMbid, MBID_A);

  const flagged = new Map(plan.flagged.map((entry) => [entry.title, entry.code]));
  assert.deepEqual(Object.fromEntries(flagged), {
    Renamed: "CREDIT_NAME_MISMATCH",
    Count: "CREDIT_COUNT_MISMATCH",
    "Other MBID": "EXISTING_IDENTITY_CONFLICT",
    "Two groups": "MULTIPLE_RELEASE_GROUPS",
  });
  assert.equal(plan.noSource[0].releaseGroupMbid, "9d4f1e2a-0000-4000-8000-000000000000");
  assert.equal(plan.inputs[0].file, "seed-a.json");
});

test("already-linked albums are unchanged and disagreeing datasets are source conflicts", () => {
  const alpha = registered(MBID_A, "Alpha");
  const beta = registered(MBID_B, "Beta");
  const linked = catalogAlbum({
    title: "Linked",
    artistCredits: [
      { name: "Alpha", role: "main", artistId: alpha.artistId, artistMbid: MBID_A },
      { name: "Beta", role: "main", artistId: beta.artistId, artistMbid: MBID_B },
    ],
  });
  const disputed = catalogAlbum({ title: "Disputed", externalReferences: [rgRef(GROUP_2)] });
  const plan = buildPlan({
    albums: [linked, disputed],
    validations: [
      backfillValidation([datasetRow(), datasetRow({ releaseGroupMbid: GROUP_2 })], "seed-a"),
      backfillValidation([datasetRow({ releaseGroupMbid: GROUP_2, artistCredits: [{ artistMbid: MBID_C, name: "Alpha", joinPhrase: " with " }, { artistMbid: MBID_B, name: "Beta", joinPhrase: "" }] })], "seed-b"),
    ],
    artistsByMbid: new Map([[MBID_A, alpha], [MBID_B, beta]]),
    artistsById: new Map(),
    databaseName: "rescened_test",
  });
  assert.equal(plan.counts.unchanged, 1);
  assert.equal(plan.counts.link, 0);
  assert.equal(plan.flagged[0].code, "SOURCE_CONFLICT");
  assert.equal(plan.flagged[0].details.sources.length, 2);
});

test("sealed plans detect edits and require the reviewed checksum", () => {
  const plan = buildPlan({
    albums: [catalogAlbum()],
    validations: [backfillValidation([datasetRow()])],
    artistsByMbid: new Map(),
    artistsById: new Map(),
    databaseName: "rescened_test",
    now: new Date("2026-11-10T00:00:00.000Z"),
    newArtistId: sequentialIds(),
  });
  assert.match(plan.planSha256, /^[0-9a-f]{64}$/);
  assert.equal(verifySealedPlan(clone(plan), plan.planSha256), plan.planSha256);
  assert.equal(sealPlan(clone(plan)).planSha256, plan.planSha256, "sealing is deterministic");
  const tampered = clone(plan);
  tampered.albumUpdates[0].afterCredits[0].name = "Changed";
  assert.throws(() => verifySealedPlan(tampered, plan.planSha256), (error) => error.code === "PLAN_CHECKSUM_MISMATCH");
  assert.throws(() => verifySealedPlan(plan, "0".repeat(64)), (error) => error.code === "PLAN_CHECKSUM_MISMATCH");
  assert.throws(() => verifySealedPlan({ ...plan, kind: "other" }, plan.planSha256), (error) => error.code === "INVALID_PLAN");
});

test("apply refuses a re-sealed plan that changes more than artist identity, before any write", async () => {
  const plan = buildPlan({
    albums: [catalogAlbum()],
    validations: [backfillValidation([datasetRow()])],
    artistsByMbid: new Map(),
    artistsById: new Map(),
    databaseName: "rescened_test",
    now: new Date("2026-11-10T00:00:00.000Z"),
    newArtistId: sequentialIds(),
  });
  const touched = [];
  const trap = (name) => new Proxy({}, { get: () => { touched.push(name); throw new Error(`${name} must not be used`); } });
  const attempt = (edit) => {
    const edited = clone(plan);
    edit(edited);
    const sealed = sealPlan(edited);
    return applyPlan({
      plan: sealed, expectedSha256: sealed.planSha256, confirmTarget: "rescened_test", databaseName: "rescened_test",
      AlbumCatalog: trap("AlbumCatalog"), Artist: trap("Artist"), mongoose: trap("mongoose"),
    });
  };
  const invalid = (error) => error.code === "INVALID_PLAN";
  await assert.rejects(attempt((p) => { p.albumUpdates[0].afterCredits[0].name = "Changed"; }), invalid);
  await assert.rejects(attempt((p) => { p.albumUpdates[0].afterCredits[0].role = "featured"; }), invalid);
  await assert.rejects(attempt((p) => { p.albumUpdates[0].afterCredits[0].artistId = "00000000-0000-4000-8000-000000000000"; }), invalid);
  await assert.rejects(attempt((p) => { p.albumUpdates[0].afterCredits.push(clone(p.albumUpdates[0].afterCredits[0])); }), invalid);
  // Re-pointing a credit that already carries another identity to a reused registry pair.
  const otherId = "22222222-2222-4222-8222-222222222222";
  const otherMbid = "b84ee12a-09ef-421b-82de-0441a926375b";
  await assert.rejects(attempt((p) => {
    const update = p.albumUpdates[0];
    update.beforeCredits[0] = { ...update.beforeCredits[0], artistId: "33333333-3333-4333-8333-333333333333", artistMbid: MBID_B };
    update.afterCredits[0] = { ...update.beforeCredits[0], artistId: otherId, artistMbid: otherMbid };
    p.reusedArtists.push({ artistId: otherId, artistMbid: otherMbid });
  }), invalid);
  await assert.rejects(attempt((p) => {
    const update = p.albumUpdates[0];
    update.beforeCredits[0] = { ...update.beforeCredits[0], artistMbid: MBID_B };
  }), invalid, "a prior MBID other than the planned one is never replaced");
  assert.deepEqual(touched, [], "a refused plan touches no model");

  // A credit that already holds the planned MBID is a legitimate link: the guard lets it through to the database step.
  await assert.rejects(attempt((p) => {
    const update = p.albumUpdates[0];
    update.beforeCredits[0] = { ...update.beforeCredits[0], artistMbid: update.afterCredits[0].artistMbid };
  }), (error) => error.code !== "INVALID_PLAN");
  assert.ok(touched.length > 0, "the planned-MBID case reaches the database step");
});

test("the checked-in seed dataset indexes cleanly as a backfill source", () => {
  const validation = readDatasetFile(path.join(__dirname, "../data/catalog-import/seeds/listenbrainz-2026-08-14.json"));
  const { index, inputs } = buildSourceIndex([validation]);
  assert.equal(inputs[0].validRows, validation.validAlbums.length);
  assert.equal(index.size, validation.validAlbums.length);
  for (const source of index.values()) {
    assert.equal(source.conflict, false);
    assert.ok(source.credits.length > 0);
    assert.ok(source.credits.every((credit) => /^[0-9a-f-]{36}$/.test(credit.artistMbid)));
  }
});

const clientSource = fs.readFileSync(path.join(__dirname, "../frontend/src/features/community/artistCredits.js"), "utf8");
const clientHelpers = import(`data:text/javascript;base64,${Buffer.from(clientSource).toString("base64")}`);

test("form credits keep a proposed identity only while the name is unchanged", async () => {
  const { creditIdentity, creditPayload, creditsFromNames, musicBrainzArtistUrl } = await clientHelpers;
  const artistId = crypto.randomUUID();
  const identity = creditIdentity({ name: " Alpha ", artistId, artistMbid: MBID_A });
  assert.deepEqual(creditPayload("Alpha", "main", identity), { name: "Alpha", role: "main", artistId, artistMbid: MBID_A });
  assert.deepEqual(creditPayload("Alpha (renamed)", "main", identity), { name: "Alpha (renamed)", role: "main" });
  assert.equal(creditIdentity({ name: "Plain" }), null);
  assert.equal(musicBrainzArtistUrl(identity), `https://musicbrainz.org/artist/${MBID_A}`);
  assert.equal(musicBrainzArtistUrl({ artistMbid: "javascript:alert(1)" }), "");

  const known = [
    { name: "Alpha", role: "main", artistId, artistMbid: MBID_A },
    { name: "Beta", role: "featured", artistMbid: MBID_B },
  ];
  assert.deepEqual(creditsFromNames("Beta, Alpha, Gamma", known), [
    { name: "Beta", role: "featured", artistMbid: MBID_B },
    { name: "Alpha", role: "main", artistId, artistMbid: MBID_A },
    { name: "Gamma", role: "main" },
  ]);
  assert.deepEqual(creditsFromNames("Alpha, Alpha", known).map((credit) => credit.artistId), [artistId, undefined], "each known credit is reused once");
  assert.deepEqual(creditsFromNames(" , ", known), []);
});

test("moderator review flags a credit worded differently from its linked registry artist", async () => {
  const { registryNameDiffers } = await clientHelpers;
  assert.equal(registryNameDiffers("Radiohead", "Radiohead"), false);
  assert.equal(registryNameDiffers("  radiohead ", "Radiohead"), false, "case and spacing are not differences");
  assert.equal(registryNameDiffers("Ｒａｄｉｏｈｅａｄ", "Radiohead"), false, "compatibility forms fold");
  assert.equal(registryNameDiffers("Someone Else", "Radiohead"), true);
  assert.equal(registryNameDiffers("Anything", ""), false, "no registry name, nothing to compare");
  const panel = fs.readFileSync(path.join(__dirname, "../frontend/src/Components/Community/SubmissionDetails.jsx"), "utf8");
  assert.match(panel, /Credited name differs from the registry name/);
  assert.match(panel, /Unknown Rescened artist/);
  const page = fs.readFileSync(path.join(__dirname, "../frontend/src/Pages/ModerationSuggestions.jsx"), "utf8");
  assert.match(page, /artistRegistry=\{activeDetailState\.data\?\.artistRegistry \|\| null\}/);
});

test("the backfill CLI writes a sealed plan once and refuses an unconfirmed apply target", async (context) => {
  const os = require("node:os");
  const { main } = require("../scripts/backfillArtistIdentity");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "artist-backfill-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const planPath = path.join(directory, "plan.json");
  const logs = [];
  const output = { log: (line) => logs.push(String(line)), error: (line) => logs.push(String(line)) };
  const writes = [];
  const dependencies = {
    output,
    readDatasetFile: () => backfillValidation([datasetRow()]),
    mongoose: { connection: { readyState: 1, name: "rescened_dev" }, startSession: () => assert.fail("planning must not open a transaction") },
    AlbumCatalog: { find: () => ({ select: () => Promise.resolve([catalogAlbum()]) }), updateOne: () => writes.push("album") },
    Artist: { find: () => Promise.resolve([]), create: () => writes.push("artist"), createIndexes: () => writes.push("indexes") },
    now: new Date("2026-11-10T00:00:00.000Z"),
  };
  assert.equal(await main(["--input", "seed.json", "--out", planPath], dependencies), 0);
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  assert.equal(plan.target.databaseName, "rescened_dev");
  assert.equal(plan.counts.link, 1);
  assert.equal(verifySealedPlan(plan, plan.planSha256), plan.planSha256);
  assert.ok(logs.some((line) => line.includes(`--plan-sha256 ${plan.planSha256} --confirm-target rescened_dev`)));
  assert.equal(await main(["--input", "seed.json", "--out", planPath], dependencies), 1, "an existing plan is never overwritten");

  const reportPath = path.join(directory, "report.json");
  const apply = ["--apply", "--plan", planPath, "--plan-sha256", plan.planSha256, "--confirm-target", "rescened_prod", "--report", reportPath];
  assert.equal(await main(apply, dependencies), 1);
  assert.ok(logs.some((line) => line.startsWith("TARGET_MISMATCH")));
  const failure = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(failure.databaseCommitted, false, "the reserved report records that nothing was committed");
  assert.equal(await main(apply, dependencies), 1, "an existing report is never overwritten");
  assert.deepEqual(writes, []);
});

test("the backfill CLI disables automatic collection and index creation on connection", async (context) => {
  const os = require("node:os");
  const { main } = require("../scripts/backfillArtistIdentity");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "artist-backfill-connect-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const events = [];
  const db = {
    connection: { readyState: 0, name: "" },
    async connect(uri, options) {
      assert.equal(uri, "mongodb://development.example/rescened_dev");
      assert.deepEqual(options, { autoCreate: false, autoIndex: false });
      events.push("connect");
      this.connection = { readyState: 1, name: "rescened_dev" };
    },
    async disconnect() { events.push("disconnect"); },
    startSession() { assert.fail("planning must not open a transaction"); },
  };
  const code = await main(["--dry-run", "--input", "seed.json", "--out", path.join(directory, "plan.json")], {
    mongoose: db,
    mongoUri: "mongodb://development.example/rescened_dev",
    output: { log() {}, error: (message) => assert.fail(message) },
    readDatasetFile() { events.push("validate-input"); return backfillValidation([datasetRow()]); },
    AlbumCatalog: { find: () => ({ select: () => Promise.resolve([catalogAlbum()]) }) },
    Artist: { find: () => Promise.resolve([]), createIndexes: () => assert.fail("planning must not create indexes") },
  });
  assert.equal(code, 0);
  assert.deepEqual(events, ["validate-input", "connect", "disconnect"]);
});

test("the backfill CLI checks the seal and every target before creating indexes", async (context) => {
  const os = require("node:os");
  const { main } = require("../scripts/backfillArtistIdentity");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "artist-backfill-guards-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const plan = buildPlan({ albums: [], validations: [], artistsByMbid: new Map(), artistsById: new Map(), databaseName: "rescened_dev" });
  const cases = [
    { name: "edited-plan", document: { ...plan, generatedAt: "changed" }, expected: "PLAN_CHECKSUM_MISMATCH", connects: 0 },
    { name: "wrong-checksum", checksum: "0".repeat(64), expected: "PLAN_CHECKSUM_MISMATCH", connects: 0 },
    { name: "unconfirmed-target", confirmTarget: "rescened_other", expected: "TARGET_MISMATCH", connects: 0 },
    { name: "wrong-connection", connectedTarget: "rescened_other", expected: "TARGET_MISMATCH", connects: 1 },
    { name: "valid-plan", connects: 1 },
  ];
  for (const scenario of cases) {
    const planPath = path.join(directory, `${scenario.name}.plan.json`);
    const reportPath = path.join(directory, `${scenario.name}.report.json`);
    fs.writeFileSync(planPath, JSON.stringify(scenario.document || plan));
    const events = [];
    const errors = [];
    const db = {
      connection: { readyState: 0, name: "" },
      async connect(_uri, options) {
        assert.deepEqual(options, { autoCreate: false, autoIndex: false });
        events.push("connect");
        this.connection = { readyState: 1, name: scenario.connectedTarget || "rescened_dev" };
      },
      async disconnect() { events.push("disconnect"); },
      async startSession() {
        events.push("transaction");
        return { async withTransaction(work) { await work(); }, async endSession() {} };
      },
    };
    const code = await main([
      "--apply", "--plan", planPath, "--plan-sha256", scenario.checksum || plan.planSha256,
      "--confirm-target", scenario.confirmTarget || "rescened_dev", "--report", reportPath,
    ], {
      mongoose: db,
      mongoUri: "mongodb://development.example/rescened_dev",
      AlbumCatalog: {},
      Artist: { createIndexes: async () => { events.push("indexes"); }, find: () => assert.fail("empty registry must not be queried") },
      output: { log() {}, error: (message) => errors.push(message) },
    });
    assert.equal(code, scenario.expected ? 1 : 0, scenario.name);
    assert.equal(events.filter((event) => event === "connect").length, scenario.connects, scenario.name);
    if (scenario.expected) {
      assert.ok(errors.some((message) => message.startsWith(scenario.expected)), scenario.name);
      assert.equal(events.includes("indexes"), false, `${scenario.name} must not create indexes`);
      assert.equal(events.includes("transaction"), false, `${scenario.name} must not start a transaction`);
    } else {
      assert.deepEqual(events, ["connect", "indexes", "transaction", "disconnect"]);
    }
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.databaseCommitted, false, scenario.name);
  }
});

test("verified-name planning is explicit and never enabled during apply", () => {
  const options = parseBackfillArgs(["--input", "seed.json", "--out", "plan.json", "--resolve-artist-names", "--artist-name-cache", "/ops/artist-names"]);
  assert.equal(options.resolveArtistNames, true);
  assert.equal(options.artistNameCache, "/ops/artist-names");
  for (const args of [
    ["--input", "seed.json", "--out", "plan.json", "--resolve-artist-names"],
    ["--input", "seed.json", "--out", "plan.json", "--artist-name-cache", "/ops/cache"],
    ["--apply", "--resolve-artist-names", "--artist-name-cache", "/ops/cache"],
  ]) assert.throws(() => parseBackfillArgs(args), { code: "INVALID_ARGUMENTS" });
});

test("canonical metadata initializes registry names without changing import or backfill credits", async () => {
  const row = datasetRow({ artistCredits: [{ artistMbid: MBID_A, name: "Alpha, Beta and the cast", artistName: "Alpha", joinPhrase: "" }], artistDisplayName: "Alpha, Beta and the cast" });
  const source = backfillValidation([row]);
  const imported = await preflightImport({ validation: importValidation([row]), AlbumCatalog: fakeCatalog(), Artist: fakeRegistry() });
  assert.equal(imported.artistOperations[0].insertOne.document.name, "Alpha");
  assert.equal(imported.artistOperations[0].insertOne.document.fieldProvenance.name.nameSource, "musicbrainz-artist");
  assert.equal(imported.accepted[0].document.artistCredits[0].name, row.artistCredits[0].name);
  const album = catalogAlbum({ artistCredits: [{ name: row.artistCredits[0].name, role: "main" }] });
  const planned = buildPlan({ albums: [album], validations: [source], artistsByMbid: new Map(), artistsById: new Map(), databaseName: "rescened_dev" });
  assert.equal(planned.artistRegistrations[0].name, "Alpha");
  assert.equal(planned.albumUpdates[0].afterCredits[0].name, row.artistCredits[0].name);
  const conflicting = datasetRow({ ...row, releaseGroupMbid: GROUP_2, artistCredits: [{ ...row.artistCredits[0], artistName: "Different artist name" }] });
  await assert.rejects(preflightImport({ validation: importValidation([row, conflicting]), AlbumCatalog: fakeCatalog(), Artist: fakeRegistry() }), { code: "ARTIST_NAME_CONFLICT" });
  const conflictPlan = buildPlan({ albums: [album], validations: [backfillValidation([row, conflicting])], artistsByMbid: new Map(), artistsById: new Map(), databaseName: "rescened_dev" });
  assert.equal(conflictPlan.counts.link, 0);
  assert.equal(conflictPlan.flagged[0].code, "SOURCE_CONFLICT");
});

test("contributors cannot claim a trusted canonical artist name", () => {
  assert.throws(() => normalizeSubmissionPayload({
    proposedMetadata: { title: "Album", artistCredits: [{ name: "Credit", role: "main", artistMbid: MBID_A, artistName: "Spoofed canonical name" }], releaseType: "album", releaseDate: "2026" },
    supportingSources: [{ type: "other", url: "https://example.com/source" }],
    externalReferences: [],
  }), /artistName/);
});

test("a failed artist-name lookup leaves no final plan artifact", async (context) => {
  const os = require("node:os");
  const { main } = require("../scripts/backfillArtistIdentity");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "artist-name-cli-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const outputPath = path.join(directory, "plan.json");
  const errors = [];
  const code = await main(["--input", "seed.json", "--out", outputPath, "--resolve-artist-names", "--artist-name-cache", path.join(directory, "cache")], {
    mongoose: { connection: { readyState: 1, name: "rescened_dev" } },
    AlbumCatalog: { find: () => ({ select: () => Promise.resolve([catalogAlbum()]) }) },
    Artist: { find: () => Promise.resolve([]) },
    readDatasetFile: () => backfillValidation([datasetRow()]),
    resolvePlanArtistNames: async () => { throw Object.assign(new Error("Name unavailable"), { code: "ARTIST_NAME_HTTP_ERROR" }); },
    output: { log() {}, error: (message) => errors.push(message) },
  });
  assert.equal(code, 1);
  assert.equal(fs.existsSync(outputPath), false);
  assert.ok(errors.some((message) => message.startsWith("ARTIST_NAME_HTTP_ERROR")));
});
