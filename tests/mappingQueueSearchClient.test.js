const assert = require("node:assert/strict");
const test = require("node:test");

const helpers = import("../frontend/src/features/lastfm/mappingQueueSearch.js");

test("mapping queue search normalizes album text and keeps filters and cursor", async () => {
  const { buildMappingQueueParams, normalizeMappingQueueSearch, MAX_MAPPING_QUEUE_SEARCH_LENGTH, MAPPING_QUEUE_SEARCH_DEBOUNCE_MS } = await helpers;
  assert.equal(MAX_MAPPING_QUEUE_SEARCH_LENGTH, 200);
  assert.equal(MAPPING_QUEUE_SEARCH_DEBOUNCE_MS, 200);
  assert.equal(normalizeMappingQueueSearch(undefined), "");
  assert.equal(normalizeMappingQueueSearch("\u2002\ufeff"), "");
  assert.equal(normalizeMappingQueueSearch("  Ｂｊｏ\u0308ｒｋ’s\u00a0 (Live)  "), "Björk’s (Live)");
  assert.deepEqual(buildMappingQueueParams({
    status: "approved", priorityOnly: true, staleOnly: true, query: " Ｘ ", cursor: "opaque-cursor",
  }), { status: "approved", priority: "high", stale: "true", q: "X", cursor: "opaque-cursor" });
  assert.deepEqual(buildMappingQueueParams({
    status: "pending", priorityOnly: false, staleOnly: false, query: " ", cursor: "",
  }), { status: "pending", priority: "", stale: "", q: "", cursor: "" });
});

test("queue validation applies the length cap after compatibility and whitespace normalization", async () => {
  const { isMappingQueueSearchTooLong } = await helpers;
  assert.equal(isMappingQueueSearchTooLong("ﬃ".repeat(67)), true);
  assert.equal(isMappingQueueSearchTooLong(" ﬃ".repeat(50)), false);
  assert.equal(isMappingQueueSearchTooLong("ﬃ".repeat(66)), false);
  assert.equal(isMappingQueueSearchTooLong("a".repeat(200)), false);
});

test("appending a queue page keeps the existing order and ignores duplicate case IDs", async () => {
  const { appendUniqueMappingCases } = await helpers;
  const existing = Object.freeze([{ caseId: "a", album: "First" }]);
  const incoming = Object.freeze([{ caseId: "a", album: "Duplicate" }, { caseId: "b", album: "Second" }, { caseId: "b", album: "Duplicate" }, { caseId: "c", album: "Third" }]);
  assert.deepEqual(appendUniqueMappingCases(existing, incoming), [existing[0], incoming[1], incoming[3]]);
});

test("the queue request gate aborts and invalidates obsolete tickets", async () => {
  const { createMappingQueueRequestGate } = await helpers;
  const gate = createMappingQueueRequestGate();
  const first = gate.begin();
  assert.equal(gate.isCurrent(first), true);
  const second = gate.begin();
  assert.equal(first.signal.aborted, true);
  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);
  gate.cancel();
  assert.equal(second.signal.aborted, true);
  assert.equal(gate.isCurrent(second), false);
  assert.equal(gate.isCurrent(gate.begin()), true);
});

test("queue status labels describe only loaded cases", async () => {
  const { mappingQueueStatusLabel } = await helpers;
  const status = (options) => mappingQueueStatusLabel({ itemsCount: 0, hasMore: false, query: "album", ...options });
  assert.equal(status({ loading: true }), "");
  assert.equal(status({ error: new Error("offline") }), "");
  assert.equal(status({ itemsCount: 1 }), "1 matching case");
  assert.equal(status({ itemsCount: 20, hasMore: true }), "20+ matching cases");
  assert.equal(status({ itemsCount: 20, hasMore: true, loadingMore: true }), "20+ matching cases · Loading more…");
  assert.equal(status({ itemsCount: 25 }), "25 matching cases");
  assert.equal(status({ itemsCount: 3, query: "" }), "3 cases");
  assert.equal(status({ itemsCount: 3, loading: true }), "");
  assert.equal(status({ itemsCount: 3, hasMore: true, error: new Error("later page failed") }), "3+ matching cases");
});
