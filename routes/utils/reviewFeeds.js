const Review = require("../../models/Reviews");
const AlbumCatalog = require("../../models/AlbumCatalog");
const { CATALOG_ALBUM_FIELDS, normalizeCatalogAlbum } = require("./albumCatalog");
const { createFeedCache } = require("./feedCache");

const DEFAULT_POPULAR_LIMIT = 5;
const MIN_POPULAR_LIMIT = 5;
const MAX_POPULAR_LIMIT = 10;
const DEFAULT_RECENT_LIMIT = 6;
const DEFAULT_POPULAR_REVIEWS_LIMIT = 4;
const MAX_LIST_LIMIT = 12;
const CATALOG_COLLECTION = AlbumCatalog.collection.name;

function integer(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getPopularLimit(value) {
  return Math.min(MAX_POPULAR_LIMIT, Math.max(MIN_POPULAR_LIMIT, integer(value, DEFAULT_POPULAR_LIMIT)));
}

function getListLimit(value, fallback = 1) {
  return Math.min(MAX_LIST_LIMIT, Math.max(1, integer(value, fallback)));
}

function getPopularDateFilter(windowValue, now = new Date()) {
  const key = String(windowValue || "30d").trim().toLowerCase();
  if (key === "all") return null;
  const days = key === "7d" ? 7 : 30;
  const current = now instanceof Date ? now : new Date(now);
  return new Date(current.getTime() - days * 24 * 60 * 60 * 1000);
}

// Circle feeds restrict discovery to an explicit author set (the viewer plus
// the accounts they follow). An empty set matches nothing rather than
// silently widening to the site-wide feed.
function authorMatch(userIds) {
  if (userIds === undefined) return null;
  return { userId: { $in: Array.isArray(userIds) ? userIds : [] } };
}

// Discovery feeds must only rank public, current catalog records. Each feed
// ranks its rows first, then joins the catalog for a bounded window of the top
// rows. Rows whose catalog album was deleted are dropped in rankCurrent, and
// the window widens until the page is full or the ranking runs out, so a
// deleted row never leaks into a response or takes a result slot.
const RANK_WINDOW_SLACK = 10;
const RANK_WINDOW_GROWTH = 4;
const CATALOG_ALBUM_PROJECTION = Object.fromEntries(CATALOG_ALBUM_FIELDS.split(" ").map((field) => [field, 1]));

function currentCatalogStages(localField) {
  return [
    {
      $lookup: {
        from: CATALOG_COLLECTION,
        localField,
        foreignField: "_id",
        pipeline: [{ $project: CATALOG_ALBUM_PROJECTION }],
        as: "catalogAlbum",
      },
    },
    // Kept so rankCurrent can tell a short window from an exhausted ranking.
    { $unwind: { path: "$catalogAlbum", preserveNullAndEmptyArrays: true } },
  ];
}

function rankWindow(limit, value) {
  return Number.isInteger(value) && value > 0 ? value : limit + RANK_WINDOW_SLACK;
}

function popularAlbumRankingStages({ window = "30d", now = new Date(), userIds } = {}) {
  const pipeline = [];
  const since = getPopularDateFilter(window, now);
  const match = { ...authorMatch(userIds), ...(since ? { date: { $gte: since } } : {}) };
  if (Object.keys(match).length) pipeline.push({ $match: match });
  pipeline.push(
    {
      $group: {
        _id: "$albumCatalogId",
        reviewCount: { $sum: 1 },
        averageRating: { $avg: "$rating" },
        latestReviewDate: { $max: "$date" },
      },
    },
    {
      $set: {
        popularityScore: {
          $divide: [
            { $add: [{ $multiply: ["$averageRating", "$reviewCount"] }, 10.5] },
            { $add: ["$reviewCount", 3] },
          ],
        },
      },
    },
    { $sort: { popularityScore: -1, reviewCount: -1, averageRating: -1, latestReviewDate: -1, _id: -1 } },
  );
  return pipeline;
}

function featuredAlbumRankingStages() {
  return [
    {
      $group: {
        _id: "$albumCatalogId",
        reviewCount: { $sum: 1 },
        averageRating: { $avg: "$rating" },
        latestReviewDate: { $max: "$date" },
      },
    },
    { $sort: { reviewCount: -1, averageRating: -1, latestReviewDate: -1, _id: -1 } },
  ];
}

function recentAlbumRankingStages() {
  return [
    { $sort: { date: -1, _id: -1 } },
    {
      $group: {
        _id: "$albumCatalogId",
        latestReviewDate: { $first: "$date" },
        latestReviewId: { $first: "$_id" },
      },
    },
    { $sort: { latestReviewDate: -1, latestReviewId: -1 } },
  ];
}

function popularReviewRankingStages({ userIds } = {}) {
  const match = authorMatch(userIds);
  return [
    ...(match ? [{ $match: match }] : []),
    {
      $lookup: {
        from: "likes",
        let: { currentReviewId: "$_id" },
        pipeline: [
          { $match: { $expr: { $and: [{ $eq: ["$targetType", "review"] }, { $eq: ["$reviewId", "$$currentReviewId"] }] } } },
          { $count: "count" },
        ],
        as: "reviewLikeStats",
      },
    },
    { $set: { likeCount: { $ifNull: [{ $arrayElemAt: ["$reviewLikeStats.count", 0] }, 0] } } },
    { $sort: { likeCount: -1, date: -1, _id: -1 } },
  ];
}

function buildPopularAlbumsPipeline({ limit = DEFAULT_POPULAR_LIMIT, window = "30d", now = new Date(), userIds, rankWindow: size } = {}) {
  return [
    ...popularAlbumRankingStages({ window, now, userIds }),
    { $limit: rankWindow(getPopularLimit(limit), size) },
    ...currentCatalogStages("_id"),
  ];
}

function buildFeaturedAlbumsPipeline(limit = 5, { rankWindow: size } = {}) {
  return [
    ...featuredAlbumRankingStages(),
    { $limit: rankWindow(getListLimit(limit, DEFAULT_POPULAR_LIMIT), size) },
    ...currentCatalogStages("_id"),
  ];
}

function buildRecentlyReviewedAlbumsPipeline(limit = DEFAULT_RECENT_LIMIT, { rankWindow: size } = {}) {
  return [
    ...recentAlbumRankingStages(),
    { $limit: rankWindow(getListLimit(limit, DEFAULT_RECENT_LIMIT), size) },
    ...currentCatalogStages("_id"),
  ];
}

function buildPopularReviewsPipeline(limit = DEFAULT_POPULAR_REVIEWS_LIMIT, { userIds, rankWindow: size } = {}) {
  return [
    ...popularReviewRankingStages({ userIds }),
    { $limit: rankWindow(getListLimit(limit, DEFAULT_POPULAR_REVIEWS_LIMIT), size) },
    ...currentCatalogStages("albumCatalogId"),
    { $project: { reviewLikeStats: 0, likeCount: 0 } },
  ];
}

// Runs a feed pipeline over a growing window until it yields limit rows with a
// current catalog album, or the ranking has no more rows. Order is the
// ranking's own order, so ties break exactly as the pipeline sorts them.
async function rankCurrent(model, buildPipeline, limit) {
  let size = limit + RANK_WINDOW_SLACK;
  for (;;) {
    const rows = await model.aggregate(buildPipeline(size));
    const current = rows.filter((row) => row?.catalogAlbum);
    if (current.length >= limit || rows.length < size) return current.slice(0, limit);
    size *= RANK_WINDOW_GROWTH;
  }
}

function albumDecorations(row) {
  return {
    reviewCount: row.reviewCount || 0,
    averageRating: Number(Number(row.averageRating || 0).toFixed(2)),
    popularityScore: Number(Number(row.popularityScore || 0).toFixed(4)),
    latestReviewDate: row.latestReviewDate,
  };
}

async function resolveCatalogAlbums(rows, decorate = () => ({})) {
  const ids = rows.filter((row) => !row?.catalogAlbum).map((row) => row?._id).filter(Boolean);
  const albums = ids.length ? await AlbumCatalog.find({ _id: { $in: ids } }).select(CATALOG_ALBUM_FIELDS) : [];
  const albumMap = new Map(albums.map((album) => [String(album._id), album]));
  return rows.map((row) => {
    const album = row.catalogAlbum || albumMap.get(String(row._id));
    if (!album) return null;
    return { ...normalizeCatalogAlbum(album), ...decorate(row) };
  }).filter(Boolean);
}

function rankPopularAlbums({ count, window, now, userIds }) {
  return rankCurrent(Review, (size) => buildPopularAlbumsPipeline({ window, now, userIds, rankWindow: size }), count);
}

function rankFeaturedAlbums(count) {
  return rankCurrent(Review, (size) => buildFeaturedAlbumsPipeline(count, { rankWindow: size }), count);
}

function rankRecentAlbums(count) {
  return rankCurrent(Review, (size) => buildRecentlyReviewedAlbumsPipeline(count, { rankWindow: size }), count);
}

function rankPopularReviews(count, { userIds } = {}) {
  return rankCurrent(Review, (size) => buildPopularReviewsPipeline(count, { userIds, rankWindow: size }), count);
}

async function rankedAlbums({ limit, window, now, userIds } = {}) {
  const rows = await rankPopularAlbums({ count: getPopularLimit(limit), window, now, userIds });
  return resolveCatalogAlbums(rows, albumDecorations);
}

async function featuredAlbums(limit = 5) {
  return resolveCatalogAlbums(await rankFeaturedAlbums(getListLimit(limit, DEFAULT_POPULAR_LIMIT)));
}

async function recentlyReviewedAlbums(limit = DEFAULT_RECENT_LIMIT) {
  const rows = await rankRecentAlbums(getListLimit(limit, DEFAULT_RECENT_LIMIT));
  return resolveCatalogAlbums(rows, (row) => ({ latestReviewDate: row.latestReviewDate }));
}

function withoutCatalogAlbum({ catalogAlbum, ...row }) {
  return row;
}

// Popular review rows in rank order, without the catalog join, ready for
// serializeReviews.
async function popularReviewRows(limit = DEFAULT_POPULAR_REVIEWS_LIMIT, { userIds } = {}) {
  const rows = await rankPopularReviews(getListLimit(limit, DEFAULT_POPULAR_REVIEWS_LIMIT), { userIds });
  return rows.map(withoutCatalogAlbum);
}

// Site-wide feeds are the same for every viewer, so their rankings are cached
// briefly. Only ranked ids and scores are cached: catalog metadata, review
// content, and viewer likes are read on every request. Each cached ranking runs
// RANK_WINDOW_SLACK rows deeper than the page, so a catalog album or review
// deleted within the TTL is dropped without leaving the page short.
const feedCache = createFeedCache();

function popularWindowKey(value) {
  const key = String(value || "30d").trim().toLowerCase();
  return key === "all" || key === "7d" ? key : "30d";
}

async function cachedAlbumFeed(key, rank, size, decorate) {
  const rows = await feedCache.get(key, async () => (await rank(size + RANK_WINDOW_SLACK)).map(withoutCatalogAlbum));
  return (await resolveCatalogAlbums(rows, decorate)).slice(0, size);
}

function sitePopularAlbums({ limit, window } = {}) {
  const windowKey = popularWindowKey(window);
  const size = getPopularLimit(limit);
  return cachedAlbumFeed(`popular:${windowKey}:${size}`, (count) => rankPopularAlbums({ count, window: windowKey }), size, albumDecorations);
}

function siteFeaturedAlbums(limit = 5) {
  const size = getListLimit(limit, DEFAULT_POPULAR_LIMIT);
  return cachedAlbumFeed(`featured:${size}`, rankFeaturedAlbums, size, () => ({}));
}

function siteRecentlyReviewedAlbums(limit = DEFAULT_RECENT_LIMIT) {
  const size = getListLimit(limit, DEFAULT_RECENT_LIMIT);
  return cachedAlbumFeed(`recent:${size}`, rankRecentAlbums, size, (row) => ({ latestReviewDate: row.latestReviewDate }));
}

async function sitePopularReviewRows(limit = DEFAULT_POPULAR_REVIEWS_LIMIT) {
  const size = getListLimit(limit, DEFAULT_POPULAR_REVIEWS_LIMIT);
  const ids = await feedCache.get(`popular-reviews:${size}`, async () => (await rankPopularReviews(size + RANK_WINDOW_SLACK)).map((row) => row._id));
  if (!ids.length) return [];
  const reviews = await Review.find({ _id: { $in: ids } }).lean();
  const albumIds = [...new Set(reviews.map((review) => String(review.albumCatalogId || "")).filter(Boolean))];
  const currentAlbums = new Set((albumIds.length
    ? await AlbumCatalog.find({ _id: { $in: albumIds } }).select("_id").lean()
    : []).map((album) => String(album._id)));
  const byId = new Map(reviews.map((review) => [String(review._id), review]));
  return ids
    .map((id) => byId.get(String(id)))
    .filter((review) => review && currentAlbums.has(String(review.albumCatalogId)))
    .slice(0, size);
}

function resetFeedCache() {
  feedCache.clear();
}

module.exports = {
  DEFAULT_POPULAR_LIMIT,
  DEFAULT_RECENT_LIMIT,
  DEFAULT_POPULAR_REVIEWS_LIMIT,
  MAX_LIST_LIMIT,
  RANK_WINDOW_SLACK,
  RANK_WINDOW_GROWTH,
  getPopularDateFilter,
  getPopularLimit,
  getListLimit,
  buildPopularAlbumsPipeline,
  buildFeaturedAlbumsPipeline,
  buildRecentlyReviewedAlbumsPipeline,
  buildPopularReviewsPipeline,
  rankCurrent,
  resolveCatalogAlbums,
  rankedAlbums,
  featuredAlbums,
  recentlyReviewedAlbums,
  popularReviewRows,
  sitePopularAlbums,
  siteFeaturedAlbums,
  siteRecentlyReviewedAlbums,
  sitePopularReviewRows,
  resetFeedCache,
};
