const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

const AlbumCatalog = require("../models/AlbumCatalog");
const BoardItem = require("../models/BoardItem");
const Follow = require("../models/Follow");
const Like = require("../models/Like");
const Notification = require("../models/Notification");
const Review = require("../models/Reviews");
const Listen = require("../models/Listen");
const UserProfile = require("../models/UserProfile");

const clerkPath = require.resolve("@clerk/express");
const reviewRoutePath = require.resolve("../routes/reviews");
const notificationRoutePath = require.resolve("../routes/notifications");
const profileRoutePath = require.resolve("../routes/profile");
const reviewInteractionsPath = require.resolve("../routes/utils/reviewInteractions");
const REVIEW_ID = "11111111-1111-4111-8111-111111111111";
const NOTIFICATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function installClerk(t) {
  const previous = require.cache[clerkPath];
  require.cache[clerkPath] = {
    id: clerkPath,
    filename: clerkPath,
    loaded: true,
    exports: {
      getAuth: () => ({ userId: "owner" }),
      clerkClient: {
        users: {
          async getUserList() {
            return { data: [{ id: "owner", username: "owner-name", imageUrl: "https://example.test/owner.png" }] };
          },
        },
      },
    },
  };
  t.after(() => {
    if (previous) require.cache[clerkPath] = previous;
    else delete require.cache[clerkPath];
  });
}

function loadRoute(t, routePath) {
  installClerk(t);
  const previous = require.cache[routePath];
  delete require.cache[routePath];
  const router = require(routePath);
  t.after(() => {
    if (previous) require.cache[routePath] = previous;
    else delete require.cache[routePath];
  });
  return router;
}

async function invokeLastHandler(router, path, method, req) {
  const layer = router.stack.find((item) => item.route?.path === path && item.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} must remain registered`);
  const res = {
    statusCode: 200,
    body: null,
    status(statusCode) { this.statusCode = statusCode; return this; },
    json(body) { this.body = body; return this; },
  };
  await layer.route.stack.at(-1).handle(req, res);
  return { status: res.statusCode, body: res.body };
}

function catalogAlbum() {
  return {
    _id: new mongoose.Types.ObjectId(),
    albumId: "22222222-2222-4222-8222-222222222222",
    title: "A Catalog Album",
    artistDisplayName: "A Catalog Artist",
    artistCredits: [],
    tracks: [],
    catalogSource: "manual",
  };
}

function populatedQuery(value) {
  const query = {
    populate() { return query; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  };
  return query;
}

function chainQuery(value) {
  const query = {
    populate() { return query; },
    sort() { return query; },
    limit() { return query; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  };
  return query;
}

test("review edits resolve UUIDs and serialize only the public review identifier", async (t) => {
  const album = catalogAlbum();
  const internalReviewId = new mongoose.Types.ObjectId();
  const review = {
    _id: internalReviewId,
    reviewId: REVIEW_ID,
    userId: "owner",
    albumCatalogId: album._id,
    rating: 4,
    reviewText: "Edited review",
    date: new Date("2026-09-06T12:00:00.000Z"),
  };
  let filter;
  t.mock.method(Review, "findOneAndUpdate", async (value) => {
    filter = value;
    return review;
  });
  t.mock.method(AlbumCatalog, "find", async () => [album]);
  t.mock.method(Like, "find", async () => []);
  const router = loadRoute(t, reviewRoutePath);

  const response = await invokeLastHandler(router, "/review/user/:id", "patch", {
    userId: "owner",
    params: { id: REVIEW_ID.toUpperCase() },
    body: { rating: 4, reviewText: "Edited review" },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(filter, { reviewId: REVIEW_ID, userId: "owner" });
  assert.equal(response.body.reviewId, REVIEW_ID);
  assert.equal(Object.hasOwn(response.body, "_id"), false);
  assert.equal(JSON.stringify(response.body).includes(String(internalReviewId)), false);
});

test("review creation and edits reject client-owned identifiers", async (t) => {
  const router = loadRoute(t, reviewRoutePath);
  const request = {
    userId: "owner",
    params: { id: REVIEW_ID },
    body: { reviewId: REVIEW_ID, rating: 4, reviewText: "Attempted identity override" },
    get: () => "33333333-3333-4333-8333-333333333333",
  };

  const create = await invokeLastHandler(router, "/review", "post", request);
  const update = await invokeLastHandler(router, "/review/user/:id", "patch", request);
  assert.deepEqual(create, { status: 400, body: { error: "reviewId is server-generated", code: "INVALID_REVIEW_ID" } });
  assert.deepEqual(update, { status: 400, body: { error: "reviewId is server-generated", code: "INVALID_REVIEW_ID" } });
});

test("notifications expose public UUIDs and resolved review UUIDs without leaking Mongo IDs", async (t) => {
  const album = catalogAlbum();
  const internalReviewId = new mongoose.Types.ObjectId();
  const internalNotificationId = new mongoose.Types.ObjectId();
  const notification = {
    _id: internalNotificationId,
    notificationId: NOTIFICATION_ID,
    recipientUserId: "owner",
    actorUserId: "actor",
    type: "review_like",
    reviewId: internalReviewId,
    readAt: null,
    createdAt: new Date("2026-09-06T12:00:00.000Z"),
    updatedAt: new Date("2026-09-06T12:00:00.000Z"),
  };
  const review = { _id: internalReviewId, reviewId: REVIEW_ID, albumCatalogId: album, rating: 4 };
  t.mock.method(Notification, "find", () => ({
    sort() { return this; },
    limit: async () => [notification],
  }));
  t.mock.method(Notification, "updateMany", async () => ({}));
  t.mock.method(Review, "find", () => ({ populate: async () => [review] }));
  t.mock.method(AlbumCatalog, "find", async () => [album]);
  const router = loadRoute(t, notificationRoutePath);

  const response = await invokeLastHandler(router, "/", "get", { userId: "owner" });
  const result = response.body.notifications[0];
  assert.equal(response.status, 200);
  assert.equal(result.notificationId, NOTIFICATION_ID);
  assert.equal(result.reviewId, REVIEW_ID);
  assert.equal(result.review.reviewId, REVIEW_ID);
  assert.equal(Object.hasOwn(result, "_id"), false);
  assert.equal(Object.hasOwn(result.review, "_id"), false);
  assert.equal(JSON.stringify(result).includes(String(internalReviewId)), false);
  assert.equal(JSON.stringify(result).includes(String(internalNotificationId)), false);
});

test("a dangling notification review reference remains empty instead of exposing its ObjectId", async (t) => {
  const internalReviewId = new mongoose.Types.ObjectId();
  const notification = {
    _id: new mongoose.Types.ObjectId(),
    notificationId: NOTIFICATION_ID,
    recipientUserId: "owner",
    actorUserId: "actor",
    type: "review_like",
    reviewId: internalReviewId,
    readAt: new Date("2026-09-06T12:00:00.000Z"),
    createdAt: new Date("2026-09-06T12:00:00.000Z"),
    updatedAt: new Date("2026-09-06T12:00:00.000Z"),
  };
  t.mock.method(Notification, "find", () => ({
    sort() { return this; },
    limit: async () => [notification],
  }));
  t.mock.method(Review, "find", () => ({ populate: async () => [] }));
  t.mock.method(AlbumCatalog, "find", async () => []);
  const router = loadRoute(t, notificationRoutePath);

  const response = await invokeLastHandler(router, "/", "get", { userId: "owner" });
  const result = response.body.notifications[0];
  assert.equal(result.reviewId, "");
  assert.equal(result.review, null);
  assert.equal(result.notificationId, NOTIFICATION_ID);
  assert.equal(Object.hasOwn(result, "_id"), false);
  assert.equal(JSON.stringify(result).includes(String(internalReviewId)), false);
});

test("profile pins resolve public review IDs before storing the internal relationship", async (t) => {
  const realInteractions = require(reviewInteractionsPath);
  const internalReviewId = new mongoose.Types.ObjectId();
  const profile = {
    userId: "owner",
    bio: "",
    spotifyProfileUrl: "",
    isPrivate: false,
    favoriteAlbums: [],
    listeningNextAlbum: null,
    pinnedReviewId: {
      _id: internalReviewId,
      reviewId: REVIEW_ID,
      userId: "owner",
      albumCatalogId: null,
      rating: 4,
      reviewText: "Pinned review",
      date: new Date("2026-09-06T12:00:00.000Z"),
    },
    pinnedBoardId: null,
  };
  let assertedId;
  let storedUpdate;
  const previousInteractions = require.cache[reviewInteractionsPath];
  require.cache[reviewInteractionsPath] = {
    id: reviewInteractionsPath,
    filename: reviewInteractionsPath,
    loaded: true,
    exports: {
      ...realInteractions,
      runReviewTransaction: async (_action, callback) => callback({}),
      assertPinnedReview: async (reviewId) => {
        assertedId = reviewId;
        return { _id: internalReviewId, reviewId };
      },
    },
  };
  t.after(() => {
    if (previousInteractions) require.cache[reviewInteractionsPath] = previousInteractions;
    else delete require.cache[reviewInteractionsPath];
  });
  t.mock.method(UserProfile, "findOneAndUpdate", async (_filter, update) => {
    storedUpdate = update;
    return profile;
  });
  t.mock.method(UserProfile, "findOne", () => populatedQuery(profile));
  t.mock.method(Follow, "countDocuments", async () => 0);
  t.mock.method(Review, "aggregate", async () => []);
  const router = loadRoute(t, profileRoutePath);

  const response = await invokeLastHandler(router, "/me", "put", {
    userId: "owner",
    body: {
      bio: "",
      spotifyProfileUrl: "",
      favoriteAlbumIds: [],
      pinnedReviewId: REVIEW_ID,
      pinnedBoardId: "",
    },
  });

  assert.equal(response.status, 200);
  assert.equal(assertedId, REVIEW_ID);
  assert.equal(String(storedUpdate.$set.pinnedReviewId), String(internalReviewId));
  assert.equal(response.body.pinnedReview.reviewId, REVIEW_ID);
  assert.equal(Object.hasOwn(response.body.pinnedReview, "_id"), false);
  assert.equal(JSON.stringify(response.body).includes(String(internalReviewId)), false);
});

test("profile review activity uses the public review ID for both activity identity fields", async (t) => {
  const internalReviewId = new mongoose.Types.ObjectId();
  const review = {
    _id: internalReviewId,
    reviewId: REVIEW_ID,
    userId: "owner",
    albumCatalogId: catalogAlbum(),
    rating: 4,
    reviewText: "Activity review",
    date: new Date("2026-09-06T12:00:00.000Z"),
  };
  t.mock.method(Review, "find", () => chainQuery([review]));
  t.mock.method(BoardItem, "find", () => chainQuery([]));
  t.mock.method(Listen, "aggregate", async () => []);
  const router = loadRoute(t, profileRoutePath);

  const response = await invokeLastHandler(router, "/me/activity", "get", { userId: "owner" });
  const activity = response.body[0];
  assert.equal(response.status, 200);
  assert.equal(activity.id, REVIEW_ID);
  assert.equal(activity.reviewId, REVIEW_ID);
  assert.equal(Object.hasOwn(activity, "_id"), false);
  assert.equal(JSON.stringify(activity).includes(String(internalReviewId)), false);
});

test("review permalinks resolve a public UUID and hide reviews whose album no longer resolves", async (t) => {
  const album = catalogAlbum();
  const internalReviewId = new mongoose.Types.ObjectId();
  const review = {
    _id: internalReviewId,
    reviewId: REVIEW_ID,
    userId: "owner",
    albumCatalogId: album._id,
    rating: 4.5,
    reviewText: "Worth sharing",
    date: new Date("2026-10-01T12:00:00.000Z"),
  };
  let filter;
  let catalogRows = [album];
  const findOne = t.mock.method(Review, "findOne", async (value) => { filter = value; return value.reviewId === REVIEW_ID ? review : null; });
  t.mock.method(AlbumCatalog, "find", async () => catalogRows);
  t.mock.method(Like, "find", async () => []);
  const router = loadRoute(t, reviewRoutePath);

  const found = await invokeLastHandler(router, "/review/:reviewId", "get", { params: { reviewId: REVIEW_ID.toUpperCase() } });
  assert.equal(found.status, 200);
  assert.deepEqual(filter, { reviewId: REVIEW_ID });
  assert.equal(found.body.reviewId, REVIEW_ID);
  assert.equal(found.body.album.albumId, album.albumId);
  assert.equal(JSON.stringify(found.body).includes(String(internalReviewId)), false);
  assert.equal(JSON.stringify(found.body).includes(String(album._id)), false);

  const unknown = await invokeLastHandler(router, "/review/:reviewId", "get", { params: { reviewId: "33333333-3333-4333-8333-333333333333" } });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, "REVIEW_NOT_FOUND");

  catalogRows = [];
  const dangling = await invokeLastHandler(router, "/review/:reviewId", "get", { params: { reviewId: REVIEW_ID } });
  assert.equal(dangling.status, 404);
  assert.equal(dangling.body.code, "REVIEW_NOT_FOUND");

  const callsBeforeMalformed = findOne.mock.callCount();
  for (const reviewId of [String(internalReviewId), "not-a-review"]) {
    const malformed = await invokeLastHandler(router, "/review/:reviewId", "get", { params: { reviewId } });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.code, "INVALID_REVIEW_ID");
  }
  assert.equal(findOne.mock.callCount(), callsBeforeMalformed);
});

test("rating-sorted review pages query in rating order and continue from the last rating", async (t) => {
  const album = catalogAlbum();
  const reviews = [5, 4.5, 4].map((rating, index) => ({
    _id: new mongoose.Types.ObjectId(),
    reviewId: `${index + 4}${index + 4}${index + 4}${index + 4}${index + 4}${index + 4}${index + 4}${index + 4}-1111-4111-8111-111111111111`,
    userId: "author",
    albumCatalogId: album._id,
    rating,
    reviewText: `Rated ${rating}`,
    date: new Date(`2026-10-0${index + 1}T12:00:00.000Z`),
  }));
  const calls = [];
  t.mock.method(Review, "find", (filter) => {
    const call = { filter };
    calls.push(call);
    const query = {
      sort(value) { call.sort = value; return query; },
      limit(value) { call.limit = value; return Promise.resolve(reviews.slice(0, value)); },
    };
    return query;
  });
  t.mock.method(AlbumCatalog, "find", async () => [album]);
  t.mock.method(Like, "find", async () => []);
  const router = loadRoute(t, reviewRoutePath);

  const first = await invokeLastHandler(router, "/review/user/:userId", "get", { params: { userId: "author" }, query: { sort: "highest", limit: "2" } });
  assert.equal(first.status, 200);
  assert.deepEqual(calls[0].filter, { userId: "author" });
  assert.deepEqual(calls[0].sort, { rating: -1, date: -1, _id: -1 });
  assert.equal(calls[0].limit, 3);
  assert.deepEqual(first.body.reviews.map((review) => review.rating), [5, 4.5]);
  assert.ok(first.body.nextCursor);

  await invokeLastHandler(router, "/review/user/:userId", "get", { params: { userId: "author" }, query: { sort: "highest", limit: "2", cursor: first.body.nextCursor } });
  assert.deepEqual(calls[1].filter.$or[0], { rating: { $lt: 4.5 } });
  assert.equal(calls[1].filter.userId, "author");

  const wrongSort = await invokeLastHandler(router, "/review/user/:userId", "get", { params: { userId: "author" }, query: { sort: "lowest", cursor: first.body.nextCursor } });
  assert.equal(wrongSort.status, 400);
  assert.equal(wrongSort.body.code, "INVALID_REVIEW_CURSOR");
  assert.equal(calls.length, 2);

  await invokeLastHandler(router, "/review/user/:userId", "get", { params: { userId: "author" }, query: { sort: "lowest" } });
  assert.deepEqual(calls[2].sort, { rating: 1, date: -1, _id: -1 });
});
