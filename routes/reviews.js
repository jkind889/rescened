const express = require("express");
const { clerkClient, getAuth } = require("@clerk/express");
const Review = require("../models/Reviews");
const AlbumCatalog = require("../models/AlbumCatalog");
const Like = require("../models/Like");
const { findAlbumByPublicId, normalizeCatalogAlbum } = require("./utils/albumCatalog");
const {
  rankedAlbums,
  recentlyReviewedAlbums,
  featuredAlbums,
  buildPopularReviewsPipeline,
  getListLimit,
} = require("./utils/reviewFeeds");
const {
  readPopularReviewPage,
  nextCursorFor,
  parseReviewFeedQuery,
  recentCursorFilter,
} = require("./utils/reviewPagination");
const { deleteOwnedReview, assertReviewId, persistedReviewId } = require("./utils/reviewInteractions");
const {
  reviewCreateRateLimit,
  reviewMutationRateLimit,
} = require("./utils/rateLimit");

const router = express.Router();
const DEFAULT_AUTHOR = "rescened user";
const MAX_REVIEW_TEXT_LENGTH = 300;

function plain(value) { return typeof value?.toObject === "function" ? value.toObject() : value; }
function viewer(req) { try { return getAuth(req).userId || ""; } catch { return ""; } }
function auth(req, res, next) { const userId = viewer(req); if (!userId) return res.status(401).json({ error: "Unauthorized" }); req.userId = userId; next(); }
async function authorMap(ids) {
  const map = new Map([...new Set(ids.filter(Boolean))].map((id) => [id, { userId: id, username: DEFAULT_AUTHOR, imageUrl: "" }]));
  try {
    const listed = await clerkClient.users.getUserList({ userId: [...map.keys()] });
    const users = Array.isArray(listed) ? listed : listed.data || [];
    users.forEach((user) => map.set(user.id, { userId: user.id, username: user.username || DEFAULT_AUTHOR, imageUrl: user.imageUrl || "" }));
  } catch { /* optional */ }
  return map;
}
async function likeStats(reviews, viewerId) {
  const ids = reviews.map((review) => String(review._id)).filter(Boolean);
  const rows = ids.length ? await Like.find({
    targetType: "review",
    reviewId: { $in: ids },
  }) : [];
  const stats = new Map(ids.map((id) => [id, { likeCount: 0, likedByViewer: false }]));
  rows.forEach((row) => { const item = stats.get(String(row.reviewId)); if (item) { item.likeCount += 1; item.likedByViewer ||= Boolean(viewerId && row.userId === viewerId); } });
  return stats;
}
async function serializeReviews(reviews, viewerId) {
  const sources = reviews.map(plain);
  const albumIds = [...new Set(sources.map((review) => String(review.albumCatalogId?._id || review.albumCatalogId || "")).filter(Boolean))];
  const albums = albumIds.length ? await AlbumCatalog.find({ _id: { $in: albumIds } }) : [];
  const albumMap = new Map(albums.map((album) => [String(album._id), normalizeCatalogAlbum(album)]));
  const authors = await authorMap(sources.map((review) => review.userId));
  const stats = await likeStats(sources, viewerId);
  return sources.map((review) => ({
    reviewId: persistedReviewId(review),
    userId: review.userId,
    albumId: albumMap.get(String(review.albumCatalogId?._id || review.albumCatalogId))?.albumId || "",
    album: albumMap.get(String(review.albumCatalogId?._id || review.albumCatalogId)) || null,
    title: albumMap.get(String(review.albumCatalogId?._id || review.albumCatalogId))?.title || "",
    artistDisplayName: albumMap.get(String(review.albumCatalogId?._id || review.albumCatalogId))?.artistDisplayName || "",
    cover: albumMap.get(String(review.albumCatalogId?._id || review.albumCatalogId))?.cover || "",
    releaseYear: albumMap.get(String(review.albumCatalogId?._id || review.albumCatalogId))?.releaseYear || null,
    reviewText: review.reviewText,
    rating: review.rating,
    date: review.date,
    author: authors.get(review.userId) || { userId: review.userId, username: DEFAULT_AUTHOR, imageUrl: "" },
    ...(stats.get(String(review._id)) || { likeCount: 0, likedByViewer: false }),
  }));
}
function rating(body) {
  const value = Number(body?.rating);
  if (!Number.isFinite(value) || value < 1 || value > 5 || !Number.isInteger(value * 2)) return null;
  return value;
}

function creationKey(req) {
  const value = String(req.get("Idempotency-Key") || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    const error = new Error("Idempotency-Key must be a UUID v4");
    error.status = 400;
    error.code = "INVALID_IDEMPOTENCY_KEY";
    throw error;
  }
  return value.toLowerCase();
}

function rejectClientOwnedReviewId(body) {
  if (!body || typeof body !== "object") return;
  if (Object.hasOwn(body, "reviewId") || Object.hasOwn(body, "_id")) {
    const error = new Error("reviewId is server-generated");
    error.status = 400;
    error.code = "INVALID_REVIEW_ID";
    throw error;
  }
}

async function serializeExistingCreation(res, userId, key) {
  const existing = await Review.findOne({ userId, creationKey: key });
  if (!existing) return false;
  res.status(200).json((await serializeReviews([existing], userId))[0]);
  return true;
}

router.post("/review", auth, reviewCreateRateLimit, async (req, res) => {
  try {
    rejectClientOwnedReviewId(req.body);
    const key = creationKey(req);
    if (await serializeExistingCreation(res, req.userId, key)) return;
    const album = await findAlbumByPublicId(req.body.albumId);
    const parsedRating = rating(req.body);
    const reviewText = String(req.body.reviewText || "").trim();
    if (!parsedRating) return res.status(400).json({ error: "Rating must be a whole or half number between 1 and 5" });
    if (!reviewText) return res.status(400).json({ error: "Review text is required" });
    if (reviewText.length > MAX_REVIEW_TEXT_LENGTH) return res.status(400).json({ error: "Review text must be 300 characters or fewer" });
    const review = await Review.create({ userId: req.userId, albumCatalogId: album._id, rating: parsedRating, reviewText, creationKey: key });
    res.status(201).json((await serializeReviews([review], req.userId))[0]);
  } catch (error) {
    if (error?.code === 11000) {
      try {
        const key = creationKey(req);
        if (await serializeExistingCreation(res, req.userId, key)) return;
      } catch { /* fall through to the stable error response */ }
    }
    res.status(error.status || 500).json({ error: error.status ? error.message : "Failed to create review", ...(error.code ? { code: error.code } : {}) });
  }
});

async function sendReviewPage(req, res, { match, scope, viewerId }) {
  const feed = parseReviewFeedQuery(req.query, scope);
  let rows;
  if (feed.sort === "popular") {
    const page = await readPopularReviewPage(match, feed);
    rows = page.rows;
    feed.snapshotTime = page.snapshotTime;
  } else {
    rows = await Review.find({ ...match, ...recentCursorFilter(feed.cursor) })
      .sort({ date: -1, _id: -1 })
      .limit(feed.limit + 1);
  }
  const hasNextPage = rows.length > feed.limit;
  const page = rows.slice(0, feed.limit);
  res.json({
    reviews: await serializeReviews(page, viewerId),
    nextCursor: hasNextPage ? nextCursorFor(page.at(-1), feed) : null,
  });
}

router.get("/review/user/", auth, async (req, res) => {
  try { await sendReviewPage(req, res, { match: { userId: req.userId }, scope: `user:${req.userId}`, viewerId: req.userId }); }
  catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : "Failed to fetch reviews", ...(error.code ? { code: error.code } : {}) }); }
});

router.get("/review/user/:userId", async (req, res) => {
  try {
    const target = String(req.params.userId || "").trim();
    await sendReviewPage(req, res, { match: { userId: target }, scope: `user:${target}`, viewerId: viewer(req) });
  } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : "Failed to fetch reviews", ...(error.code ? { code: error.code } : {}) }); }
});

router.patch("/review/user/:id", auth, reviewMutationRateLimit, async (req, res) => {
  try {
    const reviewId = assertReviewId(req.params.id);
    rejectClientOwnedReviewId(req.body);
    const parsedRating = rating(req.body);
    const reviewText = String(req.body.reviewText || "").trim();
    if (!parsedRating || !reviewText) return res.status(400).json({ error: "Valid rating and review text are required" });
    if (reviewText.length > MAX_REVIEW_TEXT_LENGTH) return res.status(400).json({ error: "Review text must be 300 characters or fewer" });
    const review = await Review.findOneAndUpdate({ reviewId, userId: req.userId }, { $set: { rating: parsedRating, reviewText } }, { returnDocument: "after", runValidators: true });
    if (!review) return res.status(404).json({ error: "Review not found" });
    res.json((await serializeReviews([review], req.userId))[0]);
  } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : "Failed to update review", ...(error.code ? { code: error.code } : {}) }); }
});

router.delete("/review/user/:id", auth, reviewMutationRateLimit, async (req, res) => {
  try {
    assertReviewId(req.params.id);
    await deleteOwnedReview(req.params.id, req.userId);
    res.json({ message: "Review deleted" });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.status ? error.message : "Failed to delete review", ...(error.code ? { code: error.code } : {}) });
  }
});

router.get("/review/album/:albumId", async (req, res) => {
  try {
    const album = await findAlbumByPublicId(req.params.albumId);
    await sendReviewPage(req, res, { match: { albumCatalogId: album._id }, scope: `album:${album.albumId}`, viewerId: viewer(req) });
  } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : "Failed to fetch reviews", ...(error.code ? { code: error.code } : {}) }); }
});

router.get("/popular", async (req, res) => {
  try {
    res.json(await rankedAlbums({ limit: req.query.limit, window: req.query.window }));
  } catch { res.status(500).json({ error: "Failed to fetch reviews" }); }
});

router.get("/recent-albums", async (req, res) => {
  try { res.json(await recentlyReviewedAlbums(getListLimit(req.query.limit, 6))); }
  catch { res.status(500).json({ error: "Failed to fetch recent albums" }); }
});

router.get("/popular-reviews", async (req, res) => {
  try {
    const limit = getListLimit(req.query.limit, 4);
    const reviews = await Review.aggregate(buildPopularReviewsPipeline(limit));
    res.json(await serializeReviews(reviews, viewer(req)));
  } catch { res.status(500).json({ error: "Failed to fetch popular reviews" }); }
});

router.get("/featured", async (req, res) => {
  try { res.json(await featuredAlbums(getListLimit(req.query.limit, 5))); }
  catch { res.status(500).json({ error: "Failed to fetch featured albums" }); }
});

module.exports = router;
