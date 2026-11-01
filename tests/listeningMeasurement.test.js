const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const {
  assertAggregateOnly, cohortWindows, createBudget, followUpStatus, manifestTemplate, partition, ratio, validateManifest, BudgetExceeded, ManifestError,
} = require("../lib/listening/measurement");
const { rediscoveryMatches, rediscoveryPairs } = require("../lib/listening/worker");
const { collectMeasurement, jobState, parseArgs } = require("../scripts/listeningMeasurement");

const DAY = 86_400_000;
const T = "2026-11-03T00:00:00Z";

function manifest(overrides = {}) {
  return {
    ...manifestTemplate(),
    environment: "fixture",
    sourceCommit: "d61e508",
    exposures: { pr32: { activatedAt: T, rollbackAt: null, verification: "deploy log reviewed" }, pr33: { activatedAt: null, rollbackAt: null, verification: "" } },
    flags: { LASTFM_DISCOVERY_ENABLED: true },
    allowlistScopeVersion: "v1",
    windows: { intakeDays: 14, followUpDays: 7, snapshotTimeUtc: "06:00" },
    collection: { startAt: T, endAt: "2026-11-24T00:00:00Z" },
    ...overrides,
  };
}

test("manifest validation rejects placeholders, unknown fields, credentials and impossible exposure clocks", () => {
  assert.throws(() => validateManifest(manifestTemplate()), (error) => error instanceof ManifestError && error.problems.some((problem) => problem.startsWith("environment")));
  assert.equal(validateManifest(manifest()).parsed.exposures.pr32.activatedAt.toISOString(), "2026-11-03T00:00:00.000Z");
  assert.equal(validateManifest(manifest({ windows: null })).windows, null, "windows may stay unconfirmed");
  const invalid = [
    manifest({ extra: true }),
    manifest({ targetVerification: "mongodb+srv://reader:secret@cluster.example/db" }),
    manifest({ evidence: { location: "https://user:pass@host/x", checksum: null } }),
    manifest({ exposures: { pr32: { activatedAt: T, rollbackAt: "2026-11-02T00:00:00Z", verification: "log" }, pr33: { activatedAt: null, rollbackAt: null, verification: "" } } }),
    manifest({ exposures: { pr32: { activatedAt: T, rollbackAt: null, verification: "" }, pr33: { activatedAt: null, rollbackAt: null, verification: "" } } }),
    manifest({ exposures: { pr32: { activatedAt: "2026-11-03", rollbackAt: null, verification: "log" }, pr33: { activatedAt: null, rollbackAt: null, verification: "" } } }),
    manifest({ windows: { intakeDays: 0, followUpDays: 7, snapshotTimeUtc: "06:00" } }),
    manifest({ windows: { intakeDays: 14, followUpDays: 7, snapshotTimeUtc: "6am" } }),
    manifest({ flags: { lowercase: true } }),
    manifest({ sourceCommit: "main" }),
    manifest({ schemaVersion: 2 }),
    manifest({ collection: { startAt: "2026-02-31T00:00:00Z", endAt: null } }),
    manifest({ exposures: { pr32: { activatedAt: "2026-11-31T00:00Z", rollbackAt: null, verification: "log" }, pr33: { activatedAt: null, rollbackAt: null, verification: "" } } }),
  ];
  for (const value of invalid) assert.throws(() => validateManifest(value), ManifestError);
  // Printed problems never repeat credential-like keys.
  for (const value of [manifest({ flags: { "mongodb://reader:hunter2@db.example": true } }), { ...manifest(), "mongodb://reader:hunter2@db.example": 1 }]) {
    assert.throws(() => validateManifest(value), (error) => error instanceof ManifestError && !error.message.includes("hunter2") && error.message.includes("<unrecognized key>"));
  }
});

test("cohort windows are half-open around verified activation and never assume unverified exposure", () => {
  const exposure = { activatedAt: new Date(T), rollbackAt: null };
  const windows = { intakeDays: 14, followUpDays: 7, snapshotTimeUtc: "06:00" };
  const at = Date.parse(T);
  const result = cohortWindows(exposure, windows, new Date(at + 21 * DAY));
  assert.deepEqual(result.baselineIntake, { from: new Date(at - 14 * DAY).toISOString(), to: new Date(at).toISOString(), followUpCrossesActivation: true });
  assert.deepEqual(result.shiftedBaselineIntake, { from: new Date(at - 21 * DAY).toISOString(), to: new Date(at - 7 * DAY).toISOString() });
  assert.deepEqual(result.postIntake, { from: new Date(at).toISOString(), to: new Date(at + 14 * DAY).toISOString() });
  assert.equal(result.postFollowUpEnd, new Date(at + 21 * DAY).toISOString());
  assert.equal(result.followUpComplete, true);
  assert.equal(cohortWindows(exposure, windows, new Date(at + 20 * DAY)).followUpComplete, false);
  assert.equal(cohortWindows({ ...exposure, rollbackAt: new Date(at + 3 * DAY) }, windows, null).rollbackInsidePostWindow, true);
  assert.deepEqual(cohortWindows({ activatedAt: null }, windows, null), { status: "exposure_unverified", claim: "prospective_only" });
  assert.deepEqual(cohortWindows(exposure, null, null), { status: "windows_unconfirmed" });
});

test("metric shapes keep denominators, null empty rates and censor immature follow-up", () => {
  assert.deepEqual(ratio(0, 0, "case"), { unit: "case", numerator: 0, denominator: 0, value: null });
  assert.equal(ratio(1, 4, "pair").value, 0.25);
  assert.equal(partition({ a: 1, b: 2 }, 3).reconciles, true);
  assert.equal(partition({ a: 1, b: 1 }, 3).reconciles, false);
  const cutoff = new Date(T);
  assert.equal(followUpStatus(new Date(Date.parse(T) - 7 * DAY), cutoff, 7 * DAY), "mature");
  assert.equal(followUpStatus(new Date(Date.parse(T) - 6 * DAY), cutoff, 7 * DAY), "censored");
  assert.equal(followUpStatus(null, cutoff, 7 * DAY), "unknown_entry");
});

test("budgets stop on record or wall-time exhaustion", () => {
  const records = createBudget({ maxRecords: 3, wallMs: 1_000, clock: () => 0 });
  records.take(3);
  assert.throws(() => records.take(1), (error) => error instanceof BudgetExceeded && error.reason === "record_budget_exhausted");
  let now = 0;
  const wall = createBudget({ maxRecords: 100, wallMs: 10, clock: () => now });
  now = 11;
  assert.throws(() => wall.check(), (error) => error.reason === "wall_time_budget_exhausted");
});

test("the output guard rejects record identifiers but allows revisions and checksums", () => {
  assert.doesNotThrow(() => assertAggregateOnly({ manifest: { sourceCommit: "a".repeat(40), checksum: "b".repeat(64) }, count: 3 }));
  assert.throws(() => assertAggregateOnly({ label: String(new mongoose.Types.ObjectId()) }), /IDENTIFIER/);
  assert.throws(() => assertAggregateOnly({ nested: [{ id: crypto.randomUUID() }] }), /IDENTIFIER/);
  assert.throws(() => assertAggregateOnly({ name: "Secret Album" }, ["Secret Album"]), /IDENTIFIER/);
});

test("rediscovery pairs list every matched album while the scheduler keeps the newest per case", () => {
  const cases = [{ caseId: "c1", artistKey: "artist", album: "Album (Deluxe Edition)", albumKey: "album (deluxe edition)", listenerCount: 1 }];
  const albums = [
    { title: "Album", artists: ["Artist"], createdAt: new Date(1) },
    { title: "Album (Deluxe Edition)", artists: ["Other", "Artist"], createdAt: new Date(2) },
    { title: "Album", artists: ["Someone Else"], createdAt: new Date(3) },
  ];
  assert.equal(rediscoveryPairs(cases, albums).length, 2);
  assert.deepEqual(rediscoveryMatches(cases, albums).map(({ albumCreatedAt }) => +albumCreatedAt), [2]);
});

test("arguments and job states are validated", () => {
  assert.deepEqual(parseArgs(["--template"]), { template: true });
  assert.deepEqual(parseArgs(["--manifest", "m.json", "--validate-only"]), { manifest: "m.json", validateOnly: true });
  for (const argv of [[], ["--manifest"], ["--manifest", "--validate-only"], ["--validate-only"], ["--manifest", "a", "--manifest", "b"], ["--template", "--manifest", "a"]]) {
    assert.throws(() => parseArgs(argv), /Usage/);
  }
  assert.equal(jobState(undefined), "notEnqueued");
  assert.equal(jobState({ status: "pending", attempts: 0 }), "queued");
  assert.equal(jobState({ status: "pending", attempts: 2, error: "x" }), "retrying");
  assert.equal(jobState({ status: "running", attempts: 1 }), "running");
  assert.equal(jobState({ status: "done", error: "" }), "doneWithoutError");
  assert.equal(jobState({ status: "done", error: "discovery_incomplete" }), "terminalError");
});

// In-memory models supporting the operators and query chain the collector uses.
function model(rows) {
  const value = (x) => x?._bsontype === "ObjectId" ? String(x) : x;
  const get = (row, key) => key.split(".").reduce((entry, part) => Array.isArray(entry) ? entry.map((item) => item?.[part]) : entry?.[part], row);
  const matches = (row, filter) => Object.entries(filter).every(([key, expected]) => {
    const actual = value(get(row, key));
    if (expected && typeof expected === "object" && !(expected instanceof Date) && !expected._bsontype) {
      return Object.entries(expected).every(([operator, target]) => {
        if (operator === "$in") return target.some((item) => value(item) === actual);
        if (operator === "$gt") return actual > value(target);
        if (operator === "$ne") return actual !== target;
        if (operator === "$exists") return (actual !== undefined) === target;
        throw new Error(`Unsupported test operator ${operator}`);
      });
    }
    return actual === value(expected);
  });
  const calls = [];
  return {
    calls,
    find(filter) {
      calls.push(filter);
      let selected = rows.filter((row) => matches(row, filter)); let limit = Infinity;
      const chain = {
        select() { return chain; },
        sort(order) { const [[key, direction]] = Object.entries(order); selected = [...selected].sort((a, b) => (String(value(a[key])) < String(value(b[key])) ? -1 : 1) * direction); return chain; },
        limit(count) { limit = count; return chain; },
        maxTimeMS(ms) { assert.equal(ms, 5_000); return chain; },
        lean: async () => selected.slice(0, limit),
      };
      return chain;
    },
  };
}

function world() {
  const oid = () => new mongoose.Types.ObjectId();
  const albums = [
    { _id: oid(), albumId: crypto.randomUUID(), title: "First", artistDisplayName: "Artist", artistCredits: [], catalogRevision: 1 },
    { _id: oid(), albumId: crypto.randomUUID(), title: "Second", artistDisplayName: "Artist", artistCredits: [], catalogRevision: 2 },
    { _id: oid(), albumId: crypto.randomUUID(), title: "Third", artistDisplayName: "Band", artistCredits: [{ name: "Guest" }], catalogRevision: 1 },
    { _id: oid(), albumId: crypto.randomUUID(), title: "Fourth", artistDisplayName: "Band", artistCredits: [], catalogRevision: 1 },
    { _id: oid(), albumId: crypto.randomUUID(), title: "Unwanted", artistDisplayName: "Nobody", artistCredits: [], catalogRevision: 1 },
  ];
  const [first, second, third, fourth] = albums;
  const discovery = (fields) => [{ source: "candidate_discovery", candidateQueryLimitReached: false, candidatesFound: 1, candidatesShown: 1, ...fields }];
  const mappingCase = (fields) => ({ _id: oid(), caseId: crypto.randomUUID(), status: "pending", listenerCount: 1, candidates: [], evidence: discovery({}), discoveryError: "", ...fields });
  const cases = [
    // Usable candidate already present, job done.
    mappingCase({ artistKey: "artist", album: "First", albumKey: "first", candidates: [{ albumId: first.albumId, catalogRevision: 1 }] }),
    // Edition-label match, candidate bound to an old revision, never enqueued. Cap reached.
    mappingCase({ artistKey: "artist", album: "Second (Deluxe Edition)", albumKey: "second (deluxe edition)", candidates: [{ albumId: second.albumId, catalogRevision: 1 }], evidence: discovery({ candidateQueryLimitReached: true, candidatesFound: 7, candidatesShown: 5 }) }),
    // Credited artist match; no candidate; retrying after a provider failure; legacy evidence.
    mappingCase({ artistKey: "guest", album: "Third", albumKey: "third", discoveryError: "provider_evidence_incomplete", evidence: [{ source: "candidate_discovery" }] }),
    // A first discovery that failed stores no evidence: a failure without a result, not unknown.
    mappingCase({ artistKey: "nobody-new", album: "New", albumKey: "new", evidence: [], discoveryError: "lastfm_timeout" }),
    // The worker's failure path replaces the stored reason with the job code.
    mappingCase({ artistKey: "nobody-else", album: "Gone", albumKey: "gone", discoveryError: "discovery_incomplete" }),
    // Closed as no match, terminal job.
    mappingCase({ status: "no_catalog_match", artistKey: "band", album: "Fourth", albumKey: "fourth" }),
    // Approved cases are not eligible; their old job is a competing exit.
    mappingCase({ status: "approved", artistKey: "band", album: "Third", albumKey: "third" }),
  ];
  const job = (row, album, fields) => ({ _id: oid(), key: `discovery:catalog:${row.caseId}:${album._id}`, type: "discovery", payload: { caseId: row.caseId, catalogAlbumId: String(album._id) }, status: "done", attempts: 1, error: "", ...fields });
  const jobs = [
    job(cases[0], first, {}),
    job(cases[2], third, { status: "pending", attempts: 2, error: "lastfm_timeout" }),
    job(cases[5], fourth, { error: "discovery_incomplete" }),
    job(cases[6], third, {}),
    { _id: oid(), key: "sync:x", type: "sync", payload: {}, status: "done", attempts: 1, error: "" },
  ];
  const connectionId = oid();
  const mappings = [
    { key: JSON.stringify(["lastfm", "artist", "first"]), albumId: first.albumId, catalogRevision: 1, status: "active" },
    { key: JSON.stringify(["lastfm", "artist", "second"]), albumId: second.albumId, catalogRevision: 1, status: "active" },
    { key: JSON.stringify(["lastfm", "band", "fourth"]), albumId: fourth.albumId, catalogRevision: 1, status: "active" },
    { key: JSON.stringify(["lastfm", "band", "third"]), albumId: third.albumId, catalogRevision: 1, status: "active" },
  ];
  const names = [["artist", "first"], ["artist", "second"], ["band", "fourth"], ["band", "third"], ["band", "unmapped"]].map(([artist, album]) => ({ _id: { artist, album } }));
  const statuses = new Map([
    [first.albumId, { id: first.albumId, status: "reviewed", readyForReview: false, usableBaseline: true, inBaselineQueue: true }],
    [fourth.albumId, { id: fourth.albumId, status: "pending", readyForReview: true, usableBaseline: false, inBaselineQueue: true }],
    [third.albumId, { id: third.albumId, status: "pending", readyForReview: false, usableBaseline: false, inBaselineQueue: false }],
  ]);
  return {
    albums, cases, jobs,
    models: {
      AlbumCatalog: model(albums),
      Listening: {
        MappingCase: model(cases), Job: model(jobs), AlbumMapping: model(mappings),
        Connection: model([{ _id: connectionId, state: "active" }]),
        Scrobble: { aggregate: (pipeline) => ({ option: async (options) => { assert.deepEqual(options, { maxTimeMS: 5_000, allowDiskUse: false }); assert.ok(pipeline[0].$match.expiresAt.$gt instanceof Date); assert.ok(pipeline.at(-1).$limit > 0); return names; } }) },
      },
      reviewStatusForAlbums: async (ids, options) => { assert.equal(options.maxTimeMS, 5_000); return ids.map((id) => statuses.get(id)).filter(Boolean); },
    },
  };
}

const NOW = new Date("2026-11-10T06:00:00Z");

test("the collector reports the eligible pair census, evidence reasons and demand readiness without identifiers", async () => {
  const { models, albums, cases } = world();
  const limits = { pageSize: 2, maxRecords: 10_000, maxTimeMS: 5_000, wallMs: 60_000 };
  const report = await collectMeasurement({ manifest: manifest(), checksum: "c".repeat(64), now: NOW, clock: () => 0, limits, ...models });

  const census = report.rediscoveryCensus;
  assert.equal(census.albumsScanned, 5, "pages traverse the whole catalog beyond one page");
  assert.equal(census.pairs, 4);
  assert.equal(census.distinctCases, 4);
  assert.deepEqual(census.jobState, { notEnqueued: 1, queued: 0, retrying: 1, running: 0, doneWithoutError: 1, terminalError: 1, total: 4, reconciles: true });
  assert.deepEqual(census.matchingCandidate, { usable: 1, presentNotUsable: 1, absent: 2, total: 4, reconciles: true });
  assert.equal(census.notEnqueuedWithoutUsableCandidate, 1);
  assert.deepEqual(census.casesWithUsableMatchingCandidate, { unit: "case", numerator: 1, denominator: 4, value: 0.25 });
  assert.deepEqual(census.outsideCohort.exits, { caseApproved: 1, caseRejected: 0, caseMissing: 0, albumMissing: 0, noLongerMatching: 0, total: 1, reconciles: true });

  const evidence = report.mappingEvidence;
  assert.equal(evidence.cases, 5);
  assert.deepEqual(evidence.coverageFieldsKnown, { unit: "case", numerator: 3, denominator: 5, value: 3 / 5 });
  assert.equal(evidence.failedWithoutResult, 1);
  assert.equal(evidence.unknownCoverage, 1, "legacy evidence without coverage fields is unknown, not complete");
  assert.deepEqual(evidence.reasonsAmongKnown, { providerIncomplete: 1, otherDiscoveryFailure: 0, retainedAfterFailedRefresh: 0, queryCapReached: 1, candidateCapReached: 1, staleCandidateRevision: 1 });
  assert.deepEqual(evidence.problemRate, { unit: "case", numerator: 2, denominator: 3, value: 2 / 3 });

  const readiness = report.demandReadiness;
  assert.deepEqual(readiness.names, {
    unit: "distinct normalized name in unexpired evidence of active connections",
    observed: 5, mapped: 3, mappedToStaleOrMissingAlbum: 1, unmapped: 1, withUsableBaseline: 1,
    mappingCoverage: { unit: "name", numerator: 3, denominator: 5, value: 0.6 },
    baselineReadiness: { unit: "name", numerator: 1, denominator: 3, value: 1 / 3 },
    mappedWithoutBaseline: 2,
  });
  assert.deepEqual(readiness.albums.status, { readyPending: 1, unpreparedPending: 1, reviewed: 1, stale: 0, deferred: 0, revoked: 0, unknown: 0, total: 3, reconciles: true });
  assert.equal(readiness.albums.outsideBaselineQueue, 1);

  assert.equal(report.collection.complete, true);
  assert.equal(report.cohortWindows.pr32.status, "defined");
  assert.equal(report.cohortWindows.pr32.followUpComplete, false, "a snapshot before the planned end has not observed the follow-up");
  assert.equal(report.cohortWindows.pr33.claim, "prospective_only");
  assert.equal(report.baselineRecommendations.collected, false);
  const serialized = JSON.stringify(report);
  for (const secret of [...albums.flatMap((album) => [album.albumId, String(album._id), album.title]), ...cases.map((row) => row.caseId)]) {
    assert.equal(serialized.includes(secret), false, `report leaks ${secret}`);
  }
});

test("an empty database reports zero counts and null rates", async () => {
  const empty = {
    AlbumCatalog: model([]),
    Listening: { MappingCase: model([]), Job: model([]), AlbumMapping: model([]), Connection: model([]), Scrobble: { aggregate: () => { throw new Error("not called without connections"); } } },
    reviewStatusForAlbums: async () => [],
  };
  const report = await collectMeasurement({ manifest: manifest({ windows: null }), now: NOW, clock: () => 0, ...empty });
  assert.equal(report.rediscoveryCensus.pairs, 0);
  assert.equal(report.rediscoveryCensus.casesWithUsableMatchingCandidate.value, null);
  assert.equal(report.mappingEvidence.problemRate.value, null);
  assert.equal(report.demandReadiness.names.mappingCoverage.value, null);
  assert.equal(report.demandReadiness.albums.status.reconciles, true);
  assert.deepEqual(report.cohortWindows.pr32, { status: "windows_unconfirmed" });
});

test("an exhausted budget marks the section and every later one as not collected", async () => {
  const { models } = world();
  const limits = { pageSize: 2, maxRecords: 8, maxTimeMS: 5_000, wallMs: 60_000 };
  const report = await collectMeasurement({ manifest: manifest(), now: NOW, clock: () => 0, limits, ...models });
  assert.equal(report.collection.complete, false);
  assert.equal(report.collection.stopReason, "record_budget_exhausted");
  const sections = ["mappingEvidence", "demandReadiness", "rediscoveryCensus"].map((name) => report[name]);
  const stopped = sections.findIndex((section) => !section.collected);
  assert.ok(stopped >= 0);
  assert.deepEqual(sections[stopped], { collected: false, reason: "record_budget_exhausted" });
  for (const section of sections.slice(stopped + 1)) assert.deepEqual(section, { collected: false, reason: "collection_stopped" });

  const timeout = world().models;
  timeout.Listening.MappingCase = { find() { const error = new Error("operation exceeded time limit"); error.code = 50; throw error; } };
  const timed = await collectMeasurement({ manifest: manifest(), now: NOW, clock: () => 0, ...timeout });
  assert.deepEqual(timed.mappingEvidence, { collected: false, reason: "query_time_budget_exhausted" });
  assert.equal(timed.collection.stopReason, "query_time_budget_exhausted");

  const memory = world().models;
  memory.Listening.Scrobble = { aggregate: () => ({ option: async () => { const error = new Error("memory limit"); error.code = 292; throw error; } }) };
  const spilled = await collectMeasurement({ manifest: manifest(), now: NOW, clock: () => 0, ...memory });
  assert.equal(spilled.mappingEvidence.collected, true, "earlier sections survive");
  assert.deepEqual(spilled.demandReadiness, { collected: false, reason: "query_memory_budget_exhausted" });
});

test("an invalid manifest stops collection before any query", async () => {
  const { models } = world();
  await assert.rejects(collectMeasurement({ manifest: manifestTemplate(), now: NOW, ...models }), ManifestError);
  assert.equal(models.Listening.MappingCase.calls.length, 0);
});
