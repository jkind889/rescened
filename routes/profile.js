const crypto = require("node:crypto");
const express = require("express");
const { clerkClient, getAuth } = require("@clerk/express");
const UserProfile = require("../models/UserProfile");
const Follow = require("../models/Follow");
const Review = require("../models/Reviews");
const Board = require("../models/Board");
const BoardItem = require("../models/BoardItem");
const Like = require("../models/Like");
const Notification = require("../models/Notification");
const { findAlbumByPublicId, normalizeCatalogAlbum } = require("./utils/albumCatalog");
const { runReviewTransaction, assertPinnedReview, isReviewId, persistedReviewId } = require("./utils/reviewInteractions");
const { NETWORK_ACTIVITY_LIMIT, getNetworkActivity } = require("./utils/networkActivity");
const { formatBoard: libraryBoard, savedAlbums: getSavedAlbums } = require("./utils/boardLibrary");
const { transaction, claimBoard } = require("./utils/boardMutations");
const { listListens } = require("./utils/listeningDiary");

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
async function authors(ids, options = {}) {
  const map = new Map([...new Set(ids.filter(Boolean))].map((id) => [id, author(id)]));
  try { const listed = await clerkClient.users.getUserList({ ...options, userId: [...map.keys()] }); const users = Array.isArray(listed) ? listed : listed.data || []; users.forEach((user) => map.set(user.id, author(user.id, user))); } catch { /* optional */ }
  return map;
}
function spotifyProfile(value) {
  const input = typeof value === "string" ? value.trim() : "";
  if (!input) return "";
  try { const url = new URL(input); if (url.protocol === "https:" && url.hostname === "open.spotify.com" && url.pathname.startsWith("/user/") && url.pathname.length > 6) return url.toString(); } catch { /* invalid */ }
  return null;
}
async function getProfile(userId) {
  return UserProfile.findOne({ userId })
    .populate("favoriteAlbums.albumCatalogId")
    .populate("listeningNextAlbum.albumCatalogId")
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
async function socialStats(userId, viewerId) {
  const [followerCount, followingCount, isFollowing] = await Promise.all([
    Follow.countDocuments({ followingId: userId }),
    Follow.countDocuments({ followerId: userId }),
    viewerId && viewerId !== userId ? Follow.exists({ followerId: viewerId, followingId: userId }) : false,
  ]);
  return { followerCount, followingCount, isFollowing: Boolean(isFollowing), isCurrentUser: viewerId === userId };
}
async function formatBoard(board) {
  return libraryBoard(board, true);
}
function formatItem(item) {
  const source = plain(item); const album = source.albumCatalogId;
  const normalized = album && typeof album === "object" ? normalizeCatalogAlbum(album) : null;
  return normalized?.albumId ? { ...normalized, savedAt: source.savedAt, userId: source.userId } : null;
}
async function getExplicitSavedAlbums(userId) {
  const items = await BoardItem.find({ userId }).populate("albumCatalogId").sort({ savedAt: -1 });
  const seen = new Set();
  return items.map(formatItem).filter(Boolean).filter((album) => { if (!album.albumId || seen.has(album.albumId)) return false; seen.add(album.albumId); return true; });
}
async function formatReview(review) {
  const source = plain(review);
  const album = source.albumCatalogId && typeof source.albumCatalogId === "object" ? normalizeCatalogAlbum(source.albumCatalogId) : null;
  return { reviewId: persistedReviewId(source), userId: source.userId, albumId: album?.albumId || "", album, rating: source.rating, reviewText: source.reviewText, date: source.date };
}
async function formatProfile(profile) {
  const source = plain(profile); const userMap = await authors([source.userId]);
  const favoriteAlbums = [...(source.favoriteAlbums || [])].sort((a, b) => a.rank - b.rank).map((item) => normalizeCatalogAlbum(item.albumCatalogId)).filter(Boolean);
  const listeningNextAlbum = source.listeningNextAlbum?.albumCatalogId ? normalizeCatalogAlbum(source.listeningNextAlbum.albumCatalogId) : null;
  let pinnedReview = null;
  if (source.pinnedReviewId && typeof source.pinnedReviewId === "object") pinnedReview = await formatReview(source.pinnedReviewId);
  const pinnedBoard = source.pinnedBoardId && typeof source.pinnedBoardId === "object" ? await formatBoard(source.pinnedBoardId) : null;
  return { userId: source.userId, username: userMap.get(source.userId)?.username || DEFAULT_AUTHOR, imageUrl: userMap.get(source.userId)?.imageUrl || "", bio: source.bio || "", spotifyProfileUrl: source.spotifyProfileUrl || "", isPrivate: Boolean(source.isPrivate), favoriteAlbums, listeningNextAlbum, pinnedReview, pinnedBoard };
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
    pinnedReview: null,
    pinnedBoard: null,
  };
}
async function followable(userId) { return Boolean(await UserProfile.exists({ userId }) || await Review.exists({ userId })); }
async function profileAccess(target, viewerId) { if (!(await followable(target))) return { status: 404, body: { error: "User not found" } }; const profile = await ensureProfile(target); if (profile.isPrivate && target !== viewerId) return { status: 403, body: PRIVATE_ERROR, profile }; return { status: 200, profile }; }
async function activity(userId, includePrivate = false, viewerId = "") {
  const profileAuthors = await authors([userId]); const actor = profileAuthors.get(userId) || author(userId);
  const [reviews, saved] = await Promise.all([Review.find({ userId }).populate("albumCatalogId").sort({ date: -1 }).limit(MAX_ACTIVITY), getExplicitSavedAlbums(userId)]);
  const reviewActivities = reviews.map((review) => { const source = plain(review); const reviewId = persistedReviewId(source); const album = source.albumCatalogId ? normalizeCatalogAlbum(source.albumCatalogId) : null; return { id: reviewId, reviewId, type: "review", actor, userId, createdAt: source.date, album, rating: source.rating, reviewText: source.reviewText }; });
  const savedActivities = saved.map((album) => ({ id: `saved-${userId}-${album.albumId}`, type: "saved_album", actor, userId, createdAt: album.savedAt, album }));
  return [...reviewActivities, ...(includePrivate ? savedActivities : [])].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, MAX_ACTIVITY);
}

router.get("/me", auth, async (req, res) => { try { const profile = await ensureProfile(req.userId); res.json({ ...(await formatProfile(profile)), ...(await socialStats(req.userId, req.userId)) }); } catch { res.status(500).json({ error: "Failed to fetch profile" }); } });
router.get("/me/saved", auth, async (req, res) => { try { res.json(await getSavedAlbums(req.userId)); } catch { res.status(500).json({ error: "Failed to fetch saved albums" }); } });
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
    const nextAlbum = req.body.listeningNextAlbumId ? { albumCatalogId: (await findAlbumByPublicId(req.body.listeningNextAlbumId))._id } : null;
    const pinnedReviewId = String(req.body.pinnedReviewId || "").trim(); const pinnedBoardId = String(req.body.pinnedBoardId || "").trim();
    if (pinnedReviewId && !isReviewId(pinnedReviewId)) return res.status(400).json({ error: "Pinned review must belong to your profile", code: "INVALID_PINNED_REVIEW" });
    const boardId = pinnedBoardId ? publicBoardId(pinnedBoardId) : "";
    const pinnedBoard = boardId ? await Board.findOne({ boardId, userId: req.userId }) : null;
    if (pinnedBoardId && !pinnedBoard) return res.status(400).json({ error: "Pinned board must belong to your profile" });
    const update = { bio, spotifyProfileUrl: profileUrl, favoriteAlbums: favorites, listeningNextAlbum: nextAlbum, pinnedReviewId: null, pinnedBoardId: pinnedBoard?._id || null };
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
    res.json({ ...(await formatProfile(profile)), ...(await socialStats(req.userId, req.userId)) });
  } catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : "Failed to update profile", ...(error.code ? { code: error.code } : {}) }); }
});
router.patch("/me", auth, async (req, res) => { try { if (typeof req.body.isPrivate !== "boolean") return res.status(400).json({ error: "isPrivate must be true or false" }); const profile = await UserProfile.findOneAndUpdate({ userId: req.userId }, { $set: { userId: req.userId, isPrivate: req.body.isPrivate } }, { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }).populate("favoriteAlbums.albumCatalogId").populate("listeningNextAlbum.albumCatalogId").populate({ path: "pinnedReviewId", populate: { path: "albumCatalogId" } }).populate("pinnedBoardId"); res.json({ ...(await formatProfile(profile)), ...(await socialStats(req.userId, req.userId)) }); } catch { res.status(500).json({ error: "Failed to update profile" }); } });

router.put("/:userId/follow", auth, async (req, res) => { try { const target = String(req.params.userId || "").trim(); if (target === req.userId) return res.status(400).json({ error: "You cannot follow yourself" }); if (typeof req.body.following !== "boolean") return res.status(400).json({ error: "following must be true or false" }); if (!(await followable(target))) return res.status(404).json({ error: "User not found" }); if (req.body.following) { await Follow.updateOne({ followerId: req.userId, followingId: target }, { $setOnInsert: { followerId: req.userId, followingId: target } }, { upsert: true }); await Notification.updateOne({ recipientUserId: target, actorUserId: req.userId, type: "follow" }, { $setOnInsert: { notificationId: crypto.randomUUID(), recipientUserId: target, actorUserId: req.userId, type: "follow" } }, { upsert: true }); } else await Follow.deleteOne({ followerId: req.userId, followingId: target }); res.json({ targetUserId: target, ...(await socialStats(target, req.userId)) }); } catch { res.status(500).json({ error: "Failed to update follow status" }); } });

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

router.get("/:userId/boards/:boardId", async (req, res) => { try { const access = await profileAccess(req.params.userId, viewer(req)); if (access.status !== 200) return res.status(access.status).json(access.body); const requestedBoardId = String(req.params.boardId || "").trim().toLowerCase(); const board = requestedBoardId === "default" ? await Board.findOne({ userId: req.params.userId, isDefault: true }) : await Board.findOne({ boardId: publicBoardId(requestedBoardId), userId: req.params.userId }); if (!board) return res.status(404).json({ error: "Board not found" }); res.json(await formatBoard(board)); } catch { res.status(500).json({ error: "Failed to fetch board" }); } });
router.get("/:userId/boards", async (req, res) => { try { const access = await profileAccess(req.params.userId, viewer(req)); if (access.status !== 200) return res.status(access.status).json(access.body); res.json(await Promise.all((await Board.find({ userId: req.params.userId }).sort({ isDefault: -1, updatedAt: -1 })).map(formatBoard))); } catch { res.status(500).json({ error: "Failed to fetch boards" }); } });
router.get("/:userId/network", async (req, res) => { try { const access = await profileAccess(req.params.userId, viewer(req)); if (access.status !== 200) return res.status(access.status).json(access.body); const [followers, following] = await Promise.all([Follow.find({ followingId: req.params.userId }), Follow.find({ followerId: req.params.userId })]); const [fm, nm] = await Promise.all([authors(followers.map((row) => plain(row).followerId)), authors(following.map((row) => plain(row).followingId))]); res.json({ userId: req.params.userId, followers: followers.map((row) => fm.get(plain(row).followerId)), following: following.map((row) => nm.get(plain(row).followingId)), followerCount: followers.length, followingCount: following.length }); } catch { res.status(500).json({ error: "Failed to fetch network" }); } });
router.get("/:userId/activity", async (req, res) => { try { const access = await profileAccess(req.params.userId, viewer(req)); if (access.status !== 200) return res.status(access.status).json(access.body); res.json(await activity(req.params.userId, true, viewer(req))); } catch { res.status(500).json({ error: "Failed to fetch activity" }); } });
router.get("/:userId/saved", async (req, res) => { try { const access = await profileAccess(req.params.userId, viewer(req)); if (access.status !== 200) return res.status(access.status).json(access.body); res.json(await getSavedAlbums(req.params.userId)); } catch { res.status(500).json({ error: "Failed to fetch saved albums" }); } });
router.get("/:userId", async (req, res) => { try { const target = String(req.params.userId || ""); if (!(await followable(target))) return res.status(404).json({ error: "User not found" }); const profile = await ensureProfile(target); if (profile.isPrivate && viewer(req) !== target) return res.json({ ...(await formatPrivateProfile(profile)), ...(await socialStats(target, viewer(req))) }); res.json({ ...(await formatProfile(profile)), ...(await socialStats(target, viewer(req))) }); } catch { res.status(500).json({ error: "Failed to fetch profile" }); } });

module.exports = router;
