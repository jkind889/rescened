const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { artistMbidOf, newArtistDocument } = require("../lib/artists/identity");
const { buildPlan, buildSourceIndex, parseBackfillArgs, verifySealedPlan } = require("../lib/artists/backfill");
const { buildEvidence, evidenceBackfillSource, publishEvidence } = require("../lib/artists/enrichmentEvidence");

const RG = (n) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const A1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const A2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const A3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const AT = "2026-11-12T10:00:00.000Z";
const GENERATED = "2026-11-12T11:00:00.000Z";

const credit = (name, artistMbid, artistName = name, joinPhrase = "") => ({ name, joinPhrase, artistMbid, artistName });
const resolved = (id, credits) => ({ releaseGroupMbid: id, status: "resolved", observedAt: AT, title: "Record", credits });

function evidence() {
  return buildEvidence({
    ids: [RG(1), RG(2), RG(3), RG(4), RG(6), RG(7), RG(8)],
    originPlanSha256: "d".repeat(64),
    generatedAt: GENERATED,
    results: [
      resolved(RG(1), [credit("Alpha", A1, "Alpha", " & "), credit("B.", A2, "Beta Canonical")]),
      resolved(RG(2), [credit("Alpha", A1, "Alpha", " with "), credit("Gamma", A3)]),
      resolved(RG(3), [credit("Alpha", A1)]),
      { releaseGroupMbid: RG(4), status: "unresolved", observedAt: AT, reason: "REDIRECTED", httpStatus: 301, destinationReleaseGroupMbid: RG(9) },
      resolved(RG(6), [credit("Gamma", A3)]),
      resolved(RG(7), [credit("Alpha", A1)]),
      { releaseGroupMbid: RG(8), status: "deferred", observedAt: AT, reason: "TRANSIENT_FAILURE", attempts: 3, lastFailure: "TIMEOUT" },
    ],
  });
}

function album(n, credits, { source = "import", revision = 3 } = {}) {
  return {
    albumId: crypto.randomUUID(),
    title: `Album ${n}`,
    artistCredits: credits,
    externalReferences: [{ provider: "musicbrainz", entityType: "release-group", externalId: RG(n) }],
    fieldProvenance: { artistCredits: { source } },
    catalogSource: source === "import" ? "import" : "community",
    catalogRevision: revision,
  };
}

function planFrom(albums, artists = []) {
  const source = evidenceBackfillSource({ evidence: evidence(), sourcePath: "/ops/evidence.json", sha256: "f".repeat(64) });
  const artistsByMbid = new Map(artists.map((artist) => [artistMbidOf(artist), artist]));
  const artistsById = new Map(artists.map((artist) => [artist.artistId, artist]));
  let next = 0;
  const ids = ["11111111-2222-4333-8444-555555555555", "22222222-3333-4444-8555-666666666666", "33333333-4444-4555-8666-777777777777"];
  return buildPlan({
    albums, validations: [source.validation], unresolved: source.unresolved, artistsByMbid, artistsById,
    databaseName: "rescened_test", now: new Date(GENERATED), newArtistId: () => ids[next++],
  });
}

test("enrichment is a plan-only source, pinned by digest, and never mixed with datasets or name lookups", () => {
  const sha = "a".repeat(64);
  const options = parseBackfillArgs(["--enrichment", "e.json", "--enrichment-sha256", sha.toUpperCase(), "--out", "p.json"]);
  assert.equal(options.enrichment, "e.json");
  assert.equal(options.enrichmentSha256, sha);
  assert.deepEqual(options.inputs, []);
  for (const args of [
    ["--enrichment", "e.json", "--out", "p.json"],
    ["--enrichment-sha256", sha, "--out", "p.json"],
    ["--enrichment", "e.json", "--enrichment-sha256", "short", "--out", "p.json"],
    ["--enrichment", "e.json", "--enrichment-sha256", sha, "--input", "d.json", "--out", "p.json"],
    ["--enrichment", "e.json", "--enrichment-sha256", sha, "--out", "p.json", "--resolve-artist-names", "--artist-name-cache", "/c"],
    ["--enrichment", "e.json", "--enrichment", "f.json", "--enrichment-sha256", sha, "--out", "p.json"],
    ["--apply", "--enrichment", "e.json", "--plan", "p", "--plan-sha256", sha, "--confirm-target", "db", "--report", "r"],
    ["--out", "p.json"],
  ]) assert.throws(() => parseBackfillArgs(args), { code: "INVALID_ARGUMENTS" }, args.join(" "));
});

test("evidence plans link exact matches with verified names and record source provenance", () => {
  const existing = newArtistDocument({ artistId: "44444444-5555-4666-8777-888888888888", name: "Old Gamma Name", artistMbid: A3, source: "import", provenance: { source: "musicbrainz" } });
  const linked = album(1, [{ name: "Alpha", role: "main" }, { name: "B.", role: "featured" }]);
  const legacy = album(2, [{ name: "Alpha with ", role: "main" }, { name: "Gamma", role: "main" }]);
  const community = album(3, [{ name: "Alpha", role: "main" }], { source: "community" });
  const redirected = album(4, [{ name: "Delta", role: "main" }]);
  const uncovered = album(5, [{ name: "Epsilon", role: "main" }]);
  const reused = album(6, [{ name: "Gamma", role: "main" }]);
  const renamed = album(7, [{ name: "Alpha (Live)", role: "main" }]);
  const deferredAlbum = album(8, [{ name: "Zeta", role: "main", artistId: "55555555-6666-4777-8888-999999999999", artistMbid: A3 }], { source: "community" });
  const plan = planFrom([linked, legacy, community, redirected, uncovered, reused, renamed, deferredAlbum], [existing]);
  assert.equal(verifySealedPlan(plan, plan.planSha256), plan.planSha256);
  assert.equal(plan.planVersion, "1.0.0");

  const input = plan.inputs[0];
  const source = evidence();
  assert.equal(input.kind, "rescened-musicbrainz-release-group-credits");
  assert.equal(input.evidenceSha256, source.evidenceSha256);
  assert.equal(input.datasetId, source.datasetId);
  assert.deepEqual([input.validRows, input.unresolvedRows, input.deferredRows], [5, 1, 1]);

  const byAlbum = new Map(plan.albumUpdates.map((update) => [update.albumId, update]));
  assert.deepEqual(new Set(byAlbum.keys()), new Set([linked.albumId, legacy.albumId, reused.albumId]));
  const first = byAlbum.get(linked.albumId);
  assert.deepEqual(first.afterCredits.map((entry) => [entry.name, entry.role, entry.artistMbid]), [["Alpha", "main", A1], ["B.", "featured", A2]]);
  assert.deepEqual(first.datasetIds, [source.datasetId]);
  assert.deepEqual(first.sourceObservations, [{ datasetId: source.datasetId, observedAt: AT }]);
  assert.equal(first.catalogRevision, 3);
  assert.equal(byAlbum.get(legacy.albumId).afterCredits[0].name, "Alpha with ", "legacy folded join phrases keep their wording");
  assert.equal(byAlbum.get(reused.albumId).afterCredits[0].artistId, existing.artistId);

  const registrations = new Map(plan.artistRegistrations.map((artist) => [artistMbidOf(artist), artist]));
  assert.deepEqual([...registrations.keys()].sort(), [A1, A2]);
  const beta = registrations.get(A2);
  assert.equal(beta.name, "Beta Canonical", "new registry names use the verified canonical name, not the credited wording");
  assert.equal(beta.fieldProvenance.name.nameSource, "musicbrainz-artist");
  assert.equal(beta.fieldProvenance.name.observedAt, AT);
  assert.equal(beta.fieldProvenance.name.evidenceSha256, source.evidenceSha256);
  assert.equal(beta.fieldProvenance.externalReferences.datasetId, source.datasetId);
  assert.deepEqual(plan.reusedArtists, [{ artistId: existing.artistId, artistMbid: A3 }]);
  assert.equal(JSON.stringify(plan).includes("Old Gamma Name"), false, "existing registry names are neither renamed nor copied");

  assert.deepEqual(plan.review.map((entry) => [entry.albumId, entry.code]), [[community.albumId, "USER_OWNED_CREDITS"]]);
  const flagged = new Map(plan.flagged.map((entry) => [entry.albumId, entry]));
  assert.equal(flagged.get(redirected.albumId).code, "ENRICHMENT_UNRESOLVED");
  assert.deepEqual(flagged.get(redirected.albumId).details, { status: "unresolved", observedAt: AT, reason: "REDIRECTED", httpStatus: 301, destinationReleaseGroupMbid: RG(9) });
  assert.equal(flagged.get(deferredAlbum.albumId).details.reason, "TRANSIENT_FAILURE");
  assert.equal(flagged.get(deferredAlbum.albumId).details.userOwned, true, "unresolved flags say when credits are user-owned");
  assert.equal(flagged.get(deferredAlbum.albumId).details.alreadyIdentified, true, "and when every credit is already identified");
  assert.equal(flagged.get(redirected.albumId).details.userOwned, undefined);
  assert.equal(flagged.get(renamed.albumId).code, "CREDIT_NAME_MISMATCH");
  assert.deepEqual(plan.noSource.map((entry) => entry.albumId), [uncovered.albumId]);
  assert.equal(plan.counts.flagged, 3);
});

test("import-dataset inputs keep their established plan shape", () => {
  const { inputs, index } = buildSourceIndex([{
    dataset: { datasetId: "seed", schemaVersion: "1.0.0" }, sha256: "e".repeat(64),
    validAlbums: [{ index: 0, row: { releaseGroupMbid: RG(1), artistCredits: [{ artistMbid: A1, name: "Alpha", joinPhrase: "" }] } }],
    quarantined: [],
  }]);
  assert.deepEqual(Object.keys(inputs[0]).sort(), ["datasetId", "file", "quarantinedRows", "schemaVersion", "sha256", "validRows"]);
  assert.deepEqual(index.get(RG(1)).sources, [{ datasetId: "seed", rowIndex: 0 }]);
});

test("the backfill CLI validates pinned evidence before connecting and writes an enrichment plan", async (context) => {
  const { main } = require("../scripts/backfillArtistIdentity");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "enrichment-plan-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = publishEvidence(path.join(directory, "evidence.json"), evidence());
  const logs = [];
  const output = { log: (line) => logs.push(String(line)), error: (line) => logs.push(String(line)) };
  const target = album(1, [{ name: "Alpha", role: "main" }, { name: "B.", role: "featured" }]);
  const offline = {
    output,
    mongoose: { connection: { readyState: 0 }, connect: () => assert.fail("must not connect before the evidence is verified") },
  };
  assert.equal(await main(["--enrichment", file, "--enrichment-sha256", "0".repeat(64), "--out", path.join(directory, "a.json")], offline), 1);
  assert.ok(logs.some((line) => line.startsWith("ENRICHMENT_CHECKSUM_MISMATCH")));
  fs.writeFileSync(path.join(directory, "tampered.json"), fs.readFileSync(file, "utf8").replace("Beta Canonical", "Beta Edited"));
  assert.equal(await main(["--enrichment", path.join(directory, "tampered.json"), "--enrichment-sha256", evidence().evidenceSha256, "--out", path.join(directory, "b.json")], offline), 1);
  assert.equal(fs.existsSync(path.join(directory, "a.json")) || fs.existsSync(path.join(directory, "b.json")), false);

  const connected = {
    output,
    mongoose: { connection: { readyState: 1, name: "rescened_dev" }, startSession: () => assert.fail("planning must not open a transaction") },
    AlbumCatalog: { find: () => ({ select: () => Promise.resolve([target]) }) },
    Artist: { find: () => Promise.resolve([]) },
    now: new Date(GENERATED),
  };
  const planPath = path.join(directory, "plan.json");
  assert.equal(await main(["--enrichment", file, "--enrichment-sha256", evidence().evidenceSha256, "--out", planPath], connected), 0);
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  assert.equal(plan.counts.link, 1);
  assert.equal(plan.inputs[0].evidenceSha256, evidence().evidenceSha256);
});
