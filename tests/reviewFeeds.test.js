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
  RANK_WINDOW_SLACK,
} = require("../routes/utils/reviewFeeds");

// Feeds rank first and join the catalog only for a bounded window of top rows.
// rankCurrent drops rows whose catalog album is gone, so the join must keep
// them visible instead of silently shrinking the window.
function assertRankThenJoin(pipeline, window) {
  const lookup = pipeline.findIndex((stage) => stage.$lookup?.from === "albumcatalogs");
  const limit = pipeline.findIndex((stage) => stage.$limit);
  const sort = pipeline.findLastIndex((stage, index) => stage.$sort && index < limit);
  assert.ok(lookup >= 0, "pipeline must join the catalog");
  assert.ok(sort >= 0 && sort === limit - 1, "the window must directly follow the ranking sort");
  assert.ok(limit < lookup, "catalog join must run after the ranking window");
  assert.deepEqual(pipeline[limit], { $limit: window });
  assert.deepEqual(pipeline[lookup + 1], { $unwind: { path: "$catalogAlbum", preserveNullAndEmptyArrays: true } });
  assert.equal(pipeline[lookup].$lookup.pipeline[0].$project.fieldProvenance, undefined, "the join must not copy internal fields");
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
  const score = pipeline.find((stage) => stage.$set)?.$set?.popularityScore;
  assert.deepEqual(score.$divide[0].$add[1], 10.5);
  assert.deepEqual(pipeline.find((stage) => stage.$sort).$sort, {
    popularityScore: -1,
    reviewCount: -1,
    averageRating: -1,
    latestReviewDate: -1,
    _id: -1,
  });
  assertRankThenJoin(pipeline, 8 + RANK_WINDOW_SLACK);
  assertRankThenJoin(buildPopularAlbumsPipeline({ limit: 8, rankWindow: 72 }), 72);
});

test("recent and popular-review pipelines are bounded and deterministic", () => {
  const recent = buildRecentlyReviewedAlbumsPipeline(12);
  assert.deepEqual(recent.at(0), { $sort: { date: -1, _id: -1 } });
  assertRankThenJoin(recent, 12 + RANK_WINDOW_SLACK);

  const featured = buildFeaturedAlbumsPipeline(12);
  assertRankThenJoin(featured, 12 + RANK_WINDOW_SLACK);

  const popularReviews = buildPopularReviewsPipeline(12);
  assert.deepEqual(popularReviews.at(-1), { $project: { reviewLikeStats: 0, likeCount: 0 } });
  assert.deepEqual(popularReviews.find((stage) => stage.$sort).$sort, { likeCount: -1, date: -1, _id: -1 });
  assertRankThenJoin(popularReviews, 12 + RANK_WINDOW_SLACK);
});

test("circle feeds restrict authors before grouping and never widen an empty circle", () => {
  const now = new Date("2026-09-03T12:00:00.000Z");
  const popular = buildPopularAlbumsPipeline({ window: "30d", now, userIds: ["viewer", "friend"] });
  assert.deepEqual(popular[0], {
    $match: { userId: { $in: ["viewer", "friend"] }, date: { $gte: new Date("2026-08-04T12:00:00.000Z") } },
  });
  assert.ok(popular.findIndex((stage) => stage.$match) < popular.findIndex((stage) => stage.$group));
  assertRankThenJoin(popular, 5 + RANK_WINDOW_SLACK);

  const allTime = buildPopularAlbumsPipeline({ window: "all", userIds: [] });
  assert.deepEqual(allTime[0], { $match: { userId: { $in: [] } } });

  const reviews = buildPopularReviewsPipeline(4, { userIds: ["viewer"] });
  assert.deepEqual(reviews[0], { $match: { userId: { $in: ["viewer"] } } });
  assertRankThenJoin(reviews, 4 + RANK_WINDOW_SLACK);
  assert.equal(buildPopularReviewsPipeline(4).some((stage) => stage.$match), false);
});

const Review = require("../models/Reviews");
const AlbumCatalog = require("../models/AlbumCatalog");
const reviewFeeds = require("../routes/utils/reviewFeeds");
const { createFeedCache } = require("../routes/utils/feedCache");

function windowOf(pipeline) {
  return pipeline.find((stage) => stage.$limit).$limit;
}

// A fake ranking of n rows where the listed ranks have no catalog album.
function fakeRanking(count, deletedRanks = new Set()) {
  const calls = [];
  return {
    calls,
    async aggregate(pipeline) {
      const size = windowOf(pipeline);
      calls.push(size);
      return Array.from({ length: Math.min(size, count) }, (_, rank) => ({
        _id: `row-${rank}`,
        ...(deletedRanks.has(rank) ? {} : { catalogAlbum: { albumId: `album-${rank}` } }),
      }));
    },
  };
}

test("rankCurrent drops deleted catalog rows and keeps the ranking's order", async () => {
  const model = fakeRanking(40, new Set([0, 2]));
  const rows = await reviewFeeds.rankCurrent(model, (size) => [{ $sort: { score: -1 } }, { $limit: size }], 4);
  assert.deepEqual(rows.map((row) => row._id), ["row-1", "row-3", "row-4", "row-5"]);
  assert.deepEqual(model.calls, [4 + RANK_WINDOW_SLACK]);
});

test("rankCurrent widens the window when deleted rows leave the page short", async () => {
  const deleted = new Set(Array.from({ length: 30 }, (_, rank) => rank));
  const model = fakeRanking(100, deleted);
  const rows = await reviewFeeds.rankCurrent(model, (size) => [{ $limit: size }], 5);
  assert.deepEqual(rows.map((row) => row._id), ["row-30", "row-31", "row-32", "row-33", "row-34"]);
  assert.deepEqual(model.calls, [15, 60]);
});

test("rankCurrent stops when the ranking runs out", async () => {
  const model = fakeRanking(7, new Set([1]));
  const rows = await reviewFeeds.rankCurrent(model, (size) => [{ $limit: size }], 12);
  assert.equal(rows.length, 6);
  assert.deepEqual(model.calls, [22]);
});

test("feed cache shares in-flight rankings, expires them, and does not cache failures", async () => {
  let now = 0;
  const cache = createFeedCache({ ttlMs: 1000, clock: () => now });
  let calls = 0;
  const compute = async () => { calls += 1; return [calls]; };

  const [first, second] = await Promise.all([cache.get("a", compute), cache.get("a", compute)]);
  assert.deepEqual(first, [1]);
  assert.strictEqual(first, second);
  now = 999;
  assert.deepEqual(await cache.get("a", compute), [1]);
  now = 1000;
  assert.deepEqual(await cache.get("a", compute), [2]);

  await assert.rejects(cache.get("b", async () => { throw new Error("ranking failed"); }));
  assert.deepEqual(await cache.get("b", compute), [3]);
});

test("feed cache evicts its oldest key past the bound", async () => {
  const cache = createFeedCache({ maxKeys: 2 });
  await cache.get("a", async () => 1);
  await cache.get("b", async () => 2);
  await cache.get("c", async () => 3);
  assert.equal(cache.size, 2);
  assert.equal(await cache.get("a", async () => "recomputed"), "recomputed");
});

function query(result) {
  const chain = {
    select() { return chain; },
    lean() { return chain; },
    then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); },
  };
  return chain;
}

test("site-wide album feeds cache ranked ids and read catalog metadata per request", async (t) => {
  reviewFeeds.resetFeedCache();
  t.after(() => reviewFeeds.resetFeedCache());
  const aggregates = [];
  t.mock.method(Review, "aggregate", async (pipeline) => {
    aggregates.push(windowOf(pipeline));
    return ["a", "b", "c", "d", "e", "f", "g"].map((id, rank) => ({
      _id: id,
      reviewCount: 10 - rank,
      catalogAlbum: { albumId: `album-${id}`, title: "stale" },
    }));
  });
  let titles = new Map(["a", "b", "c", "d", "e", "f", "g"].map((id) => [id, `title-${id}`]));
  const finds = [];
  t.mock.method(AlbumCatalog, "find", (filter) => {
    finds.push(filter);
    return query(() => filter._id.$in
      .filter((id) => titles.has(id))
      .map((id) => ({ _id: id, albumId: `album-${id}`, title: titles.get(id) })));
  });

  const first = await reviewFeeds.siteFeaturedAlbums(5);
  assert.deepEqual(first.map((album) => album.title), ["title-a", "title-b", "title-c", "title-d", "title-e"]);
  assert.deepEqual(aggregates, [5 + RANK_WINDOW_SLACK * 2], "the cached ranking runs deeper than the page");

  // A catalog edit and a deletion inside the TTL show up without re-ranking.
  titles.set("a", "renamed");
  titles.delete("b");
  const second = await reviewFeeds.siteFeaturedAlbums(5);
  assert.deepEqual(second.map((album) => album.title), ["renamed", "title-c", "title-d", "title-e", "title-f"]);
  assert.equal(aggregates.length, 1);
  assert.equal(finds.length, 2);

  await reviewFeeds.siteFeaturedAlbums(6);
  assert.equal(aggregates.length, 2, "each page size has its own ranking");
});

test("site-wide popular reviews cache ranked ids and drop deleted reviews and albums", async (t) => {
  reviewFeeds.resetFeedCache();
  t.after(() => reviewFeeds.resetFeedCache());
  let aggregates = 0;
  t.mock.method(Review, "aggregate", async () => {
    aggregates += 1;
    return ["r1", "r2", "r3", "r4"].map((id) => ({ _id: id, albumCatalogId: `album-${id}`, catalogAlbum: { albumId: "x" } }));
  });
  const reviews = new Set(["r1", "r2", "r3", "r4"]);
  const albums = new Set(["album-r1", "album-r2", "album-r3", "album-r4"]);
  t.mock.method(Review, "find", (filter) => query(() => filter._id.$in
    .filter((id) => reviews.has(id))
    .reverse()
    .map((id) => ({ _id: id, albumCatalogId: `album-${id}` }))));
  t.mock.method(AlbumCatalog, "find", (filter) => query(() => filter._id.$in.filter((id) => albums.has(id)).map((id) => ({ _id: id }))));

  assert.deepEqual((await reviewFeeds.sitePopularReviewRows(2)).map((row) => row._id), ["r1", "r2"]);
  reviews.delete("r1");
  albums.delete("album-r3");
  assert.deepEqual((await reviewFeeds.sitePopularReviewRows(2)).map((row) => row._id), ["r2", "r4"]);
  assert.equal(aggregates, 1);
});
