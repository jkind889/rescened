const express = require("express");
const { getAuth } = require("@clerk/express");
const { lookupAuthors } = require("../lib/clerkAuthors");
const UserProfile = require("../models/UserProfile");
const Follow = require("../models/Follow");
const Review = require("../models/Reviews");
const Board = require("../models/Board");
const BoardItem = require("../models/BoardItem");
const Like = require("../models/Like");
const { findAlbumByPublicId, normalizeCatalogAlbum } = require("./utils/albumCatalog");
const { runReviewTransaction, assertPinnedReview, isReviewId, persistedReviewId } = require("./utils/reviewInteractions");
const { NETWORK_ACTIVITY_LIMIT, getNetworkActivity } = require("./utils/networkActivity");
const { formatBoard: libraryBoard, formatBoards, savedAlbums: getSavedAlbums } = require("./utils/boardLibrary");
const { transaction, claimBoard } = require("./utils/boardMutations");
const { listListens, listenCalendar } = require("./utils/listeningDiary");
const { getListenActivity } = require("./utils/listenActivity");
const { suggestPeople } = require("./utils/peopleSuggestions");
const { currentCatalogStages, rankCurrent } = require("./utils/reviewFeeds");
const { getRankingActivity, listUserRankings } = require("./utils/trackRankings");
const { listeningStats } = require("./utils/listeningStats");
const { notificationMutationRateLimit, profileStatsRateLimit, queueMutationRateLimit } = require("./utils/rateLimit");
const { addToQueue, queuePreview, readQueue, removeFromQueue, reorderQueue } = require("./utils/listenQueue");
const { normalizePreferencesPatch, recordFollow, serializePreferences } = require("./utils/notifications");

const { getCommentActivity, compareActivity } = require("../lib/reviewComments/activity");
const { commentCounts } = require("../lib/reviewComments/read");

const router = express.Router();
const MAX_FAVORITES = 5;
const MAX_ACTIVITY = 20;
const PRIVATE_ERROR = { error: "Profile is private", isPrivate: true };
const DEFAULT_AUTHOR = "rescened user";

function plain(value) { return typeof value?.toObject === "function" ? value.toObject() : value; }
function viewer(req) { try { return getAuth(req).userId || ""; } catch { return ""; } }
function auth(req, res, next) { const userId = viewer(req); if (!userId) return res.status(401).json({ error: "Unauthorized" }); req.userId = userId; next(); }
function author(userId, user) { return { userId, username: user?.username || DEFAULT_AUTHOR, imageUrl: user?.imageUrl || "" }; }
function publicBoardId(value) {
  const boardId = String(value || "").trim().toLowerCase();
  return Board.isBoardId(boardId) ? boardId : "";
}
// Batched, cached Clerk lookups. Pass refresh for the viewer's own profile so a
// rename shows up there immediately.
function authors(ids, { refresh } = {}) { return lookupAuthors(ids, { refresh }); }
function spotifyProfile(value) {
  const input = typeof value === "string" ? value.trim() : "";
  if (!input) return "";
  try { const url = new URL(input); if (url.protocol === "https:" && url.hostname === "open.spotify.com" && url.pathname.startsWith("/user/") && url.pathname.length > 6) return url.toString(); } catch { /* invalid */ }
  return null;
}
async function getProfile(userId) {
  return UserProfile.findOne({ userId })
    .populate("favoriteAlbums.albumCatalogId")
    .populate({ path: "pinnedReviewId", populate: { path: "albumCatalogId" } })
    .populate("pinnedBoardId");
}
async function ensureProfile(userId) {
  return (await getProfile(userId)) || UserProfile.create({ userId });
}
async function updateProfile(userId, update, session) {
  return UserProfile.findOneAndUpdate(
    { userId },
    { $set: { userId, ...update } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true, ...(session ? { session } : {}) },
  );
}
// Totals cover every review, not just the page a profile has loaded.
async function reviewStats(userId) {
  const [row] = await Review.aggregate([
    { $match: { userId } },
    { $group: { _id: null, reviewCount: { $sum: 1 }, averageRating: { $avg: "$rating" } } },
  ]);
  const reviewCount = Number(row?.reviewCount) || 0;
  return { reviewCount, averageRating: reviewCount ? Number(row.averageRating) : null };
}
async function socialStats(userId, viewerId) {
  const [followerCount, followingCount, isFollowing, reviews] = await Promise.all([
    Follow.countDocuments({ followingId: userId }),
    Follow.countDocuments({ followerId: userId }),
    viewerId && viewerId !== userId ? Follow.exists({ followerId: viewerId, followingId: userId }) : false,
    reviewStats(userId),
  ]);
  return { followerCount, followingCount, ...reviews, isFollowing: Boolean(isFollowing), isCurrentUser: viewerId === userId };
}
async function formatBoard(board) {
  return libraryBoard(board, { albums: true });
}
// The most recently saved distinct albums, newest save first. Only the albums
// the activity feed can show are joined to the catalog; deleted albums are
// skipped without shortening the list.
async function recentExplicitSaves(userId, limit = MAX_ACTIVITY) {
  const rows = await rankCurrent(BoardItem, (size) => [
    { $match: { userId } },
    { $sort: { savedAt: -1, _id: -1 } },
    { $group: { _id: "$albumCatalogId", savedAt: { $first: "$savedAt" } } },
    { $sort: { savedAt: -1, _id: -1 } },
    { $limit: size },
    ...currentCatalogStages("_id"),
  ], limit);
  return rows.map((row) => ({ ...normalizeCatalogAlbum(row.catalogAlbum), savedAt: row.savedAt, userId })).filter((album) => album.albumId);
}
async function formatReview(review) {
  const source = plain(review);
  const album = source.albumCatalogId && typeof source.albumCatalogId === "object" ? normalizeCatalogAlbum(source.albumCatalogId) : null;
  return { reviewId: persistedReviewId(source), userId: source.userId, albumId: album?.albumId || "", album, rating: source.rating, reviewText: source.reviewText, date: source.date };
}
async function formatProfile(profile, viewerId = "") {
  const source = plain(profile);
  const favoriteAlbums = [...(source.favoriteAlbums || [])].sort((a, b) => a.rank - b.rank).map((item) => normalizeCatalogAlbum(item.albumCatalogId)).filter(Boolean);
  const [userMap, { upNext, queueCount }, pinnedReview, pinnedBoard] = await Promise.all([
    authors([source.userId], { refresh: source.userId === viewerId ? [viewerId] : [] }),
    queuePreview(source),
    source.pinnedReviewId && typeof source.pinnedReviewId === "object" ? formatReview(source.pinnedReviewId) : null,
    source.pinnedBoardId && typeof source.pinnedBoardId === "object" ? formatBoard(source.pinnedBoardId) : null,
  ]);
  return { userId: source.userId, username: userMap.get(source.userId)?.username || DEFAULT_AUTHOR, imageUrl: userMap.get(source.userId)?.imageUrl || "", bio: source.bio || "", spotifyProfileUrl: source.spotifyProfileUrl || "", isPrivate: Boolean(source.isPrivate), favoriteAlbums, listeningNextAlbum: upNext[0] || null, upNext, queueCount, pinnedReview, pinnedBoard };
}
async function formatPrivateProfile(profile) {
  const source = plain(profile);
  const userMap = await authors([source.userId]);
  const user = userMap.get(source.userId) || author(source.userId);
  return {
    userId: source.userId,
    username: user.username,
    imageUrl: user.imageUrl,
    bio: "",
    spotifyProfileUrl: "",
    isPrivate: true,
    favoriteAlbums: [],
    listeningNextAlbum: null,
    upNext: [],
    queueCount: 0,
    pinnedReview: null,
    pinnedBoard: null,
  };
}
// The profile and its social counts load in parallel.
async function profileResponse(profile, userId, viewerId, { hidden = false } = {}) {
  const [formatted, stats] = await Promise.all([hidden ? formatPrivateProfile(profile) : formatProfile(profile, viewerId), socialStats(userId, viewerId)]);
  return { ...formatted, ...stats };
}
async function followable(userId) { if (Review.isDeletedAuthor(userId)) return false; return Boolean(await UserProfile.exists({ userId }) || await Review.exists({ userId })); }
async function profileAccess(target, viewerId) { if (!(await followable(target))) return { status: 404, body: { error: "User not found" } }; const profile = await ensureProfile(target); if (profile.isPrivate && target !== viewerId) return { status: 403, body: PRIVATE_ERROR, profile }; return { status: 200, profile }; }
async function activity(userId, includePrivate = false, viewerId = "") {
  const [profileAuthors, reviews, saved, listens, rankings, commentActivities] = await Promise.all([authors([userId]), Review.find({ userId }).populate("albumCatalogId").sort({ date: -1, _id: -1 }).limit(MAX_ACTIVITY), includePrivate ? recentExplicitSaves(userId) : [], getListenActivity([userId], MAX_ACTIVITY), getRankingActivity([userId], MAX_ACTIVITY), getCommentActivity([userId], MAX_ACTIVITY, authors)]);
  const actor = profileAuthors.get(userId) || author(userId);
  const comments = await commentCounts(reviews.map((review) => review._id));
  const reviewActivities = reviews.map((review) => { const source = plain(review); const reviewId = persistedReviewId(source); const album = source.albumCatalogId ? normalizeCatalogAlbum(source.albumCatalogId) : null; return { id: reviewId, reviewId, type: "review", actor, userId, createdAt: source.date, album, rating: source.rating, reviewText: source.reviewText, commentCount: comments.get(String(source._id)) || 0 }; });
  const savedActivities = saved.map((album) => ({ id: `saved-${userId}-${album.albumId}`, type: "saved_album", actor, userId, createdAt: album.savedAt, album }));
  return [...reviewActivities, ...listens.map((listen) => ({ ...listen, actor })), ...rankings.map((ranking) => ({ ...ranking, actor })), ...(includePrivate ? savedActivities : []), ...commentActivities.map((item) => ({ ...item, actor }))].sort(compareActivity).slice(0, MAX_ACTIVITY);
}

router.get("/me", auth, async (req, res) => { try { const profile = await ensureProfile(req.userId); res.json(await profileResponse(profile, req.userId, req.userId)); } catch { res.status(500).json({ error: "Failed to fetch profile" }); } });
router.get("/me/saved", auth, async (req, res) => { try { res.json(await getSavedAlbums(req.userId)); } catch { res.status(500).json({ error: "Failed to fetch saved albums" }); } });
function sendStatsError(res, error) {
  res.status(error.status || 500).json({ error: error.status ? error.message : "Failed to fetch stats", ...(error.status && error.code ? { code: error.code } : {}) });
}
router.get("/me/stats", auth, profileStatsRateLimit, async (req, res) => {
  try { res.json(await listeningStats(req.userId, req.query)); }
  catch (error) { sendStatsError(res, error); }
});
function sendQueueError(res, error, fallback) {
  res.status(error.status || 500).json({ error: error.status ? error.message : fallback, ...(error.status && error.code ? { code: error.code } : {}) });
}
router.get("/me/queue", auth, async (req, res) => {
  try { res.json(await readQueue(req.userId, { includeRevision: true })); }
  catch (error) { sendQueueError(res, error, "Failed to fetch queue"); }
});
router.post("/me/queue", auth, queueMutationRateLimit, async (req, res) => {
  try { res.json(await addToQueue(req.userId, req.body)); }
  catch (error) { sendQueueError(res, error, "Failed to update queue"); }
});
router.put("/me/queue", auth, queueMutationRateLimit, async (req, res) => {
  try { res.json(await reorderQueue(req.userId, req.body)); }
  catch (error) { sendQueueError(res, error, "Failed to update queue"); }
});
router.delete("/me/queue/:albumId", auth, queueMutationRateLimit, async (req, res) => {
  try { res.json(await removeFromQueue(req.userId, req.params.albumId)); }
  catch (error) { sendQueueError(res, error, "Failed to update queue"); }
});
router.get("/me/activity", auth, async (req, res) => { try { res.json(await activity(req.userId, true, req.userId)); } catch { res.status(500).json({ error: "Failed to fetch activity" }); } });
router.get("/me/network", auth, async (req, res) => {
  try {
    res.json(await getNetworkActivity(req.userId, (ids) => authors(ids, { limit: NETWORK_ACTIVITY_LIMIT })));
  } catch {
    res.status(500).json({ error: "Failed to fetch network activity" });
  }
});
router.get("/me/social", auth, async (req, res) => { try { const [followers, following] = await Promise.all([Follow.find({ followingId: req.userId }), Follow.find({ followerId: req.userId })]); const [followerMap, followingMap] = await Promise.all([authors(followers.map((row) => plain(row).followerId)), authors(following.map((row) => plain(row).followingId))]); res.json({ userId: req.userId, followers: followers.map((row) => followerMap.get(plain(row).followerId)), following: following.map((row) => followingMap.get(plain(row).followingId)), followerCount: followers.length, followingCount: following.length }); } catch { res.status(500).json({ error: "Failed to fetch network" }); } });

router.put("/me", auth, async (req, res) => {
  try {
    const bio = typeof req.body.bio === "string" ? req.body.bio.trim() : "";
    const profileUrl = spotifyProfile(req.body.spotifyProfileUrl);
    const favoriteIds = Array.isArray(req.body.favoriteAlbumIds) ? [...new Set(req.body.favoriteAlbumIds.map((id) => String(id).trim()).filter(Boolean))] : [];
    if (bio.length > 280) return res.status(400).json({ error: "Bio must be 280 characters or fewer" });
    if (profileUrl === null) return res.status(400).json({ error: "Spotify profile must be an https://open.spotify.com/user/... URL" });
    if (favoriteIds.length > MAX_FAVORITES) return res.status(400).json({ error: "Choose up to five favorite albums" });
    const favorites = await Promise.all(favoriteIds.map(async (albumId, rank) => ({ albumCatalogId: (await findAlbumByPublicId(albumId))._id, rank })));
    const pinnedReviewId = String(req.body.pinnedReviewId || "").trim(); const pinnedBoardId = String(req.body.pinnedBoardId || "").trim();
    if (pinnedReviewId && !isReviewId(pinnedReviewId)) return res.status(400).json({ error: "Pinned review must belong to your profile", code: "INVALID_PINNED_REVIEW" });
    const boardId = pinnedBoardId ? publicBoardId(pinnedBoardId) : "";
    const pinnedBoard = boardId ? await Board.findOne({ boardId, userId: req.userId }) : null;
    if (pinnedBoardId && !pinnedBoard) return res.status(400).json({ error: "Pinned board must belong to your profile" });
    const update = { bio, spotifyProfileUrl: profileUrl, favoriteAlbums: favorites, pinnedReviewId: null, pinnedBoardId: pinnedBoard?._id || null };
    let profile;
    if (pinnedBoardId) {
      await transaction("BOARD", async (session) => {
        const board = await claimBoard(req.userId, boardId, session);
        const pinnedReview = pinnedReviewId ? await assertPinnedReview(pinnedReviewId, req.userId, session) : null;
        profile = await updateProfile(req.userId, { ...update, pinnedBoardId: board._id, pinnedReviewId: pinnedReview?._id || null }, session);
      });
    } else if (pinnedReviewId) {
      await runReviewTransaction("pin", async (session) => {
        const pinnedReview = await assertPinnedReview(pinnedReviewId, req.userId, session);
        profile = await updateProfile(req.userId, { ...update, pinnedReviewId: pinnedReview._id }, session);
      });
    } else {
      await updateProfile(req.userId, update);
    }
    profile = await getProfile(req.userId);
    res.json(await profileResponse(profile, req.userId, req.userId));
  } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : "Failed to update profile", ...(error.code ? { code: error.code } : {}) }); }
});
router.patch("/me", auth, async (req, res) => { try { if (typeof req.body.isPrivate !== "boolean") return res.status(400).json({ error: "isPrivate must be true or false" }); const profile = await UserProfile.findOneAndUpdate({ userId: req.userId }, { $set: { userId: req.userId, isPrivate: req.body.isPrivate } }, { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }).populate("favoriteAlbums.albumCatalogId").populate({ path: "pinnedReviewId", populate: { path: "albumCatalogId" } }).populate("pinnedBoardId"); res.json(await profileResponse(profile, req.userId, req.userId)); } catch { res.status(500).json({ error: "Failed to update profile" }); } });

router.get("/me/notification-preferences", auth, async (req, res) => {
  try { res.json(serializePreferences(await UserProfile.findOne({ userId: req.userId }, { notificationPreferences: 1 }).lean())); } catch { res.status(500).json({ error: "Failed to fetch notification preferences" }); }
});
router.patch("/me/notification-preferences", auth, notificationMutationRateLimit, async (req, res) => {
  try {
    const set = normalizePreferencesPatch(req.body);
    const profile = await UserProfile.findOneAndUpdate(
      { userId: req.userId },
      { $set: set, $setOnInsert: { userId: req.userId } },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true, projection: { notificationPreferences: 1 } },
    ).lean();
    res.json(serializePreferences(profile));
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ error: error.message, code: error.code });
    res.status(500).json({ error: "Failed to update notification preferences" });
  }
});
// Registered before the /:userId routes so "suggestions" is not read as a user ID.
router.get("/suggestions", async (req, res) => {
  try { res.json({ people: await suggestPeople({ viewerId: viewer(req), limit: req.query.limit, authors }) }); }
  catch { res.status(500).json({ error: "Failed to fetch suggestions" }); }
});

router.put("/:userId/follow", auth, async (req, res) => { try { const target = String(req.params.userId || "").trim(); if (target === req.userId) return res.status(400).json({ error: "You cannot follow yourself" }); if (typeof req.body.following !== "boolean") return res.status(400).json({ error: "following must be true or false" }); if (!(await followable(target))) return res.status(404).json({ error: "User not found" }); if (req.body.following) { await Follow.updateOne({ followerId: req.userId, followingId: target }, { $setOnInsert: { followerId: req.userId, followingId: target } }, { upsert: true }); await recordFollow({ recipientUserId: target, actorUserId: req.userId }); } else await Follow.deleteOne({ followerId: req.userId, followingId: target }); res.json({ targetUserId: target, ...(await socialStats(target, req.userId)) }); } catch { res.status(500).json({ error: "Failed to update follow status" }); } });

for (const path of ["/:userId/diary", "/:userId/boards/:boardId/albums/:albumId/listens"]) {
  router.get(path, async (req, res) => {
    try {
      const access = await profileAccess(req.params.userId, viewer(req));
      if (access.status !== 200) return res.status(access.status).json(access.body);
      const fixed = req.params.boardId ? { boardId: req.params.boardId, albumId: req.params.albumId } : {};
      res.json(await listListens(req.params.userId, req.query, fixed));
    } catch (error) {
      res.status(error.status || 500).json({ error: error.status ? error.message : "Failed to fetch diary", ...(error.status && error.code ? { code: error.code } : {}) });
    }
  });
}

router.get("/:userId/diary/calendar", async (req, res) => {
  try {
    const access = await profileAccess(req.params.userId, viewer(req));
    if (access.status !== 200) return res.status(access.status).json(access.body);
    res.json(await listenCalendar(req.params.userId, req.query));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.status ? error.message : "Failed to fetch diary", ...(error.status && error.code ? { code: error.code } : {}) });
  }
});
router.get("/:userId/stats", profileStatsRateLimit, async (req, res) => {
  try {
    const access = await profileAccess(req.params.userId, viewer(req));
    if (access.status !== 200) return res.status(access.status).json(access.body);
    res.json(await listeningStats(req.params.userId, req.query));
  } catch (error) { sendStatsError(res, error); }
});
router.get("/:userId/queue", async (req, res) => {
  try {
    const access = await profileAccess(req.params.userId, viewer(req));
    if (access.status !== 200) return res.status(access.status).json(access.body);
    res.json(await readQueue(req.params.userId));
  } catch (error) { sendQueueError(res, error, "Failed to fetch queue"); }
});
router.get("/:userId/rankings", async (req, res) => {
  try {
    const access = await profileAccess(req.params.userId, viewer(req));
    if (access.status !== 200) return res.status(access.status).json(access.body);
    res.json(await listUserRankings(req.params.userId, req.query));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.status ? error.message : "Failed to fetch rankings", ...(error.status && error.code ? { code: error.code } : {}) });
  }
});
router.get("/:userId/boards/:boardId", async (req, res) => { try { const access = await profileAccess(req.params.userId, viewer(req)); if (access.status !== 200) return res.status(access.status).json(access.body); const requestedBoardId = String(req.params.boardId || "").trim().toLowerCase(); const board = requestedBoardId === "default" ? await Board.findOne({ userId: req.params.userId, isDefault: true }) : await Board.findOne({ boardId: publicBoardId(requestedBoardId), userId: req.params.userId }); if (!board) return res.status(404).json({ error: "Board not found" }); res.json(await formatBoard(board)); } catch { res.status(500).json({ error: "Failed to fetch board" }); } });
router.get("/:userId/boards", async (req, res) => { try { const access = await profileAccess(req.params.userId, viewer(req)); if (access.status !== 200) return res.status(access.status).json(access.body); res.json(await formatBoards(await Board.find({ userId: req.params.userId }).sort({ isDefault: -1, updatedAt: -1 }), { albums: true })); } catch { res.status(500).json({ error: "Failed to fetch boards" }); } });
router.get("/:userId/network", async (req, res) => { try { const access = await profileAccess(req.params.userId, viewer(req)); if (access.status !== 200) return res.status(access.status).json(access.body); const [followers, following] = await Promise.all([Follow.find({ followingId: req.params.userId }), Follow.find({ followerId: req.params.userId })]); const [fm, nm] = await Promise.all([authors(followers.map((row) => plain(row).followerId)), authors(following.map((row) => plain(row).followingId))]); res.json({ userId: req.params.userId, followers: followers.map((row) => fm.get(plain(row).followerId)), following: following.map((row) => nm.get(plain(row).followingId)), followerCount: followers.length, followingCount: following.length }); } catch { res.status(500).json({ error: "Failed to fetch network" }); } });
router.get("/:userId/activity", async (req, res) => { try { const access = await profileAccess(req.params.userId, viewer(req)); if (access.status !== 200) return res.status(access.status).json(access.body); res.json(await activity(req.params.userId, true, viewer(req))); } catch { res.status(500).json({ error: "Failed to fetch activity" }); } });
router.get("/:userId/saved", async (req, res) => { try { const access = await profileAccess(req.params.userId, viewer(req)); if (access.status !== 200) return res.status(access.status).json(access.body); res.json(await getSavedAlbums(req.params.userId)); } catch { res.status(500).json({ error: "Failed to fetch saved albums" }); } });
router.get("/:userId", async (req, res) => { try { const target = String(req.params.userId || ""); if (!(await followable(target))) return res.status(404).json({ error: "User not found" }); const profile = await ensureProfile(target); if (profile.isPrivate && viewer(req) !== target) return res.json(await profileResponse(profile, target, viewer(req), { hidden: true })); res.json(await profileResponse(profile, target, viewer(req))); } catch { res.status(500).json({ error: "Failed to fetch profile" }); } });

module.exports = router;
