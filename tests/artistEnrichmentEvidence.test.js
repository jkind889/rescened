const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  EVIDENCE_KIND,
  MAX_REQUEST_IDS,
  buildEvidence,
  evidenceExitCode,
  normalizeRequestIds,
  publishEvidence,
  readEvidenceFile,
  readIdsFile,
  readPlanNoSourceIds,
  requestDigest,
  sealEvidence,
  validateEvidence,
} = require("../lib/artists/enrichmentEvidence");
const { sealPlan } = require("../lib/artists/backfill");
const { readDatasetFile, validateDatasetObject } = require("../lib/catalogImport/dataset");

const RG1 = "11111111-1111-4111-8111-111111111111";
const RG2 = "22222222-2222-4222-8222-222222222222";
const RG3 = "33333333-3333-4333-8333-333333333333";
const A1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const A2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AT = "2026-11-12T10:00:00.000Z";

const resolved = (id = RG1, credits = [{ name: "Alpha", joinPhrase: " & ", artistMbid: A1, artistName: "Alpha" }, { name: "Beta", joinPhrase: "", artistMbid: A2, artistName: "Beta Canonical" }]) => ({
  releaseGroupMbid: id, status: "resolved", observedAt: AT, title: "Record", credits,
});
const unresolved = (id = RG2, extra = {}) => ({ releaseGroupMbid: id, status: "unresolved", observedAt: AT, reason: "NOT_FOUND", httpStatus: 404, ...extra });
const deferred = (id = RG3) => ({ releaseGroupMbid: id, status: "deferred", observedAt: AT, reason: "TRANSIENT_FAILURE", attempts: 3, lastFailure: "HTTP_503" });

function tempDir(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "enrichment-evidence-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function build(results = [resolved(), unresolved(), deferred()], ids = results.map((row) => row.releaseGroupMbid)) {
  return buildEvidence({ ids, results, generatedAt: "2026-11-12T11:00:00.000Z" });
}

function resealed(evidence, mutate) {
  const copy = JSON.parse(JSON.stringify(evidence));
  mutate(copy);
  return sealEvidence(copy);
}

test("request IDs are validated, lowercased, sorted, deduplicated, and bounded", () => {
  assert.deepEqual(normalizeRequestIds([RG2, ` ${RG1.toUpperCase()} `, RG2]), [RG1, RG2]);
  assert.throws(() => normalizeRequestIds([RG1, "not-an-mbid", 7]), (error) => error.code === "INVALID_ID_LIST" && error.details.length === 2);
  assert.throws(() => normalizeRequestIds([]), { code: "INVALID_ID_LIST" });
  assert.throws(() => normalizeRequestIds({ ids: [RG1] }), { code: "INVALID_ID_LIST" });
  const many = Array.from({ length: MAX_REQUEST_IDS + 1 }, (_, index) => `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`);
  assert.throws(() => normalizeRequestIds(many), { code: "ID_LIMIT_EXCEEDED" });
  assert.equal(normalizeRequestIds(many.slice(0, MAX_REQUEST_IDS)).length, MAX_REQUEST_IDS);
  assert.equal(requestDigest([RG1, RG2]), requestDigest(normalizeRequestIds([RG2, RG1, RG1])));
});

test("ID files are read as bounded JSON arrays", (context) => {
  const directory = tempDir(context);
  const file = path.join(directory, "ids.json");
  fs.writeFileSync(file, JSON.stringify([RG2, RG1, RG1]));
  assert.deepEqual(readIdsFile(file), { ids: [RG1, RG2], originPlanSha256: null });
  fs.writeFileSync(file, "[not json");
  assert.throws(() => readIdsFile(file), { code: "INVALID_ID_LIST" });
  assert.throws(() => readIdsFile(path.join(directory, "missing.json")), { code: "INVALID_ID_LIST" });
});

test("--from-plan IDs come only from a verified sealed plan's noSource list", (context) => {
  const directory = tempDir(context);
  const plan = sealPlan({
    kind: "rescened-artist-identity-backfill", planVersion: "1.0.0", target: { databaseName: "rescened_test" },
    noSource: [{ albumId: "x", releaseGroupMbid: RG2 }, { albumId: "y", releaseGroupMbid: RG1 }, { albumId: "z", releaseGroupMbid: RG2 }],
  });
  const file = path.join(directory, "plan.json");
  fs.writeFileSync(file, JSON.stringify(plan));
  assert.deepEqual(readPlanNoSourceIds(file, plan.planSha256), { ids: [RG1, RG2], originPlanSha256: plan.planSha256 });
  assert.throws(() => readPlanNoSourceIds(file, "0".repeat(64)), { code: "PLAN_CHECKSUM_MISMATCH" });
  fs.writeFileSync(file, JSON.stringify({ ...plan, noSource: [{ releaseGroupMbid: RG3 }] }));
  assert.throws(() => readPlanNoSourceIds(file, plan.planSha256), { code: "PLAN_CHECKSUM_MISMATCH" });
});

test("evidence is sealed with exact accounting, counts, and failure reasons", () => {
  const evidence = build([deferred(), resolved(), unresolved()]);
  assert.equal(evidence.kind, EVIDENCE_KIND);
  assert.equal(evidence.schemaVersion, "1.0.0");
  assert.deepEqual(evidence.results.map((row) => row.releaseGroupMbid), [RG1, RG2, RG3]);
  assert.deepEqual(evidence.counts, { requested: 3, resolved: 1, unresolved: 1, deferred: 1 });
  assert.deepEqual(evidence.failureReasons, { unresolved: { NOT_FOUND: 1 }, deferred: { TRANSIENT_FAILURE: 1 } });
  assert.equal(evidence.request.releaseGroupMbidsSha256, requestDigest([RG1, RG2, RG3]));
  assert.equal(evidence.request.originPlanSha256, null);
  assert.equal(evidence.source.license, "CC0-1.0");
  assert.match(evidence.datasetId, /^musicbrainz-rg-credits-20261112t110000z-[0-9a-f]{12}$/);
  assert.match(evidence.evidenceSha256, /^[0-9a-f]{64}$/);
  assert.equal(evidenceExitCode(evidence), 2);
  assert.equal(evidenceExitCode(build([resolved()])), 0);
  assert.equal(JSON.stringify(evidence).includes("listenbrainz"), false);
  assert.equal(JSON.stringify(evidence).includes("rank"), false);
});

test("building rejects missing, duplicate, and unrequested results", () => {
  assert.throws(() => build([resolved()], [RG1, RG2]), /Missing result/);
  assert.throws(() => build([resolved(), resolved()], [RG1]), /Duplicate result/);
  assert.throws(() => build([resolved(), unresolved()], [RG1]), /not requested/);
});

test("validation rejects tampering, unknown fields, and inconsistent accounting", () => {
  const evidence = build();
  assert.equal(validateEvidence(evidence), evidence);
  const tampered = JSON.parse(JSON.stringify(evidence));
  tampered.results[0].credits[0].artistMbid = A2;
  assert.throws(() => validateEvidence(tampered), { code: "ENRICHMENT_CHECKSUM_MISMATCH" });

  const cases = [
    (copy) => { copy.extra = true; },
    (copy) => { copy.results[0].rank = 1; },
    (copy) => { copy.results[0].credits[0].role = "main"; },
    (copy) => { copy.results.pop(); },
    (copy) => { copy.results.push(unresolved("44444444-4444-4444-8444-444444444444")); },
    (copy) => { copy.results.reverse(); },
    (copy) => { copy.results[1] = { ...copy.results[0] }; },
    (copy) => { copy.counts.resolved = 3; },
    (copy) => { copy.failureReasons.unresolved = {}; },
    (copy) => { copy.request.count = 4; },
    (copy) => { copy.request.originPlanSha256 = "nope"; },
    (copy) => { copy.source.license = "CC-BY"; },
    (copy) => { copy.datasetId = "other"; },
    (copy) => { copy.generatedAt = "2026-11-12"; },
  ];
  for (const mutate of cases) assert.throws(() => validateEvidence(resealed(evidence, mutate)), { code: "INVALID_ENRICHMENT_EVIDENCE" }, String(mutate));
  assert.throws(() => validateEvidence({ ...evidence, kind: "rescened-catalog-import" }), { code: "INVALID_ENRICHMENT_EVIDENCE" });
  assert.throws(() => validateEvidence({ ...evidence, schemaVersion: "2.0.0" }), { code: "UNSUPPORTED_ENRICHMENT_VERSION" });
});

test("result rows require valid identities, canonical names, and known reasons", () => {
  const credit = { name: "Alpha", joinPhrase: "", artistMbid: A1, artistName: "Alpha" };
  const invalidCredits = [
    [],
    [{ ...credit, artistName: undefined }],
    [{ ...credit, artistName: "" }],
    [{ ...credit, artistName: "bad\nname" }],
    [{ ...credit, artistName: "x".repeat(501) }],
    [{ ...credit, artistName: "  Alpha" }],
    [{ ...credit, artistMbid: A1.toUpperCase() }],
    [{ ...credit, artistMbid: "missing" }],
    [{ ...credit, name: "Alpha  Beta" }],
    [{ ...credit, name: "" }],
    [{ ...credit, joinPhrase: "  &  " }],
    Array.from({ length: 65 }, () => credit),
  ];
  for (const credits of invalidCredits) {
    assert.throws(() => build([{ ...resolved(RG1, credits) }]), { code: "INVALID_ENRICHMENT_EVIDENCE" }, JSON.stringify(credits).slice(0, 120));
  }
  // Legacy join phrases keep their surrounding spaces exactly as the importer stores them.
  assert.equal(build([resolved(RG1, [{ ...credit, joinPhrase: " feat. " }, { ...credit, artistMbid: A2 }])]).counts.resolved, 1);
  assert.throws(() => build([unresolved(RG2, { reason: "GUESSED" })]), { code: "INVALID_ENRICHMENT_EVIDENCE" });
  assert.throws(() => build([unresolved(RG2, { destinationReleaseGroupMbid: RG1 })]), { code: "INVALID_ENRICHMENT_EVIDENCE" });
  assert.equal(build([unresolved(RG2, { reason: "REDIRECTED", httpStatus: 301, destinationReleaseGroupMbid: RG1 })]).counts.unresolved, 1);
  assert.throws(() => build([unresolved(RG2, { reason: "REDIRECTED", destinationReleaseGroupMbid: RG2 })]), { code: "INVALID_ENRICHMENT_EVIDENCE" });
  assert.throws(() => build([{ ...deferred(), attempts: 4 }]), { code: "INVALID_ENRICHMENT_EVIDENCE" });
  assert.throws(() => build([{ ...deferred(), lastFailure: "oops" }]), { code: "INVALID_ENRICHMENT_EVIDENCE" });
  assert.throws(() => build([{ ...resolved(), status: "maybe" }]), { code: "INVALID_ENRICHMENT_EVIDENCE" });
});

test("publication is atomic, private, and never overwrites", (context) => {
  const directory = tempDir(context);
  const evidence = build();
  const target = path.join(directory, "nested", "evidence.json");
  assert.equal(publishEvidence(target, evidence), target);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  const read = readEvidenceFile(target);
  assert.deepEqual(read.evidence, evidence);
  assert.match(read.sha256, /^[0-9a-f]{64}$/);
  assert.throws(() => publishEvidence(target, build([resolved()])), { code: "ARTIFACT_EXISTS" });
  assert.deepEqual(readEvidenceFile(target).evidence, evidence);
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ["evidence.json"]);
  assert.throws(() => publishEvidence(path.join(directory, "bad.json"), resealed(evidence, (copy) => { copy.counts = {}; })), { code: "INVALID_ENRICHMENT_EVIDENCE" });
  assert.equal(fs.existsSync(path.join(directory, "bad.json")), false);
});

test("a destination created during publication is not replaced and no temporary file remains", (context) => {
  const directory = tempDir(context);
  const target = path.join(directory, "evidence.json");
  const racing = {
    ...fs,
    linkSync(from, to) {
      fs.writeFileSync(to, "someone else's file");
      return fs.linkSync(from, to);
    },
  };
  assert.throws(() => publishEvidence(target, build(), { fileSystem: racing }), { code: "ARTIFACT_EXISTS" });
  assert.equal(fs.readFileSync(target, "utf8"), "someone else's file");
  assert.deepEqual(fs.readdirSync(directory), ["evidence.json"]);
});

test("an interrupted write leaves no published artifact", (context) => {
  const directory = tempDir(context);
  const target = path.join(directory, "evidence.json");
  const failing = { ...fs, writeFileSync() { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); } };
  assert.throws(() => publishEvidence(target, build(), { fileSystem: failing }), /disk full/);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test("the evidence file reader rejects corrupt and oversized artifacts", (context) => {
  const directory = tempDir(context);
  const file = path.join(directory, "evidence.json");
  fs.writeFileSync(file, "{");
  assert.throws(() => readEvidenceFile(file), { code: "INVALID_ENRICHMENT_EVIDENCE" });
  fs.writeFileSync(file, JSON.stringify({ ...build(), results: [] }));
  assert.throws(() => readEvidenceFile(file), { code: "ENRICHMENT_CHECKSUM_MISMATCH" });
});

test("the catalog importer rejects enrichment evidence", (context) => {
  const directory = tempDir(context);
  const target = publishEvidence(path.join(directory, "evidence.json"), build());
  assert.throws(() => readDatasetFile(target), (error) => error.code === "UNSUPPORTED_ARTIFACT" && /catalog:backfill-artists -- --enrichment/.test(error.message));
  assert.throws(() => validateDatasetObject(build()), { code: "UNSUPPORTED_ARTIFACT" });
});
