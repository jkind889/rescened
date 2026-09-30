const assert = require("node:assert/strict");
const test = require("node:test");
const Review = require("../models/Reviews");
const { buildSuggestionPipeline, getSuggestionLimit } = require("../routes/utils/peopleSuggestions");

test("suggestion limits default and clamp", () => {
  assert.equal(getSuggestionLimit(undefined), 5);
  assert.equal(getSuggestionLimit("0"), 1);
  assert.equal(getSuggestionLimit("100"), 12);
  assert.equal(getSuggestionLimit("3"), 3);
});

test("suggestion pipeline excludes deleted authors and the viewer's circle before ranking", () => {
  const now = new Date("2026-09-30T00:00:00.000Z");
  const pipeline = buildSuggestionPipeline({ excludedUserIds: ["viewer", "friend", "viewer"], limit: 4, now });
  assert.deepEqual(pipeline[0], { $match: { userId: { $nin: [Review.DELETED_AUTHOR_ID, "viewer", "friend"] } } });
  const group = pipeline.find((stage) => stage.$group).$group;
  assert.deepEqual(group.recentReviewCount.$sum.$cond[0], { $gte: ["$date", new Date("2026-08-31T00:00:00.000Z")] });
  assert.deepEqual(pipeline.find((stage) => stage.$sort).$sort, {
    recentReviewCount: -1, reviewCount: -1, latestReviewDate: -1, _id: 1,
  });
  // Over-fetch so dropping private profiles still fills the list.
  assert.deepEqual(pipeline.at(-1), { $limit: 12 });
});
