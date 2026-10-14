const express = require("express");
const { clerkClient, getAuth } = require("@clerk/express");
const AlbumCatalog = require("../models/AlbumCatalog");
const { savedUserCount } = require("./utils/boardLibrary");
const Follow = require("../models/Follow");
const Like = require("../models/Like");
const Review = require("../models/Reviews");
const { findAlbumByPublicId, normalizeCatalogAlbum } = require("./utils/albumCatalog");
const { buildCatalogSearchQuery } = require("./utils/catalogSearch");

const router = express.Router();
const PAGE_LIMIT = 24;
const MAX_PAGE_LIMIT = 24;
const DEFAULT_USERNAME = "rescened user";
const RATINGS = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];

function getViewerId(req) {
  try { return getAuth(req).userId || ""; } catch { return ""; }
}

function ensureAuthenticated(req, res, next) {
  const userId = getViewerId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  req.userId = userId;
  next();
}

function limit(value) {
  const parsed = Number.parseInt(value, 10);
  return Math.min(Number.isFinite(parsed) && parsed > 0 ? parsed : PAGE_LIMIT, MAX_PAGE_LIMIT);
}

function plain(value) { return typeof value?.toObject === "function" ? value.toObject() : value; }

async function authors(userIds) {
  const result = new Map([...new Set(userIds.filter(Boolean))].map((id) => [id, { userId: id, username: DEFAULT_USERNAME, imageUrl: "" }]));
  if (!result.size) return result;
  try {
    const listed = await clerkClient.users.getUserList({ userId: [...result.keys()] });
    const users = Array.isArray(listed) ? listed : listed.data || [];
    users.forEach((user) => result.set(user.id, { userId: user.id, username: user.username || DEFAULT_USERNAME, imageUrl: user.imageUrl || "" }));
  } catch { /* metadata is optional */ }
  return result;
}

async function ratingSummary(albumCatalogId) {
  const rows = await Review.aggregate([
    { $match: { albumCatalogId } },
    { $group: { _id: "$rating", count: { $sum: 1 } } },
  ]);
  const counts = new Map(rows.map((row) => [Number(row._id), Number(row.count) || 0]));
  const ratingDistribution = RATINGS.map((rating) => ({ rating, count: counts.get(rating) || 0 }));
  const reviewCount = ratingDistribution.reduce((total, row) => total + row.count, 0);
  return {
    reviewCount,
    averageRating: reviewCount ? Math.round((ratingDistribution.reduce((total, row) => total + row.rating * row.count, 0) / reviewCount) * 10) / 10 : null,
    ratingDistribution,
  };
}

function averageOf(ratings) {
  return ratings.length ? Math.round((ratings.reduce((total, value) => total + value, 0) / ratings.length) * 10) / 10 : null;
}

async function socialContext(album, viewerId) {
  const [savedCount, summary, viewerReview] = await Promise.all([
    savedUserCount(album._id),
    ratingSummary(album._id),
    viewerId ? Review.findOne({ albumCatalogId: album._id, userId: viewerId }).sort({ date: -1, _id: -1 }) : null,
  ]);
  let followedReviewers = [];
  let followedAlbumLikers = [];
  if (viewerId) {
    const follows = await Follow.find({ followerId: viewerId });
    const followedIds = follows.map((follow) => plain(follow).followingId).filter((id) => id && id !== viewerId);
    if (followedIds.length) {
      const [reviews, likes] = await Promise.all([
        Review.find({ albumCatalogId: album._id, userId: { $in: followedIds } }).sort({ date: -1, _id: -1 }),
        Like.find({ targetType: "album", albumCatalogId: album._id, userId: { $in: followedIds } }),
      ]);
      const userMap = await authors([...reviews, ...likes].map((row) => plain(row).userId));
      // Reviews arrive newest first, so the first one per person is their latest.
      const latestByUser = new Map();
      reviews.map(plain).forEach((review) => { if (!latestByUser.has(review.userId)) latestByUser.set(review.userId, review); });
      followedReviewers = [...latestByUser.values()].map((review) => ({
        ...userMap.get(review.userId), rating: review.rating, reviewId: review.reviewId || null,
      }));
      followedAlbumLikers = [...new Set(likes.map((row) => plain(row).userId))].map((id) => userMap.get(id));
    }
  }
  return {
    savedCount, ...summary,
    viewerRating: viewerReview ? plain(viewerReview).rating : null,
    followedAverageRating: averageOf(followedReviewers.map((reviewer) => Number(reviewer.rating)).filter(Number.isFinite)),
    followedReviewers, followedAlbumLikers,
  };
}

function catalogQuery(q) {
  return buildCatalogSearchQuery(q);
}

router.get("/catalog", async (req, res) => {
  try {
    const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
    const pageLimit = limit(req.query.limit);
    const skip = (page - 1) * pageLimit;
    const query = catalogQuery(req.query.q);
    const [total, albums] = await Promise.all([
      AlbumCatalog.countDocuments(query),
      AlbumCatalog.find(query).sort({ artistDisplayName: 1, title: 1 }).skip(skip).limit(pageLimit),
    ]);
    res.json({ results: albums.map(normalizeCatalogAlbum), page, limit: pageLimit, total, hasPreviousPage: page > 1, hasNextPage: skip + albums.length < total });
  } catch (error) { res.status(500).json({ error: "Failed to fetch album catalog" }); }
});

router.get("/album/:albumId/social", async (req, res) => {
  try {
    const album = await findAlbumByPublicId(req.params.albumId);
    res.json({ albumId: album.albumId, ...(await socialContext(album, getViewerId(req))) });
  } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : "Failed to fetch album social context" }); }
});

router.get("/album/:albumId", async (req, res) => {
  try {
    const album = await findAlbumByPublicId(req.params.albumId);
    res.json(normalizeCatalogAlbum(album));
  } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : "Failed to fetch album details" }); }
});

module.exports = router;
