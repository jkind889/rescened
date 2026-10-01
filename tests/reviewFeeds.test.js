const assert = require("node:assert/strict");
const test = require("node:test");
const {
  getPopularDateFilter,
  getPopularLimit,
  getListLimit,
  buildPopularAlbumsPipeline,
  buildFeaturedAlbumsPipeline,
  buildRecentlyReviewedAlbumsPipeline,
  buildPopularReviewsPipeline,
} = require("../routes/utils/reviewFeeds");

function assertCatalogFilterBeforeLimit(pipeline) {
  const lookup = pipeline.findIndex((stage) => stage.$lookup?.from === "albumcatalogs");
  const limit = pipeline.findIndex((stage) => stage.$limit);
  assert.ok(lookup >= 0, "pipeline must join the catalog");
  assert.ok(lookup < limit, "catalog join must run before the limit");
  assert.deepEqual(pipeline[lookup + 1], { $unwind: "$catalogAlbum" });
}

test("popular feed parses windows and clamps limits", () => {
  const now = new Date("2026-09-03T12:00:00.000Z");
  assert.equal(getPopularDateFilter("all", now), null);
  assert.equal(getPopularDateFilter("7d", now).toISOString(), "2026-08-27T12:00:00.000Z");
  assert.equal(getPopularDateFilter("unsupported", now).toISOString(), "2026-08-04T12:00:00.000Z");
  assert.equal(getPopularLimit(undefined), 5);
  assert.equal(getPopularLimit(2), 5);
  assert.equal(getPopularLimit(100), 10);
  assert.equal(getListLimit(undefined, 6), 6);
  assert.equal(getListLimit(100, 6), 12);
});
test("popular album aggregation contains Bayesian score and deterministic tie ordering", () => {
  const pipeline = buildPopularAlbumsPipeline({ limit: 8, window: "all" });
  assert.equal(pipeline.some((stage) => stage.$match), false);
  assert.deepEqual(pipeline.at(-1), { $limit: 8 });
  const score = pipeline.find((stage) => stage.$set)?.$set?.popularityScore;
  assert.deepEqual(score.$divide[0].$add[1], 10.5);
  assert.deepEqual(pipeline.find((stage) => stage.$sort).$sort, {
    popularityScore: -1,
    reviewCount: -1,
    averageRating: -1,
    latestReviewDate: -1,
    _id: -1,
  });
  assertCatalogFilterBeforeLimit(pipeline);
});

test("recent and popular-review pipelines are bounded and deterministic", () => {
  const recent = buildRecentlyReviewedAlbumsPipeline(12);
  assert.deepEqual(recent.at(0), { $sort: { date: -1, _id: -1 } });
  assert.deepEqual(recent.at(-1), { $limit: 12 });
  assertCatalogFilterBeforeLimit(recent);

  const featured = buildFeaturedAlbumsPipeline(12);
  assert.deepEqual(featured.at(-1), { $limit: 12 });
  assertCatalogFilterBeforeLimit(featured);

  const popularReviews = buildPopularReviewsPipeline(12);
  assert.deepEqual(popularReviews.at(-2), { $limit: 12 });
  assert.deepEqual(popularReviews.find((stage) => stage.$sort).$sort, { likeCount: -1, date: -1, _id: -1 });
  assertCatalogFilterBeforeLimit(popularReviews);
});

test("circle feeds restrict authors before grouping and never widen an empty circle", () => {
  const now = new Date("2026-09-03T12:00:00.000Z");
  const popular = buildPopularAlbumsPipeline({ window: "30d", now, userIds: ["viewer", "friend"] });
  assert.deepEqual(popular[0], {
    $match: { userId: { $in: ["viewer", "friend"] }, date: { $gte: new Date("2026-08-04T12:00:00.000Z") } },
  });
  assert.ok(popular.findIndex((stage) => stage.$match) < popular.findIndex((stage) => stage.$group));
  assertCatalogFilterBeforeLimit(popular);

  const allTime = buildPopularAlbumsPipeline({ window: "all", userIds: [] });
  assert.deepEqual(allTime[0], { $match: { userId: { $in: [] } } });

  const reviews = buildPopularReviewsPipeline(4, { userIds: ["viewer"] });
  assert.deepEqual(reviews[0], { $match: { userId: { $in: ["viewer"] } } });
  assert.deepEqual(reviews.at(-2), { $limit: 4 });
  assertCatalogFilterBeforeLimit(reviews);
  assert.equal(buildPopularReviewsPipeline(4).some((stage) => stage.$match), false);
});
