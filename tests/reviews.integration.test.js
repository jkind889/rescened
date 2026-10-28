const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const AlbumCatalog = require("../models/AlbumCatalog");
const Review = require("../models/Reviews");
const Like = require("../models/Like");
const Notification = require("../models/Notification");
const UserProfile = require("../models/UserProfile");
const Follow = require("../models/Follow");
const { createCatalogAlbum } = require("../routes/utils/albumCatalog");
const {
  rankedAlbums,
  recentlyReviewedAlbums,
  featuredAlbums,
  popularReviewRows,
  resetFeedCache,
} = require("../routes/utils/reviewFeeds");
const {
  deleteOwnedReview,
  mutateReviewLike,
  assertReviewId,
  REVIEW_ID_V4,
  runReviewTransaction,
  ReviewTransactionUnavailableError,
  assertPinnedReview,
} = require("../routes/utils/reviewInteractions");

const enabled = String(process.env.RUN_MONGO_INTEGRATION || "").toLowerCase() === "true";
let replSet;

async function createAlbum(title) {
  return createCatalogAlbum({
    albumId: crypto.randomUUID(),
    title,
    artistDisplayName: "Integration Artist",
    artistCredits: [{ name: "Integration Artist", role: "main" }],
    releaseDate: "2026",
    releaseDatePrecision: "year",
    releaseYear: 2026,
    tracks: [],
  });
}

async function createReview(album, userId, rating, date) {
  return Review.create({ userId, albumCatalogId: album._id, rating, reviewText: `${userId} review`, date });
}

function reviewFeedClient(t, viewerId) {
  const clerkPath = require.resolve("@clerk/express");
  const routePath = require.resolve("../routes/reviews");
  const oldClerk = require.cache[clerkPath];
  const oldRoute = require.cache[routePath];
  require.cache[clerkPath] = {
    id: clerkPath, filename: clerkPath, loaded: true,
    exports: {
      getAuth: () => ({ userId: viewerId }),
      clerkClient: { users: { getUserList: async () => ({ data: [] }) } },
    },
  };
  delete require.cache[routePath];
  const router = require(routePath);
  t.after(() => {
    if (oldClerk) require.cache[clerkPath] = oldClerk;
    else delete require.cache[clerkPath];
    if (oldRoute) require.cache[routePath] = oldRoute;
    else delete require.cache[routePath];
  });
  return async (path, params, query) => {
    const layer = router.stack.find((item) => item.route?.path === path && item.route.methods.get);
    const res = {
      statusCode: 200,
      headers: {},
      set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await layer.route.stack.at(-1).handle({ userId: viewerId, params, query }, res);
    return { status: res.statusCode, headers: res.headers, ...res.body };
  };
}

test.before(async () => {
  if (!enabled) return;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: "rescened_reviews" });
  await Promise.all([
    AlbumCatalog.syncIndexes(),
    Review.syncIndexes(),
    Like.syncIndexes(),
    Notification.syncIndexes(),
    UserProfile.syncIndexes(),
    Follow.syncIndexes(),
  ]);
});
test.after(async () => {
  if (!enabled) return;
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await replSet.stop();
});

test("review discovery aggregates use catalog order, windows, deduplication, and like ranking", { skip: !enabled }, async () => {
  const now = new Date("2026-09-03T12:00:00.000Z");
  const [first, second, third, fourth, fifth, missing] = await Promise.all([
    createAlbum("First"),
    createAlbum("Second"),
    createAlbum("Third"),
    createAlbum("Fourth"),
    createAlbum("Fifth"),
    createAlbum("Missing"),
  ]);
  await Promise.all([
    createReview(first, "u1", 5, new Date("2026-09-02T00:00:00Z")),
    createReview(first, "u2", 4, new Date("2026-08-01T00:00:00Z")),
    createReview(second, "u3", 5, new Date("2026-09-01T00:00:00Z")),
    createReview(third, "u5", 4, new Date("2026-08-31T00:00:00Z")),
    createReview(fourth, "u6", 4, new Date("2026-08-30T00:00:00Z")),
    createReview(fifth, "u7", 4, new Date("2026-08-29T00:00:00Z")),
    createReview(missing, "u4", 5, new Date("2026-09-03T00:00:00Z")),
  ]);
  await AlbumCatalog.deleteOne({ _id: missing._id });
  const recent = await recentlyReviewedAlbums(2);
  assert.deepEqual(recent.map((album) => album.title), ["First", "Second"]);
  assert.ok(recent[0].latestReviewDate);

  const popular = await rankedAlbums({ limit: 5, window: "7d", now });
  assert.equal(popular.length, 5);
  assert.equal(popular.some((album) => album.title === "Missing"), false);
  assert.equal(popular[0].reviewCount, 1);
  assert.equal(popular[0].averageRating, 5);
  assert.ok(popular[0].popularityScore > 0);

  const featured = await featuredAlbums(5);
  assert.equal(featured.length, 5);
  assert.equal(featured.some((album) => album.title === "Missing"), false);

  const firstReview = await Review.findOne({ albumCatalogId: first._id }).sort({ date: -1 });
  const secondReview = await Review.findOne({ albumCatalogId: second._id });
  await Like.create([
    { userId: "liker-1", targetType: "review", reviewId: firstReview._id },
    { userId: "liker-2", targetType: "review", reviewId: firstReview._id },
  ]);
  const popularReviews = await popularReviewRows(12);
  assert.equal(String(popularReviews[0]._id), String(firstReview._id));
  assert.equal(popularReviews.length, 6);
  assert.equal(popularReviews.some((row) => String(row.albumCatalogId) === String(missing._id)), false);
  assert.ok(popularReviews.some((row) => String(row._id) === String(secondReview._id)));
});

test("circle feeds only rank the viewer and accounts they follow", { skip: !enabled }, async (t) => {
  const [shared, friendOnly, strangerOnly] = await Promise.all([
    createAlbum("Circle Shared"),
    createAlbum("Circle Friend"),
    createAlbum("Circle Stranger"),
  ]);
  const now = new Date();
  const [, , friendReview, strangerReview] = await Promise.all([
    createReview(shared, "circle-viewer", 5, now),
    createReview(shared, "circle-friend", 4, now),
    createReview(friendOnly, "circle-friend", 3, now),
    createReview(strangerOnly, "circle-stranger", 5, now),
  ]);
  await Follow.create([
    { followerId: "circle-viewer", followingId: "circle-friend" },
    { followerId: "circle-stranger", followingId: "circle-viewer" },
  ]);
  await Like.create([
    { userId: "liker-circle", targetType: "review", reviewId: strangerReview._id },
    { userId: "liker-circle", targetType: "review", reviewId: friendReview._id },
  ]);
  const request = reviewFeedClient(t, "circle-viewer");

  const popular = await request("/circle/popular", {}, { limit: "10", window: "all" });
  assert.equal(popular.status, 200);
  const albums = Object.values(popular).filter((row) => row?.albumId);
  assert.deepEqual(albums.map((album) => album.title).sort(), ["Circle Friend", "Circle Shared"]);
  assert.equal(albums.find((album) => album.title === "Circle Shared").reviewCount, 2);

  const reviews = await request("/circle/popular-reviews", {}, { limit: "12" });
  const rows = Object.values(reviews).filter((row) => row?.reviewId);
  assert.equal(rows.length, 3);
  assert.equal(rows.some((row) => row.userId === "circle-stranger"), false);
  assert.equal(rows[0].reviewId, friendReview.reviewId);

  const lonely = await reviewFeedClient(t, "circle-nobody")("/circle/popular", {}, { window: "all" });
  assert.equal(Object.values(lonely).filter((row) => row?.albumId).length, 0);
});

test("review deletion cascades likes, notifications, and every matching pin", { skip: !enabled }, async () => {
  const album = await createAlbum("Cascade");
  const unrelated = await createAlbum("Unrelated");
  const review = await createReview(album, "owner", 4.5, new Date());
  await Like.create([
    { userId: "actor", targetType: "review", reviewId: review._id },
    { userId: "actor", targetType: "album", albumCatalogId: unrelated._id },
  ]);
  await Notification.create({ recipientUserId: "owner", actorUserId: "actor", type: "review_like", reviewId: review._id });
  await UserProfile.create([{ userId: "owner", pinnedReviewId: review._id }, { userId: "other", pinnedReviewId: review._id }]);

  const result = await deleteOwnedReview(review.reviewId, "owner");
  assert.equal(result.deleted, true);
  assert.equal(await Review.exists({ _id: review._id }), null);
  assert.equal(await Like.countDocuments({ targetType: "review", reviewId: review._id }), 0);
  assert.equal(await Notification.countDocuments({ type: "review_like", reviewId: review._id }), 0);
  assert.equal(await UserProfile.countDocuments({ pinnedReviewId: review._id }), 0);
  assert.equal(await Like.countDocuments({ targetType: "album", albumCatalogId: unrelated._id }), 1);
  assert.equal((await deleteOwnedReview(review.reviewId, "owner")).deleted, false);
});

test("review likes and notifications commit together, while unlike preserves notification", { skip: !enabled }, async () => {
  const album = await createAlbum("Likes");
  const review = await createReview(album, "owner", 4, new Date());
  const liked = await mutateReviewLike(review.reviewId, "actor", true);
  assert.equal(liked.reviewId, review.reviewId);
  assert.equal(liked.likeCount, 1);
  assert.equal(await Notification.countDocuments({ type: "review_like", reviewId: review._id }), 1);
  const notification = await Notification.findOne({ type: "review_like", reviewId: review._id });
  assert.match(notification.notificationId, REVIEW_ID_V4);
  const unliked = await mutateReviewLike(review.reviewId, "actor", false);
  assert.equal(unliked.likeCount, 0);
  assert.equal(await Notification.countDocuments({ type: "review_like", reviewId: review._id }), 1);
  assert.equal((await Notification.findOne({ type: "review_like", reviewId: review._id })).notificationId, notification.notificationId);
});

test("review creation keys permit one durable review across concurrent retries", { skip: !enabled }, async () => {
  const album = await createAlbum("Idempotent");
  const creationKey = crypto.randomUUID();
  const create = () => Review.create({
    userId: "idempotent-owner",
    albumCatalogId: album._id,
    rating: 4,
    reviewText: "One review despite a retry",
    creationKey,
  });
  const attempts = await Promise.allSettled([create(), create()]);
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  assert.equal(await Review.countDocuments({ userId: "idempotent-owner", creationKey }), 1);
  const stored = await Review.findOne({ userId: "idempotent-owner", creationKey }).select("+creationKey");
  assert.equal(stored.creationKey, creationKey);
  assert.match(stored.reviewId, REVIEW_ID_V4);
});

test("popular review routes keep snapshot order across unlikes, re-likes, and new reviews", { skip: !enabled }, async (t) => {
  const owner = "snapshot-owner";
  const request = reviewFeedClient(t, owner);
  const album = await createAlbum("Snapshot ranking");
  const date = new Date("2026-09-01T00:00:00Z");
  const reviews = [];
  for (let i = 0; i < 5; i += 1) reviews.push(await createReview(album, owner, 4, date));
  for (let i = 0; i < 3; i += 1) {
    for (let like = 0; like < 3 - i; like += 1) {
      await mutateReviewLike(reviews[i].reviewId, `snapshot-liker-${like}`, true);
    }
  }
  const feeds = [
    { path: "/review/album/:albumId", params: { albumId: album.albumId } },
    { path: "/review/user/:userId", params: { userId: owner } },
    { path: "/review/user/", params: {} },
  ];
  for (const feed of feeds) {
    feed.first = await request(feed.path, feed.params, { sort: "popular", limit: "2" });
    assert.equal(feed.first.status, 200);
    assert.deepEqual(feed.first.reviews.map((row) => row.reviewId), reviews.slice(0, 2).map((row) => row.reviewId));
    assert.ok(feed.first.nextCursor);
  }

  // A previously returned row loses its rank; another row is unliked and
  // re-liked; an unseen row gains enough likes to jump ahead of the cursor.
  for (let like = 0; like < 3; like += 1) await mutateReviewLike(reviews[0].reviewId, `snapshot-liker-${like}`, false);
  await mutateReviewLike(reviews[2].reviewId, "snapshot-liker-0", false);
  await mutateReviewLike(reviews[2].reviewId, "snapshot-liker-0", true);
  for (const liker of [owner, "new-1", "new-2", "new-3"]) await mutateReviewLike(reviews[3].reviewId, liker, true);
  const added = await createReview(album, owner, 5, new Date());
  for (let i = 0; i < 5; i += 1) await mutateReviewLike(added.reviewId, `new-review-${i}`, true);
  await Review.updateOne({ _id: reviews[2]._id }, { $set: { reviewText: "Current edited text", rating: 3.5 } });
  await AlbumCatalog.updateOne({ _id: album._id }, { $set: { cover: "https://example.test/current-cover.jpg" } });

  const expected = [reviews[0], reviews[1], reviews[2], reviews[4], reviews[3]].map((row) => row.reviewId);
  for (const feed of feeds) {
    const seen = [...feed.first.reviews];
    let cursor = feed.first.nextCursor;
    for (let page = 0; cursor && page < 10; page += 1) {
      assert.ok(cursor.length < 1024, "cursor size must not grow with reviewed IDs");
      const response = await request(feed.path, feed.params, { sort: "popular", limit: "1", cursor });
      assert.equal(response.status, 200);
      seen.push(...response.reviews);
      cursor = response.nextCursor;
    }
    assert.equal(cursor, null);
    assert.deepEqual(seen.map((row) => row.reviewId), expected);
    assert.equal(new Set(seen.map((row) => row.reviewId)).size, seen.length);
    assert.equal(seen.find((row) => row.reviewId === reviews[2].reviewId).reviewText, "Current edited text");
    const nowLiked = seen.find((row) => row.reviewId === reviews[3].reviewId);
    assert.equal(nowLiked.likedByViewer, true);
    assert.equal(nowLiked.likeCount, 4);
    assert.equal(nowLiked.album.cover, "https://example.test/current-cover.jpg");
    for (const row of seen) {
      assert.equal(Object.hasOwn(row, "_id"), false);
      assert.equal(Object.hasOwn(row, "snapshotTime"), false);
    }
  }

  const fresh = await request(feeds[0].path, feeds[0].params, { sort: "popular", limit: "2" });
  assert.deepEqual(fresh.reviews.map((row) => row.reviewId), [added.reviewId, reviews[3].reviewId]);
  const wrongScope = await request(feeds[0].path, feeds[0].params, { sort: "popular", cursor: feeds[1].first.nextCursor });
  assert.equal(wrongScope.status, 400);
  assert.equal(wrongScope.code, "INVALID_REVIEW_CURSOR");
});

test("popular continuation omits deleted reviews and fills pages past deleted batches", { skip: !enabled }, async (t) => {
  const owner = "snapshot-deletion-owner";
  const request = reviewFeedClient(t, owner);
  const path = "/review/album/:albumId";
  const album = await createAlbum("Snapshot deletions");
  const params = { albumId: album.albumId };
  const reviews = [];
  for (let i = 0; i < 6; i += 1) reviews.push(await createReview(album, owner, 4, new Date("2026-09-01T00:00:00Z")));
  const first = await request(path, params, { sort: "popular", limit: "1" });
  assert.equal(first.status, 200);
  assert.equal(first.reviews[0].reviewId, reviews[5].reviewId);
  for (const review of reviews.slice(1, 5)) await deleteOwnedReview(review.reviewId, owner);
  const next = await request(path, params, { sort: "popular", limit: "1", cursor: first.nextCursor });
  assert.equal(next.status, 200);
  assert.deepEqual(next.reviews.map((row) => row.reviewId), [reviews[0].reviewId]);
  assert.equal(next.nextCursor, null);

  await deleteOwnedReview(reviews[0].reviewId, owner);
  const empty = await request(path, params, { sort: "popular", limit: "1", cursor: first.nextCursor });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.reviews, []);
  assert.equal(empty.nextCursor, null);
  await deleteOwnedReview(reviews[5].reviewId, owner);
  const freshEmpty = await request(path, params, { sort: "popular" });
  assert.equal(freshEmpty.status, 200);
  assert.deepEqual(freshEmpty.reviews, []);
  assert.equal(freshEmpty.nextCursor, null);
});

test("review IDs require UUID v4 values and unsupported transactions get action-specific errors", { skip: !enabled }, async () => {
  assert.throws(() => assertReviewId("not-an-object-id"), (error) => error.code === "INVALID_REVIEW_ID" && error.status === 400);
  assert.throws(() => assertReviewId(new mongoose.Types.ObjectId().toString()), (error) => error.code === "INVALID_REVIEW_ID" && error.status === 400);
  assert.equal(assertReviewId("B2B5724A-5E8B-4A36-8737-C5E45BFE976A"), "b2b5724a-5e8b-4a36-8737-c5e45bfe976a");
  const original = mongoose.startSession;
  mongoose.startSession = async () => ({
    async withTransaction() { const error = new Error("Transaction numbers are only allowed on a replica set member"); error.code = 20; throw error; },
    async endSession() {},
  });
  await assert.rejects(() => runReviewTransaction("deletion", async () => {}), (error) => error instanceof ReviewTransactionUnavailableError && error.code === "REVIEW_DELETION_UNAVAILABLE");
  mongoose.startSession = original;
});

test("concurrent delete and like/pin requests leave no dangling review relationships", { skip: !enabled }, async () => {
  const album = await createAlbum("Concurrent");
  const owner = `concurrent-owner-${Date.now()}`;
  const review = await createReview(album, owner, 4, new Date());
  await UserProfile.create({ userId: owner });
  const pinRequest = runReviewTransaction("pin", async (session) => {
    await assertPinnedReview(review.reviewId, owner, session);
    await UserProfile.updateOne({ userId: owner }, { $set: { pinnedReviewId: review._id } }, { session });
  });
  const [pinResult, deleteResult, likeResult] = await Promise.allSettled([
    pinRequest,
    deleteOwnedReview(review.reviewId, owner),
    mutateReviewLike(review.reviewId, "actor", true),
  ]);
  assert.ok(["fulfilled", "rejected"].includes(pinResult.status));
  assert.equal(deleteResult.status, "fulfilled");
  assert.equal(deleteResult.value.deleted, true);
  assert.ok(likeResult.status === "fulfilled" || (likeResult.reason && likeResult.reason.status === 404));
  assert.equal(await Review.exists({ _id: review._id }), null);
  assert.equal(await Like.countDocuments({ targetType: "review", reviewId: review._id }), 0);
  assert.equal(await UserProfile.countDocuments({ pinnedReviewId: review._id }), 0);
});

test("discovery feeds top up past deleted catalog rows and cache only site-wide rankings", { skip: !enabled }, async (t) => {
  await Promise.all([Review.deleteMany({}), Like.deleteMany({}), AlbumCatalog.deleteMany({}), Follow.deleteMany({})]);
  resetFeedCache();
  t.after(() => resetFeedCache());
  const base = new Date("2026-09-01T00:00:00Z").getTime();
  // More deleted albums than the first ranking window, all outranking the kept ones.
  const deleted = await Promise.all(Array.from({ length: 15 }, (_, index) => createAlbum(`Deleted ${index}`)));
  await Promise.all(deleted.flatMap((album, index) => [0, 1, 2].map((offset) => (
    createReview(album, `deleted-${index}-${offset}`, 5, new Date(base + (100 + index) * 60_000))
  ))));
  const kept = await Promise.all(["A", "B", "C"].map((title) => createAlbum(`Kept ${title}`)));
  const keptReviews = await Promise.all(kept.map((album, index) => createReview(album, `kept-${index}`, 5 - index, new Date(base - index * 60_000))));
  await Like.create([0, 1, 2, 3].map((index) => ({ userId: `fan-${index}`, targetType: "review", reviewId: (index < 3 ? keptReviews[0] : keptReviews[1])._id })));
  await AlbumCatalog.deleteMany({ _id: { $in: deleted.map((album) => album._id) } });

  assert.deepEqual((await featuredAlbums(3)).map((album) => album.title), ["Kept A", "Kept B", "Kept C"]);
  assert.deepEqual((await recentlyReviewedAlbums(3)).map((album) => album.title), ["Kept A", "Kept B", "Kept C"]);
  assert.deepEqual((await rankedAlbums({ limit: 5, window: "all" })).map((album) => album.title), ["Kept A", "Kept B", "Kept C"]);
  const reviewRows = await popularReviewRows(3);
  assert.deepEqual(reviewRows.map((row) => String(row._id)), keptReviews.map((review) => String(review._id)));
  assert.equal(reviewRows.some((row) => "catalogAlbum" in row || "likeCount" in row), false);

  const asViewer = reviewFeedClient(t, "fan-0");
  const featuredResponse = await asViewer("/featured", {}, { limit: "3" });
  assert.equal(featuredResponse.headers["cache-control"], "public, max-age=60, stale-while-revalidate=120");
  const featuredBefore = Object.values(featuredResponse).filter((row) => row?.albumId);
  assert.deepEqual(featuredBefore.map((album) => album.title), ["Kept A", "Kept B", "Kept C"]);

  // Inside the TTL the ranking holds, but catalog metadata is read fresh.
  const newcomer = await createAlbum("Newcomer");
  await Promise.all([0, 1, 2, 3].map((index) => createReview(newcomer, `new-${index}`, 5, new Date(base))));
  await AlbumCatalog.updateOne({ _id: kept[0]._id }, { $set: { title: "Kept A (renamed)" } });
  const featuredCached = Object.values(await asViewer("/featured", {}, { limit: "3" })).filter((row) => row?.albumId);
  assert.deepEqual(featuredCached.map((album) => album.title), ["Kept A (renamed)", "Kept B", "Kept C"]);

  // Popular reviews share one cached ranking but serialize likes per viewer.
  const fanResponse = await asViewer("/popular-reviews", {}, { limit: "2" });
  assert.equal(fanResponse.headers["cache-control"], "private, no-store");
  const fanView = Object.values(fanResponse).filter((row) => row?.reviewId);
  const strangerView = Object.values(await reviewFeedClient(t, "stranger")("/popular-reviews", {}, { limit: "2" })).filter((row) => row?.reviewId);
  assert.deepEqual(fanView.map((row) => row.reviewId), strangerView.map((row) => row.reviewId));
  assert.deepEqual(fanView.map((row) => [row.likeCount, row.likedByViewer]), [[3, true], [1, false]]);
  assert.deepEqual(strangerView.map((row) => [row.likeCount, row.likedByViewer]), [[3, false], [1, false]]);

  resetFeedCache();
  const featuredFresh = Object.values(await asViewer("/featured", {}, { limit: "3" })).filter((row) => row?.albumId);
  assert.equal(featuredFresh[0].title, "Newcomer");
});

function reviewEditClient(t, userId) {
  const clerkPath = require.resolve("@clerk/express");
  const routePath = require.resolve("../routes/reviews");
  const oldClerk = require.cache[clerkPath];
  const oldRoute = require.cache[routePath];
  require.cache[clerkPath] = {
    id: clerkPath, filename: clerkPath, loaded: true,
    exports: {
      getAuth: () => ({ userId }),
      clerkClient: { users: { getUserList: async () => ({ data: [] }) } },
    },
  };
  delete require.cache[routePath];
  const router = require(routePath);
  t.after(() => {
    if (oldClerk) require.cache[clerkPath] = oldClerk;
    else delete require.cache[clerkPath];
    if (oldRoute) require.cache[routePath] = oldRoute;
    else delete require.cache[routePath];
  });
  const layer = router.stack.find((item) => item.route?.path === "/review/user/:id" && item.route.methods.patch);
  return async (reviewId, body) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(value) { this.body = value; return this; },
    };
    await layer.route.stack.at(-1).handle({ userId, params: { id: reviewId }, body }, res);
    return { status: res.statusCode, body: res.body };
  };
}

test("review edits change rating and text in place and mark only real changes as edited", { skip: !enabled }, async (t) => {
  const album = await createAlbum("Edited Album");
  const review = await createReview(album, "editor", 2, new Date("2026-09-01T00:00:00.000Z"));
  await createReview(album, "other-editor", 4, new Date("2026-09-02T00:00:00.000Z"));
  const edit = reviewEditClient(t, "editor");

  const changed = await edit(review.reviewId, { rating: 5, reviewText: "Grew on me" });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.rating, 5);
  assert.equal(changed.body.reviewText, "Grew on me");
  assert.ok(changed.body.editedAt instanceof Date);
  assert.equal(changed.body.date.toISOString(), "2026-09-01T00:00:00.000Z");

  const stored = await Review.findById(review._id).select("+interactionRevision").lean();
  assert.equal(stored.interactionRevision, 1);
  const [summary] = await Review.aggregate([{ $match: { albumCatalogId: album._id } }, { $group: { _id: null, average: { $avg: "$rating" } } }]);
  assert.equal(summary.average, 4.5);

  const unchanged = await edit(review.reviewId, { rating: 5, reviewText: "  Grew on me " });
  assert.equal(unchanged.status, 200);
  assert.equal(unchanged.body.editedAt.getTime(), changed.body.editedAt.getTime());
  assert.equal((await Review.findById(review._id).select("+interactionRevision").lean()).interactionRevision, 1);

  const stranger = await reviewEditClient(t, "stranger")(review.reviewId, { rating: 1, reviewText: "Hijacked" });
  assert.deepEqual(stranger, { status: 404, body: { error: "Review not found", code: "REVIEW_NOT_FOUND" } });
  assert.equal((await Review.findById(review._id).lean()).reviewText, "Grew on me");
});

test("an edit racing deletion or account anonymization never resurrects or rewrites the review", { skip: !enabled }, async (t) => {
  const album = await createAlbum("Race Album");
  const edit = reviewEditClient(t, "racer");

  const deleted = await createReview(album, "racer", 3, new Date());
  const [editResult] = await Promise.all([
    edit(deleted.reviewId, { rating: 1, reviewText: "Racing the delete" }),
    deleteOwnedReview(deleted.reviewId, "racer"),
  ]);
  assert.ok([200, 404].includes(editResult.status));
  assert.equal(await Review.exists({ _id: deleted._id }), null);

  const anonymized = await createReview(album, "racer", 3, new Date());
  await Review.updateMany({ userId: "racer" }, { $set: { userId: Review.DELETED_AUTHOR_ID }, $inc: { interactionRevision: 1 } }, { overwriteImmutable: true });
  const afterAnonymization = await edit(anonymized.reviewId, { rating: 1, reviewText: "Too late" });
  assert.equal(afterAnonymization.status, 404);
  const stored = await Review.findById(anonymized._id).lean();
  assert.equal(stored.reviewText, "racer review");
  assert.equal(stored.editedAt, null);
});
