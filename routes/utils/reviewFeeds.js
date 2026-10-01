const Review = require("../../models/Reviews");
const AlbumCatalog = require("../../models/AlbumCatalog");
const { normalizeCatalogAlbum } = require("./albumCatalog");

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

// Discovery feeds must only rank public, current catalog records. Doing this
// inside the aggregation prevents deleted catalog rows from leaking into a
// response or consuming a result slot before the feed limit is applied.
function currentCatalogStages(localField) {
  return [
    {
      $lookup: {
        from: CATALOG_COLLECTION,
        localField,
        foreignField: "_id",
        as: "catalogAlbum",
      },
    },
    { $unwind: "$catalogAlbum" },
  ];
}

function buildPopularAlbumsPipeline({ limit = DEFAULT_POPULAR_LIMIT, window = "30d", now = new Date(), userIds } = {}) {
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
    ...currentCatalogStages("_id"),
    { $sort: { popularityScore: -1, reviewCount: -1, averageRating: -1, latestReviewDate: -1, _id: -1 } },
    { $limit: getPopularLimit(limit) },
  );
  return pipeline;
}

function buildFeaturedAlbumsPipeline(limit = 5) {
  return [
    {
      $group: {
        _id: "$albumCatalogId",
        reviewCount: { $sum: 1 },
        averageRating: { $avg: "$rating" },
        latestReviewDate: { $max: "$date" },
      },
    },
    ...currentCatalogStages("_id"),
    { $sort: { reviewCount: -1, averageRating: -1, latestReviewDate: -1, _id: -1 } },
    { $limit: getListLimit(limit, DEFAULT_POPULAR_LIMIT) },
  ];
}

function buildRecentlyReviewedAlbumsPipeline(limit = DEFAULT_RECENT_LIMIT) {
  return [
    { $sort: { date: -1, _id: -1 } },
    {
      $group: {
        _id: "$albumCatalogId",
        latestReviewDate: { $first: "$date" },
        latestReviewId: { $first: "$_id" },
      },
    },
    ...currentCatalogStages("_id"),
    { $sort: { latestReviewDate: -1, latestReviewId: -1 } },
    { $limit: getListLimit(limit, DEFAULT_RECENT_LIMIT) },
  ];
}

function buildPopularReviewsPipeline(limit = DEFAULT_POPULAR_REVIEWS_LIMIT, { userIds } = {}) {
  const match = authorMatch(userIds);
  return [
    ...(match ? [{ $match: match }] : []),
    ...currentCatalogStages("albumCatalogId"),
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
    { $limit: getListLimit(limit, DEFAULT_POPULAR_REVIEWS_LIMIT) },
    { $project: { reviewLikeStats: 0, likeCount: 0, catalogAlbum: 0 } },
  ];
}

async function resolveCatalogAlbums(rows, decorate = () => ({})) {
  const ids = rows.filter((row) => !row?.catalogAlbum).map((row) => row?._id).filter(Boolean);
  const albums = ids.length ? await AlbumCatalog.find({ _id: { $in: ids } }) : [];
  const albumMap = new Map(albums.map((album) => [String(album._id), album]));
  return rows.map((row) => {
    const album = row.catalogAlbum || albumMap.get(String(row._id));
    if (!album) return null;
    return { ...normalizeCatalogAlbum(album), ...decorate(row) };
  }).filter(Boolean);
}

async function rankedAlbums({ limit, window, now, userIds } = {}) {
  const rows = await Review.aggregate(buildPopularAlbumsPipeline({ limit, window, now, userIds }));
  return resolveCatalogAlbums(rows, (row) => ({
    reviewCount: row.reviewCount || 0,
    averageRating: Number(Number(row.averageRating || 0).toFixed(2)),
    popularityScore: Number(Number(row.popularityScore || 0).toFixed(4)),
    latestReviewDate: row.latestReviewDate,
  }));
}

async function featuredAlbums(limit = 5) {
  const rows = await Review.aggregate(buildFeaturedAlbumsPipeline(limit));
  return resolveCatalogAlbums(rows);
}

async function recentlyReviewedAlbums(limit = DEFAULT_RECENT_LIMIT) {
  const rows = await Review.aggregate(buildRecentlyReviewedAlbumsPipeline(limit));
  return resolveCatalogAlbums(rows, (row) => ({ latestReviewDate: row.latestReviewDate }));
}

module.exports = {
  DEFAULT_POPULAR_LIMIT,
  DEFAULT_RECENT_LIMIT,
  DEFAULT_POPULAR_REVIEWS_LIMIT,
  MAX_LIST_LIMIT,
  getPopularDateFilter,
  getPopularLimit,
  getListLimit,
  buildPopularAlbumsPipeline,
  buildFeaturedAlbumsPipeline,
  buildRecentlyReviewedAlbumsPipeline,
  buildPopularReviewsPipeline,
  resolveCatalogAlbums,
  rankedAlbums,
  featuredAlbums,
  recentlyReviewedAlbums,
};
