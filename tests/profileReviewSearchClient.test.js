const assert = require("node:assert/strict");
const test = require("node:test");
const helpers = import("../frontend/src/features/reviews/profileReviewSearch.js");

test("profile review requests encode the query, order, and cursor together", async () => {
  const { reviewPageUrl, normalizeReviewSearch } = await helpers;
  assert.equal(normalizeReviewSearch("   THE\t Artist "), "THE Artist");
  assert.equal(normalizeReviewSearch("İstanbul"), "İstanbul");
  assert.equal(normalizeReviewSearch("İ".repeat(101)).length, 101);
  const url = new URL(reviewPageUrl("https://example.test/reviews/review/user/owner", { sort: "highest", search: " A&B + (Live) ", cursor: "opaque/+?" }));
  assert.equal(url.searchParams.get("q"), "A&B + (Live)");
  assert.equal(url.searchParams.get("sort"), "highest");
  assert.equal(url.searchParams.get("cursor"), "opaque/+?");
  assert.equal(new URL(reviewPageUrl(url.origin, { sort: "recent", search: "" })).searchParams.has("q"), false);
});

test("new searches abort and invalidate earlier pages, including pending token/JSON work", async () => {
  const { createReviewRequestGate } = await helpers;
  const gate = createReviewRequestGate();
  const oldSearch = gate.begin();
  const newSearch = gate.begin();
  assert.equal(oldSearch.signal.aborted, true);
  assert.equal(gate.isCurrent(oldSearch), false);
  assert.equal(gate.isCurrent(newSearch), true);
  const loadMore = gate.begin();
  assert.equal(gate.isCurrent(newSearch), false);
  gate.cancel();
  assert.equal(loadMore.signal.aborted, true);
  assert.equal(gate.isCurrent(loadMore), false);
  const nextProfile = gate.begin();
  assert.equal(gate.isCurrent(nextProfile), true);
  assert.equal(gate.isCurrent(loadMore), false);
});

test("continuation pages keep existing review state and deduplicate public IDs", async () => {
  const { appendReviewPage } = await helpers;
  const current = [{ reviewId: "one", likedByViewer: true }];
  assert.deepEqual(appendReviewPage(current, [{ reviewId: "one", likedByViewer: false }, { reviewId: "two" }]), [...current, { reviewId: "two" }]);
});
