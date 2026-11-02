const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const {
  assertAggregateOnly, createBudget, disabledIntervals, followUpStatus, manifestTemplate, partition, prospectiveIntake, ratio, validateManifest, BudgetExceeded, ManifestError,
} = require("../lib/listening/measurement");
const { attemptJobKey, rediscoveryMatches, rediscoveryPairs } = require("../lib/listening/worker");
const { collectMeasurement, jobState, parseArgs } = require("../scripts/listeningMeasurement");

const DAY = 86_400_000;
const T = "2026-11-03T00:00:00Z";

const off = () => ({ activatedAt: null, deployedRevision: null, rollbackAt: null, verification: "" });
const exposuresWith = (fields = {}) => ({ observations: off(), reviewEpisodes: off(), effortTimer: off(), ...fields });

function manifest(overrides = {}) {
  return {
    ...manifestTemplate(),
    environment: "fixture",
    sourceCommit: "d61e508",
    exposures: exposuresWith({ reviewEpisodes: { activatedAt: T, deployedRevision: "7b6a247", rollbackAt: null, verification: "recorded at deploy" } }),
    windows: { intakeDays: 14, followUpDays: 7, snapshotTimeUtc: "06:00" },
    collection: { startAt: T, endAt: "2026-11-24T00:00:00Z" },
    ...overrides,
  };
}

test("manifest validation rejects placeholders, unknown fields, credentials and impossible exposure clocks", () => {
  assert.throws(() => validateManifest(manifestTemplate()), (error) => error instanceof ManifestError && error.problems.some((problem) => problem.startsWith("environment")));
  assert.equal(validateManifest(manifest()).parsed.exposures.reviewEpisodes.activatedAt.toISOString(), "2026-11-03T00:00:00.000Z");
  assert.deepEqual(manifestTemplate().windows, { intakeDays: 14, followUpDays: 7, snapshotTimeUtc: "06:00" }, "the template carries the confirmed windows");
  assert.deepEqual(Object.keys(manifestTemplate().exposures), ["observations", "reviewEpisodes", "effortTimer"], "exposures are prospective; no historical PR32/PR33 activation is asked for");
  const entry = (fields) => exposuresWith({ reviewEpisodes: { ...off(), ...fields } });
  const valid = validateManifest(manifest({
    flagChanges: [{ flag: "REVIEW_EPISODES_ENABLED", enabled: false, at: "2026-11-05T00:00:00Z", note: "paused" }, { flag: "REVIEW_EPISODES_ENABLED", enabled: true, at: "2026-11-06T00:00:00Z" }],
    allowlistChanges: [{ change: "added", count: 2, at: "2026-11-04T00:00:00Z" }],
  }));
  assert.equal(valid.parsed.flagChanges.length, 2);
  assert.equal(valid.parsed.allowlistChanges[0].at.toISOString(), "2026-11-04T00:00:00.000Z");
  const invalid = [
    manifest({ extra: true }),
    manifest({ targetVerification: "mongodb+srv://reader:secret@cluster.example/db" }),
    manifest({ evidence: { location: "https://user:pass@host/x", checksum: null } }),
    manifest({ exposures: entry({ activatedAt: T, rollbackAt: "2026-11-02T00:00:00Z", verification: "log" }) }),
    manifest({ exposures: entry({ activatedAt: T, verification: "" }) }),
    manifest({ exposures: entry({ activatedAt: "2026-11-03", verification: "log" }) }),
    manifest({ exposures: entry({ activatedAt: T, deployedRevision: "main", verification: "log" }) }),
    manifest({ exposures: { ...exposuresWith(), pr33: off() } }),
    manifest({ exposures: { observations: off(), reviewEpisodes: off() } }),
    manifest({ windows: { intakeDays: 0, followUpDays: 7, snapshotTimeUtc: "06:00" } }),
    manifest({ windows: { intakeDays: 14, followUpDays: 7, snapshotTimeUtc: "6am" } }),
    manifest({ windows: { intakeDays: 7, followUpDays: 7, snapshotTimeUtc: "06:00" } }),
    manifest({ windows: { intakeDays: 14, followUpDays: 7, snapshotTimeUtc: "00:00" } }),
    manifest({ windows: null }),
    manifest({ flags: { REVIEW_EPISODES_ENABLED: true } }),
    manifest({ flagChanges: [{ flag: "lowercase", enabled: true, at: T }] }),
    manifest({ flagChanges: [{ flag: "REVIEW_EPISODE_ENABLED", enabled: false, at: "2026-11-05T00:00:00Z" }] }),
    manifest({ flagChanges: [{ flag: "REVIEW_EPISODES_ENABLED", enabled: false, at: "2026-11-02T00:00:00Z" }] }),
    manifest({ flagChanges: [{ flag: "REVIEW_EFFORT_TIMER_ENABLED", enabled: true, at: "2026-11-05T00:00:00Z" }] }),
    manifest({ flagChanges: [{ flag: "REVIEW_EPISODES_ENABLED", enabled: "yes", at: T }] }),
    manifest({ flagChanges: [{ flag: "A_FLAG", enabled: true, at: "2026-11-05T00:00:00Z" }, { flag: "A_FLAG", enabled: false, at: T }] }),
    manifest({ allowlistChanges: [{ change: "grew", count: 1, at: T }] }),
    manifest({ allowlistChanges: [{ change: "added", count: -1, at: T }] }),
    manifest({ allowlistChanges: {} }),
    manifest({ sourceCommit: "main" }),
    manifest({ schemaVersion: 2 }),
    manifest({ collection: { startAt: "2026-02-31T00:00:00Z", endAt: null } }),
    manifest({ exposures: entry({ activatedAt: "2026-11-31T00:00Z", verification: "log" }) }),
  ];
  for (const value of invalid) assert.throws(() => validateManifest(value), ManifestError);
  // Printed problems never repeat credential-like keys.
  for (const value of [manifest({ flagChanges: [{ flag: "A_FLAG", enabled: true, at: T, "mongodb://reader:hunter2@db.example": true }] }), { ...manifest(), "mongodb://reader:hunter2@db.example": 1 }]) {
    assert.throws(() => validateManifest(value), (error) => error instanceof ManifestError && !error.message.includes("hunter2") && error.message.includes("<unrecognized key>"));
  }
});

test("intakes start at a recorded activation, never assume an unrecorded one, and stop at a rollback", () => {
  const windows = { intakeDays: 14, followUpDays: 7, snapshotTimeUtc: "06:00" };
  const at = Date.parse(T);
  const exposure = { activatedAt: new Date(T), rollbackAt: null };
  const intake = prospectiveIntake(exposure, windows, new Date(at + 21 * DAY));
  assert.equal(intake.status, "defined");
  assert.equal(+intake.from, at);
  assert.equal(+intake.to, at + 14 * DAY);
  assert.equal(+intake.followUpEnd, at + 21 * DAY);
  assert.equal(intake.followUpComplete, true);
  assert.equal(prospectiveIntake(exposure, windows, new Date(at + 20 * DAY)).followUpComplete, false);
  assert.deepEqual(prospectiveIntake({ activatedAt: null }, windows, null), { status: "activation_not_recorded" });
  assert.deepEqual(prospectiveIntake(exposure, null, null), { status: "windows_unconfirmed" });
  assert.deepEqual(prospectiveIntake({ ...exposure, rollbackAt: new Date(at + 20 * DAY) }, windows, null), { status: "rolled_back_before_follow_up_end" });
  assert.equal(prospectiveIntake({ ...exposure, rollbackAt: new Date(at + 22 * DAY) }, windows, null).status, "defined");
  // Sections that only count the intake are complete once the intake ends.
  assert.equal(prospectiveIntake({ ...exposure, rollbackAt: new Date(at + 20 * DAY) }, windows, null, { followUp: false }).status, "defined");
  assert.deepEqual(prospectiveIntake({ ...exposure, rollbackAt: new Date(at + 10 * DAY) }, windows, null, { followUp: false }), { status: "rolled_back_during_intake" });

  const change = (enabled, day, flag = "REVIEW_EPISODES_ENABLED") => ({ flag, enabled, at: new Date(at + day * DAY) });
  const changes = [change(false, 2), change(true, 3), change(false, 5, "OTHER_FLAG"), change(false, 10)];
  assert.deepEqual(disabledIntervals(changes, "REVIEW_EPISODES_ENABLED", new Date(at), new Date(at + 14 * DAY)).map(({ from, to }) => [(from - at) / DAY, (to - at) / DAY]), [[2, 3], [10, 14]]);
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
        if (operator === "$gte") return actual >= value(target);
        if (operator === "$lt") return actual < value(target);
        if (operator === "$lte") return actual <= value(target);
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
        MappingCase: model(cases), Job: model(jobs), AlbumMapping: model(mappings), DiscoveryAttempt: model([]), MappingAudit: model([]),
        Connection: model([{ _id: connectionId, state: "active" }]),
        Scrobble: { aggregate: (pipeline) => ({ option: async (options) => { assert.deepEqual(options, { maxTimeMS: 5_000, allowDiskUse: false }); assert.ok(pipeline[0].$match.expiresAt.$gt instanceof Date); assert.ok(pipeline.at(-1).$limit > 0); return names; } }) },
      },
      reviewStatusForAlbums: async (ids, options) => { assert.equal(options.maxTimeMS, 5_000); return ids.map((id) => statuses.get(id)).filter(Boolean); },
      ...observationModels(),
    },
  };
}

// Empty review-observation collections; tests that exercise them pass rows.
function observationModels({ baselineAudits = [], episodes = [], runs = [], efforts = [] } = {}) {
  return {
    Baselines: { Audit: model(baselineAudits) },
    ReviewObservation: { Episode: model(episodes), RecommendationRun: model(runs), Effort: model(efforts) },
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
  assert.equal(report.intakes.reviewEpisodes.status, "defined");
  assert.equal(report.intakes.reviewEpisodes.followUpComplete, false, "a snapshot before the planned end has not observed the follow-up");
  assert.deepEqual(report.intakes.observations, { status: "activation_not_recorded" });
  assert.equal(report.before.reference, "docs/QUEUE_METRICS_2026-11-01.md");
  assert.equal(report.reviewEpisodes.collected, true);
  assert.equal(report.adjudication.collected, false);
  const serialized = JSON.stringify(report);
  for (const secret of [...albums.flatMap((album) => [album.albumId, String(album._id), album.title]), ...cases.map((row) => row.caseId)]) {
    assert.equal(serialized.includes(secret), false, `report leaks ${secret}`);
  }
});

test("an empty database reports zero counts and null rates", async () => {
  const empty = {
    AlbumCatalog: model([]),
    Listening: { MappingCase: model([]), Job: model([]), AlbumMapping: model([]), DiscoveryAttempt: model([]), MappingAudit: model([]), Connection: model([]), Scrobble: { aggregate: () => { throw new Error("not called without connections"); } } },
    reviewStatusForAlbums: async () => [],
    ...observationModels(),
  };
  const report = await collectMeasurement({ manifest: manifest(), now: NOW, clock: () => 0, ...empty });
  assert.equal(report.rediscoveryCensus.pairs, 0);
  assert.equal(report.rediscoveryCensus.casesWithUsableMatchingCandidate.value, null);
  assert.equal(report.mappingEvidence.problemRate.value, null);
  assert.equal(report.demandReadiness.names.mappingCoverage.value, null);
  assert.equal(report.demandReadiness.albums.status.reconciles, true);
  assert.deepEqual(report.rediscoveryOutcomes, { collected: false, reason: "activation_not_recorded" });
  assert.deepEqual(report.discoveryRuns, { collected: false, reason: "activation_not_recorded" });
  assert.equal(report.reviewEpisodes.mapping.episodeCoverage.value, null);
  assert.deepEqual(report.reviewEffort, { collected: false, reason: "activation_not_recorded" });
});

test("an exhausted budget marks the section and every later one as not collected", async () => {
  const { models } = world();
  const limits = { pageSize: 2, maxRecords: 8, maxTimeMS: 5_000, wallMs: 60_000 };
  const report = await collectMeasurement({ manifest: manifest(), now: NOW, clock: () => 0, limits, ...models });
  assert.equal(report.collection.complete, false);
  assert.equal(report.collection.stopReason, "record_budget_exhausted");
  const sections = ["mappingEvidence", "demandReadiness", "rediscoveryCensus", "rediscoveryOutcomes", "discoveryRuns"].map((name) => report[name]);
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

function oidAt(date) {
  const id = new mongoose.Types.ObjectId();
  id.id.writeUInt32BE(Math.floor(new Date(date).getTime() / 1000), 0);
  return id;
}

function windowedWorld() {
  const at = (day, hours = 0) => new Date(Date.parse(`2026-11-${String(day).padStart(2, "0")}T00:00:00Z`) + hours * 3_600_000);
  const sweep = at(3);
  const jobs = []; const attempts = [];
  const pair = (day, fields = {}, observation = {}) => {
    fields = { attempts: 1, ...fields };
    const caseId = crypto.randomUUID(); const albumId = crypto.randomUUID(); const observedAt = at(day);
    const job = { _id: oidAt(observedAt), key: `discovery:catalog:${caseId}:${oidAt(observedAt)}`, type: "discovery", status: "done", error: "", payload: { caseId, catalogAlbumId: String(oidAt(observedAt)), observation: { version: 1, albumId, observedAt, scanMode: "recent", eligibleAfter: sweep, usableCandidateAtEntry: false, ...observation } }, ...fields };
    jobs.push(job); return job;
  };
  const attempt = (job, hours, fields = {}) => {
    const startedAt = new Date(+job.payload.observation.observedAt + hours * 3_600_000);
    const { completedAfterHours = 0, jobKey = job.key, ...rest } = fields;
    attempts.push({ _id: oidAt(startedAt), caseId: job.payload.caseId, jobKeyHash: attemptJobKey(jobKey), trigger: "catalog", outcome: "committed", providerComplete: true, queryCapReached: false, candidateCapReached: false, candidatesAfter: [], pairCandidateBefore: false, startedAt, completedAt: new Date(+startedAt + completedAfterHours * 3_600_000), ...rest });
  };
  const found = (job) => [{ albumId: job.payload.observation.albumId }];
  const p1 = pair(4); attempt(p1, 1, { candidatesAfter: found(p1), queryCapReached: true });
  const p2 = pair(5); attempt(p2, 2, { jobKey: `discovery:${p2.payload.caseId}`, trigger: "moderator_refresh", candidatesAfter: found(p2) }); attempt(p2, 24, { candidatesAfter: found(p2), pairCandidateBefore: true });
  const p3 = pair(5, { error: "lastfm_timeout" }, { usableCandidateAtEntry: true }); attempt(p3, 1, { outcome: "failed", providerComplete: null, queryCapReached: null }); attempt(p3, 2, { outcome: "failed", providerComplete: null, queryCapReached: null });
  const p4 = pair(6, { status: "pending", error: "discovery_incomplete" }); attempt(p4, 0.5, { outcome: "conflict", queryCapReached: null }); attempt(p4, 1, { providerComplete: false, candidatesAfter: found(p4) });
  pair(7, { status: "pending", attempts: 0 }, { eligibleAfter: null });
  const p6 = pair(8); attempt(p6, 1, { outcome: "skipped", providerComplete: null, queryCapReached: null });
  // Started before the follow-up ended but committed after it: not a gain by H.
  const p9 = pair(9); attempt(p9, 167.9, { completedAfterHours: 0.5 });
  // Leased twice with no record: an execution the observation records missed.
  pair(10, { status: "pending", attempts: 2 });
  pair(15, { status: "pending" });
  pair(18, { status: "pending" });
  return { jobs, attempts };
}

test("windowed rediscovery outcomes credit gains carefully and keep every pair in the denominator", async () => {
  const { jobs, attempts } = windowedWorld();
  const exposures = exposuresWith({ observations: { activatedAt: "2026-11-03T00:00:00Z", deployedRevision: null, rollbackAt: null, verification: "worker deploy log" } });
  const models = {
    AlbumCatalog: model([]), reviewStatusForAlbums: async () => [],
    Listening: { MappingCase: model([]), Job: model(jobs), AlbumMapping: model([]), DiscoveryAttempt: model(attempts), MappingAudit: model([]), Connection: model([]), Scrobble: { aggregate: () => { throw new Error("unused"); } } },
    ...observationModels(),
  };
  const now = new Date("2026-11-20T06:00:00Z");
  const report = await collectMeasurement({ manifest: manifest({ exposures }), now, clock: () => 0, limits: { pageSize: 2, maxRecords: 10_000, maxTimeMS: 5_000, wallMs: 60_000 }, ...models });
  const outcomes = report.rediscoveryOutcomes;
  assert.equal(outcomes.intake.basis, "prospective_after_observation_records");
  assert.deepEqual([outcomes.entered, outcomes.followUpComplete, outcomes.censored], [9, 8, 1], "the pair after the intake is excluded; the late one is censored");
  assert.equal(outcomes.usableCandidateAtEntry, 1);
  assert.deepEqual(outcomes.candidateGain, { unit: "pair", numerator: 2, denominator: 7, value: 2 / 7 });
  assert.deepEqual(outcomes.pr33ObservedGain, { unit: "pair", numerator: 1, denominator: 7, value: 1 / 7 }, "a gain from a moderator refresh is not PR33's");
  assert.deepEqual(outcomes.gainAttribution, { pr33Observed: 1, ownJobAlreadyPresent: 0, otherTrigger: 1, total: 2, reconciles: true });
  assert.deepEqual(outcomes.outcomeAtFollowUp, { notExecuted: 2, unrecordedExecution: 1, skippedIneligible: 1, executedWithMatching: 2, executedWithoutMatching: 0, failedAwaitingRetry: 1, terminalError: 1, total: 8, reconciles: true });
  assert.deepEqual(outcomes.terminalErrorIncidence, { unit: "pair", numerator: 1, denominator: 8, value: 1 / 8 });
  assert.equal(outcomes.retryLoad.runs, 6);
  assert.equal(outcomes.enqueueReach.measurable, false);
  assert.deepEqual(outcomes.delaySeconds.eligibilityToObservationUpperBound.unknownEntry, 1);
  assert.deepEqual(outcomes.delaySeconds.observationToFirstRun, { count: 4, p50: 3600, p90: 86_400, max: 86_400, notRunByFollowUp: 4 });
  assert.deepEqual(outcomes.delaySeconds.observationToFirstUsableCandidate, { count: 2, p50: 3600, p90: 7200, max: 7200, notGainedByFollowUp: 5 });

  const runs = report.discoveryRuns;
  assert.deepEqual([runs.runs, runs.skips, runs.distinctCases], [8, 1, 5]);
  assert.deepEqual(runs.result, { completeResult: 4, incompleteResult: 1, failedWithoutResult: 2, revisionConflict: 1, total: 8, reconciles: true });
  assert.deepEqual(runs.byTrigger, { catalog: 7, moderator_refresh: 1, case_revision: 0, total: 8, reconciles: true });
  assert.deepEqual(runs.coverageKnown, { unit: "run with a result", numerator: 5, denominator: 6, value: 5 / 6 });
  assert.deepEqual(runs.reasonsAmongResults, { providerIncomplete: 1, queryCapReached: 1, candidateCapReached: 0 });

  const expired = await collectMeasurement({ manifest: manifest({ exposures }), now: new Date("2027-02-01T00:00:00Z"), clock: () => 0, ...models });
  assert.deepEqual(expired.rediscoveryOutcomes, { collected: false, reason: "observation_records_expired" });

  const serialized = JSON.stringify(report);
  for (const job of jobs) for (const secret of [job.payload.caseId, job.payload.observation.albumId, String(job._id)]) assert.equal(serialized.includes(secret), false);
});

test("review episode coverage is measured against the audit log, with failures by reason and unknown gaps", async () => {
  const at = (hours) => new Date(Date.parse(T) + hours * 3_600_000);
  const audit = (hours, action, extra = {}) => ({ _id: oidAt(at(hours)), auditId: crypto.randomUUID(), action, createdAt: at(hours), ...extra });
  const mappingAudits = [audit(1, "approved"), audit(2, "approved"), audit(3, "rejected"), audit(4, "no_catalog_match"), audit(5, "approved"), audit(50, "approved"), audit(6, "revoked")];
  const baselineAudits = [audit(1, "confirm"), audit(2, "replace"), audit(3, "defer"), audit(4, "invalidate")];
  const episode = (row, fields) => ({ _id: oidAt(row.createdAt), auditId: row.auditId, decidedAt: row.createdAt, outcome: "recorded", failureReason: "", ...fields });
  const run = crypto.randomUUID();
  const release = (id) => ({ id });
  const episodes = [
    episode(mappingAudits[0], { evidence: { coverage: { queryCapReached: false }, candidatesTruncated: false, selected: release("a"), selectedRank: 0 } }),
    episode(mappingAudits[1], { evidence: { coverage: { queryCapReached: true }, candidatesTruncated: true, selected: release("b"), selectedRank: -1 } }),
    episode(mappingAudits[2], { outcome: "failed", failureReason: "capture_failed", evidence: null }),
    episode(mappingAudits[3], { outcome: "failed", failureReason: "write_failed", evidence: null }),
    // mappingAudits[4] has no episode and no marker: unknown. mappingAudits[5] fell in a flag-off interval.
    episode(baselineAudits[0], { evidence: { coverage: { browseComplete: true }, recommendationRunId: run, recommended: release("r1"), selected: release("r1"), selectedRank: 0 } }),
    episode(baselineAudits[1], { evidence: { coverage: null, recommendationRunId: "", recommended: null, selected: release("r2"), selectedRank: -1 } }),
    // An episode whose audit entry is missing would be a bug, so it is counted separately.
    { _id: oidAt(at(7)), auditId: crypto.randomUUID(), decidedAt: at(7), outcome: "recorded", evidence: {} },
  ];
  const runs = [
    { _id: oidAt(at(1)), runId: run, startedAt: at(1), outcome: "recommended", coverage: { browseComplete: true, hydrationComplete: false, uninspectedCompeting: 1, ambiguous: true }, comparisons: [{ competing: true, equivalent: false }, { competing: false, equivalent: false }] },
    { _id: oidAt(at(2)), runId: crypto.randomUUID(), startedAt: at(2), outcome: "no_candidate", coverage: { browseComplete: false }, comparisons: [] },
    { _id: oidAt(at(3)), runId: crypto.randomUUID(), startedAt: at(3), outcome: "failed", coverage: null, comparisons: [] },
  ];
  const flagChanges = [{ flag: "REVIEW_EPISODES_ENABLED", enabled: false, at: at(48).toISOString() }, { flag: "REVIEW_EPISODES_ENABLED", enabled: true, at: at(52).toISOString() }];
  const models = {
    AlbumCatalog: model([]), reviewStatusForAlbums: async () => [],
    Listening: { MappingCase: model([]), Job: model([]), AlbumMapping: model([]), DiscoveryAttempt: model([]), MappingAudit: model(mappingAudits), Connection: model([]), Scrobble: { aggregate: () => { throw new Error("unused"); } } },
    ...observationModels({ baselineAudits, episodes, runs }),
  };
  const report = await collectMeasurement({ manifest: manifest({ flagChanges }), now: NOW, clock: () => 0, limits: { pageSize: 2, maxRecords: 10_000, maxTimeMS: 5_000, wallMs: 60_000 }, ...models });
  const { mapping, baseline } = report.reviewEpisodes;
  assert.equal(report.reviewEpisodes.flagOffIntervals, 1);
  assert.equal(mapping.decisions, 5, "revokes are not decisions; the decision while the flag was off is excluded");
  assert.equal(mapping.decisionsWhileFlagOff, 1);
  assert.deepEqual(mapping.episodes, { recorded: 2, failed: 2, missingUnknown: 1, total: 5, reconciles: true });
  assert.deepEqual(mapping.failedByReason, { capture_failed: 1, capture_invalid: 0, write_failed: 1, write_timeout: 0, total: 2, reconciles: true });
  assert.deepEqual(mapping.episodeCoverage, { unit: "decision", numerator: 2, denominator: 5, value: 0.4 });
  assert.deepEqual(mapping.provenanceAmongRecorded, { recorded: 2, coverageKnown: 2, candidateListTruncated: 1 });
  assert.deepEqual(mapping.selection, { fromDisplayedCandidates: 1, outsideDisplayedCandidates: 1, total: 2, reconciles: true });
  assert.equal(baseline.decisions, 3, "server-authored invalidations are not decisions");
  assert.deepEqual(baseline.episodes, { recorded: 2, failed: 0, missingUnknown: 1, total: 3, reconciles: true });
  assert.deepEqual(baseline.provenanceAmongRecorded, { recorded: 2, coverageKnown: 1, candidateListTruncated: 0, withRecommendationRun: 1 });
  assert.deepEqual(baseline.selection, { matchesRecommendation: 1, differsFromRecommendation: 0, noRecommendationRecorded: 1, total: 2, reconciles: true });
  assert.equal(report.reviewEpisodes.episodesWithoutAuditEntry, 1);

  const runsReport = report.recommendationRuns;
  assert.deepEqual(runsReport.outcome, { recommended: 1, no_candidate: 1, failed: 1, total: 3, reconciles: true });
  assert.deepEqual(runsReport.coverageKnown, { unit: "run with a result", numerator: 2, denominator: 2, value: 1 });
  assert.deepEqual(runsReport.reasonsAmongResults, { browseIncomplete: 1, hydrationIncomplete: 1, uninspectedCompeting: 1, ambiguous: 1, competingOrderedDifference: 1, nonCompetingOrderedDifference: 1 });
  assert.deepEqual(runsReport.runsLinkedToDecisions, { unit: "run", numerator: 1, denominator: 3, value: 1 / 3 });
  const serialized = JSON.stringify(report);
  for (const row of [...mappingAudits, ...baselineAudits]) assert.equal(serialized.includes(row.auditId), false);
  assert.equal(serialized.includes(run), false);
});

test("effort totals hide every group smaller than five, including cells recoverable by subtraction", async () => {
  const at = (minutes) => new Date(Date.parse(T) + minutes * 60_000);
  const effort = (minute, fields) => ({ _id: oidAt(at(minute)), recordedAt: at(minute), kind: "mapping", outcome: "decided", activeMs: 120_000, auditId: crypto.randomUUID(), ...fields });
  const mapping = [1, 2, 3, 4, 5].map((minute) => effort(minute, {}));
  const baseline = [6, 7, 8, 9, 10].map((minute) => effort(minute, { kind: "baseline", activeMs: 600_000 }));
  const abandoned = [11, 12, 13, 14, 15].map((minute) => effort(minute, { outcome: "abandoned", auditId: "" }));
  const unlinked = [16, 17, 18, 19, 20].map((minute) => effort(minute, { auditId: "" }));
  const exposures = exposuresWith({ effortTimer: { activatedAt: T, deployedRevision: null, rollbackAt: null, verification: "flag turned on" } });
  const base = {
    AlbumCatalog: model([]), reviewStatusForAlbums: async () => [],
    Listening: { MappingCase: model([]), Job: model([]), AlbumMapping: model([]), DiscoveryAttempt: model([]), MappingAudit: model([]), Connection: model([]), Scrobble: { aggregate: () => { throw new Error("unused"); } } },
  };
  const run = (efforts) => collectMeasurement({ manifest: manifest({ exposures }), now: NOW, clock: () => 0, ...base, ...observationModels({ efforts }) });
  const full = (await run([...mapping, ...baseline, ...abandoned, ...unlinked])).reviewEffort;
  assert.deepEqual(full.timings, { decidedLinked: 10, decidedUnlinked: 5, abandoned: 5, total: 20, reconciles: true });
  assert.deepEqual(full.decided, { records: 10, activeMinutes: 60, activeSecondsPerRecord: { count: 10, p50: 120, p90: 600, max: 600 } });
  assert.deepEqual(full.byKind.mapping, { records: 5, activeMinutes: 10, activeSecondsPerRecord: { count: 5, p50: 120, p90: 120, max: 120 } });
  assert.equal(full.abandoned.records, 5);

  // One baseline timing would be decided minus mapping, so both kinds are hidden; the timing
  // partition has small cells, so only its total is shown.
  const partial = (await run([...mapping, baseline[0], abandoned[0]])).reviewEffort;
  assert.deepEqual(partial.byKind, { mapping: { suppressed: true, reason: "fewer_than_5" }, baseline: { suppressed: true, reason: "fewer_than_5" } });
  assert.deepEqual(partial.timings, { total: 7, suppressed: true, reason: "a_cell_has_fewer_than_5" });
  assert.equal(partial.decided.records, 6);
  assert.deepEqual(partial.abandoned, { suppressed: true, reason: "fewer_than_5" });
  const few = (await run(mapping.slice(0, 3))).reviewEffort;
  assert.deepEqual(few.timings, { suppressed: true, reason: "fewer_than_5" }, "even the overall counts are hidden below five");
});
