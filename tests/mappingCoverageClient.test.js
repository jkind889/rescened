const assert = require("node:assert/strict");
const test = require("node:test");

const helper = import("../frontend/src/features/lastfm/mappingCoverage.js");
const evidence = (overrides = {}) => [{ source: "candidate_discovery", candidateLimitReached: true, candidateQueryLimitReached: true, candidatesShown: 0, candidatesFound: 0, ...overrides }];

test("mapping coverage warns about capped searches even with zero candidates", async () => {
  const { candidateCoverageWarning } = await helper;
  assert.equal(candidateCoverageWarning(evidence()), "No candidates were found within the search limits. More matches may exist.");
});

test("mapping coverage distinguishes observed candidate counts from unknown search coverage", async () => {
  const { candidateCoverageWarning } = await helper;
  assert.equal(candidateCoverageWarning(evidence({ candidatesShown: 5, candidatesFound: 7, candidateQueryLimitReached: false })), "Showing 5 of 7 discovered candidates.");
  assert.equal(candidateCoverageWarning(evidence({ candidatesShown: 1, candidatesFound: 1 })), "Showing 1 of 1 discovered candidates. Search limits were reached; more matches may exist.");
});

test("uncapped and legacy evidence does not invent a coverage warning", async () => {
  const { candidateCoverageWarning } = await helper;
  for (const value of [undefined, [], [null], [{ source: "candidate_discovery" }], evidence({ candidateLimitReached: false })]) {
    assert.equal(candidateCoverageWarning(value), "");
  }
});
