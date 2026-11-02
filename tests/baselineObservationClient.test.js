const assert = require("node:assert/strict");
const test = require("node:test");

test("browse pages retain only the exact displayed run and page IDs", async () => {
  const { mergeBrowsePage } = await import("../frontend/src/features/baselines/recommendationObservation.js");
  const runId = "11111111-1111-4111-8111-111111111111";
  const first = { items: [{ releaseMbid: "first" }], coverage: { browse: { listed: 1, total: 2, complete: false } }, incomplete: true, recommendationRunId: runId, recommendationPageIds: [] };
  const page = { items: [{ releaseMbid: "second" }], incomplete: false, recommendationRunId: runId, recommendationPageId: "22222222-2222-4222-8222-222222222222" };
  const merged = mergeBrowsePage(first, page);
  assert.deepEqual(merged.items.map((item) => item.releaseMbid), ["first", "second"]);
  assert.deepEqual(merged.recommendationPageIds, [page.recommendationPageId]);
  assert.equal(merged.coverage.browse.complete, true);
  const unrecorded = mergeBrowsePage(first, { ...page, recommendationPageId: "" });
  assert.equal(unrecorded.recommendationRunId, "");
  assert.deepEqual(unrecorded.recommendationPageIds, [], "a failed observation cannot claim a complete display");
  const otherRun = mergeBrowsePage(first, { ...page, recommendationRunId: "33333333-3333-4333-8333-333333333333" });
  assert.equal(otherRun.recommendationRunId, "", "another run's page cannot attach to this review");
});
