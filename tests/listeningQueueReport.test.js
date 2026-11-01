const test = require("node:test");
const assert = require("node:assert/strict");
const { collectQueueReport, caseShape, percentiles, parseArgs } = require("../scripts/listeningQueueReport");

// Supports the filter operators the report uses: equality, $in and $gte.
function model(rows) {
  const matches = (row, filter) => Object.entries(filter).every(([key, condition]) => {
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      if (condition.$in) return condition.$in.includes(row[key]);
      if (condition.$gte) return new Date(row[key]) >= condition.$gte;
    }
    return row[key] === condition;
  });
  return { find(filter) { const selected = rows.filter((row) => matches(row, filter)); return { select() { return this; }, lean: async () => selected }; } };
}

const now = new Date("2026-11-01T00:00:00Z");
const ago = (hours) => new Date(now.getTime() - hours * 3_600_000);
const discovery = (fields = {}) => [{ source: "candidate_discovery", simplifiedTitle: "", candidateLimitReached: false, ...fields }];
const verified = (albumId, conflicts = []) => ({ albumId, evidence: [{ type: "verified_release_group" }, { source: "candidate_comparison", identifierConflicts: conflicts }] });
const plain = (albumId) => ({ albumId, evidence: [{ type: "exact_local" }] });

function fixtures() {
  const cases = [
    { caseId: "c1", status: "pending", createdAt: ago(10), listenerCount: 3, encounterCount: 9, candidates: [verified("a1")], evidence: discovery(), discoveryError: "" },
    { caseId: "c2", status: "pending", createdAt: ago(30), listenerCount: 1, encounterCount: 2, candidates: [], evidence: discovery({ simplifiedTitle: "Album" }), discoveryError: "" },
    { caseId: "c3", status: "pending", createdAt: ago(50), listenerCount: 2, encounterCount: 4, candidates: [verified("a1", ["Verified release group differs from catalog references"]), plain("a2")], evidence: discovery({ simplifiedTitle: "Album", candidateLimitReached: true }), discoveryError: "musicbrainz_search_unavailable" },
    { caseId: "d1", status: "approved", createdAt: ago(100), candidates: [verified("a1")], evidence: discovery(), discoveryError: "" },
    { caseId: "d2", status: "approved", createdAt: ago(200), candidates: [plain("a1"), plain("a2")], evidence: discovery({ simplifiedTitle: "Album" }), discoveryError: "" },
    { caseId: "d3", status: "approved", createdAt: ago(300), candidates: [plain("a1")], evidence: discovery(), discoveryError: "" },
    { caseId: "d4", status: "rejected", createdAt: ago(400), candidates: [], evidence: discovery(), discoveryError: "" },
    { caseId: "d5", status: "approved", createdAt: ago(2000), candidates: [plain("a1")], evidence: discovery(), discoveryError: "" },
    // The worker closes complete discoveries with no candidates without writing an audit.
    { caseId: "u1", status: "no_catalog_match", createdAt: ago(500), listenerCount: 4, candidates: [], evidence: discovery({ simplifiedTitle: "Album" }), discoveryError: "" },
    { caseId: "u2", status: "no_catalog_match", createdAt: ago(600), listenerCount: 1, candidates: [], evidence: discovery(), discoveryError: "" },
  ];
  const mappingAudits = [
    { caseId: "d1", action: "approved", createdAt: ago(90), details: { selected: { albumId: "a1" } } },
    { caseId: "d2", action: "approved", createdAt: ago(100), details: { selected: { albumId: "a2" } } },
    { caseId: "d3", action: "approved", createdAt: ago(200), details: { selected: { albumId: "a9" } } },
    { caseId: "d4", action: "rejected", createdAt: ago(300), details: {} },
    // A seeded case decided again after a revoke: the later decision has no first-decision wait.
    { caseId: "d5", action: "approve", createdAt: ago(1900), details: { seedEnvironment: "dev" } },
    { caseId: "d5", action: "revoked", createdAt: ago(20), details: {} },
    { caseId: "d5", action: "approved", createdAt: ago(5), details: { selected: { albumId: "a1" } } },
    { caseId: "d4", action: "refresh_requested", createdAt: ago(1), details: {} },
  ];
  const baselineAudits = [
    { targetKind: "albums", targetId: "b1", action: "queue", createdAt: ago(48), details: { releaseMbid: "r1" } },
    { targetKind: "albums", targetId: "b1", action: "confirm", createdAt: ago(24), details: { releaseMbid: "r1" } },
    { targetKind: "albums", targetId: "b2", action: "queue", createdAt: ago(72), details: { releaseMbid: "r2" } },
    { targetKind: "albums", targetId: "b2", action: "confirm", createdAt: ago(12), details: { releaseMbid: "r3" } },
    { targetKind: "albums", targetId: "b3", action: "queue", createdAt: ago(30), details: { releaseMbid: "r4" } },
    { targetKind: "albums", targetId: "b3", action: "defer", createdAt: ago(6), details: {} },
    { targetKind: "albums", targetId: "b4", action: "confirm", createdAt: ago(3), details: { releaseMbid: "r5" } },
    { targetKind: "submissions", targetId: "s1", action: "confirm", createdAt: ago(2), details: { releaseMbid: "r6" } },
    { targetKind: "albums", targetId: "b5", action: "revoke", createdAt: ago(40 * 24), details: {} },
    // Later manual decisions do not answer an earlier queued recommendation again.
    { targetKind: "albums", targetId: "b6", action: "queue", createdAt: ago(100), details: { releaseMbid: "r7" } },
    { targetKind: "albums", targetId: "b6", action: "confirm", createdAt: ago(90), details: { releaseMbid: "r7" } },
    { targetKind: "albums", targetId: "b6", action: "revoke", createdAt: ago(80), details: {} },
    { targetKind: "albums", targetId: "b6", action: "confirm", createdAt: ago(70), details: { releaseMbid: "r8" } },
    { targetKind: "albums", targetId: "b7", action: "queue", createdAt: ago(60), details: { releaseMbid: "r9" } },
    { targetKind: "albums", targetId: "b7", action: "defer", createdAt: ago(50), details: {} },
    { targetKind: "albums", targetId: "b7", action: "confirm", createdAt: ago(40), details: { releaseMbid: "r9" } },
  ];
  return {
    Listening: { MappingCase: model(cases), MappingAudit: model(mappingAudits) },
    Baselines: { Audit: model(baselineAudits) },
    reviewStatusCounts: async () => ({ albums: { pending: 4 }, submissions: { pending: 1 } }),
  };
}

test("queue report measures pending mapping shapes without naming cases", async () => {
  const report = await collectQueueReport({ now, days: 30, ...fixtures() });
  assert.deepEqual(report.mappingQueue, {
    pending: 3, listeners: 6, encounters: 15,
    ageSeconds: { count: 3, p50: 30 * 3600, p90: 50 * 3600, max: 50 * 3600 },
    candidates: { none: 1, one: 1, several: 1 },
    verifiedTopCandidate: 2, conflictedTopCandidate: 1, singleVerifiedCandidate: 1,
    editionLabel: 2, editionLabelWithoutCandidate: 1, candidateLimitReached: 1, discoveryIncomplete: 1,
  });
  assert.deepEqual(report.noCatalogMatch, { cases: 2, listeners: 5, editionLabel: 1 });
  assert.equal(report.window.since, "2026-10-02T00:00:00.000Z");
  assert.deepEqual(report.baselineQueue, { albums: { pending: 4 }, submissions: { pending: 1 } });
  const serialized = JSON.stringify(report);
  for (const secret of ["c1", "d1", "u1", "a1", "b1", "r1", "s1"]) assert.equal(serialized.includes(`"${secret}"`), false);
});

test("mapping decisions time only first decisions and classify the approved candidate", async () => {
  const { mappingDecisions } = await collectQueueReport({ now, days: 30, ...fixtures() });
  assert.equal(mappingDecisions.approved, 4);
  assert.equal(mappingDecisions.rejected, 1);
  assert.equal(mappingDecisions.noCatalogMatch, 0);
  assert.equal(mappingDecisions.revoked, 1);
  assert.equal(mappingDecisions.seededApprovals, 0, "the seed approval is outside the window");
  // d1 waited 10h, d2 100h, d3 100h, d4 100h; d5's approval follows its seed, so it is not timed.
  assert.deepEqual(mappingDecisions.firstDecisionSeconds, { count: 4, p50: 100 * 3600, p90: 100 * 3600, max: 100 * 3600 });
  assert.deepEqual(mappingDecisions.approvals, { topCandidate: 2, otherCandidate: 1, outsideCandidates: 1, unknownCase: 0, singleVerifiedCandidate: 1, editionLabel: 1 });
});

test("baseline decisions compare confirmed releases with the queued recommendation", async () => {
  const { baselineDecisions } = await collectQueueReport({ now, days: 30, ...fixtures() });
  assert.deepEqual(baselineDecisions.albums, { confirm: 6, replace: 0, defer: 2, revoke: 1 });
  assert.deepEqual(baselineDecisions.submissions, { confirm: 1, replace: 0, defer: 0, revoke: 0 });
  assert.deepEqual(baselineDecisions.queued, { confirmedQueuedRelease: 2, confirmedOtherRelease: 1, deferred: 2, decisionSeconds: { count: 5, p50: 24 * 3600, p90: 60 * 3600, max: 60 * 3600 } });
});

test("an empty database reports zero counts and null durations", async () => {
  const empty = { Listening: { MappingCase: model([]), MappingAudit: model([]) }, Baselines: { Audit: model([]) }, reviewStatusCounts: async () => ({}) };
  const report = await collectQueueReport({ now, days: 7, ...empty });
  assert.equal(report.mappingQueue.pending, 0);
  assert.deepEqual(report.mappingQueue.ageSeconds, { count: 0, p50: null, p90: null, max: null });
  assert.deepEqual(report.mappingDecisions.firstDecisionSeconds, { count: 0, p50: null, p90: null, max: null });
  assert.equal(report.baselineDecisions.queued.decisionSeconds.p50, null);
});

test("case shapes treat a conflicted single verified candidate as not automatable", () => {
  assert.equal(caseShape({ candidates: [verified("a1")], evidence: [] }).singleVerified, true);
  assert.equal(caseShape({ candidates: [verified("a1", ["conflict"])], evidence: [] }).singleVerified, false);
  assert.equal(caseShape({ candidates: [plain("a1")], evidence: [] }).singleVerified, false);
  assert.equal(caseShape({}).candidates, "none");
});

test("percentiles use nearest rank and arguments are validated", () => {
  assert.deepEqual(percentiles([5, 1, 3, 2, 4]), { count: 5, p50: 3, p90: 5, max: 5 });
  assert.deepEqual(parseArgs(["--environment", "dev"]), { environment: "dev", days: 30 });
  assert.deepEqual(parseArgs(["--days", "7", "--environment", "pilot"]), { environment: "pilot", days: 7 });
  for (const argv of [[], ["--environment"], ["--environment", "a b"], ["--environment", "dev", "--days", "0"], ["--environment", "dev", "--days", "400"], ["--environment", "dev", "--extra", "1"], ["--environment", "dev", "--environment", "prod"]]) {
    assert.throws(() => parseArgs(argv), /Usage/);
  }
});
