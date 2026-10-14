const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const mongoose = require("mongoose");

const AlbumCatalog = require("../models/AlbumCatalog");
const BoardItem = require("../models/BoardItem");
const BoardListen = require("../models/BoardListen");
const Follow = require("../models/Follow");
const Like = require("../models/Like");
const Review = require("../models/Reviews");

const clerkPath = require.resolve("@clerk/express");
const albumRoutePath = require.resolve("../routes/album");
const ALBUM_ID = "22222222-2222-4222-8222-222222222222";

let viewerId = "";

function loadRoute(t) {
  const previousClerk = require.cache[clerkPath];
  const previousRoute = require.cache[albumRoutePath];
  require.cache[clerkPath] = {
    id: clerkPath,
    filename: clerkPath,
    loaded: true,
    exports: {
      getAuth: () => ({ userId: viewerId }),
      clerkClient: { users: { async getUserList() { return { data: [] }; } } },
    },
  };
  delete require.cache[albumRoutePath];
  const router = require(albumRoutePath);
  t.after(() => {
    if (previousClerk) require.cache[clerkPath] = previousClerk;
    else delete require.cache[clerkPath];
    if (previousRoute) require.cache[albumRoutePath] = previousRoute;
    else delete require.cache[albumRoutePath];
  });
  return router;
}

async function getSocial(router) {
  const layer = router.stack.find((item) => item.route?.path === "/album/:albumId/social" && item.route.methods.get);
  assert.ok(layer, "GET /album/:albumId/social must remain registered");
  const res = {
    statusCode: 200,
    body: null,
    status(statusCode) { this.statusCode = statusCode; return this; },
    json(body) { this.body = body; return this; },
  };
  await layer.route.stack.at(-1).handle({ params: { albumId: ALBUM_ID } }, res);
  return { status: res.statusCode, body: res.body };
}

function sorted(value, calls) {
  const query = {
    sort(order) { calls.push(order); return query; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  };
  return query;
}

function review(userId, rating, date) {
  return { _id: new mongoose.Types.ObjectId(), reviewId: crypto.randomUUID(), userId, rating, date: new Date(date) };
}

function mockAlbum(t) {
  const album = { _id: new mongoose.Types.ObjectId(), albumId: ALBUM_ID, title: "Album", artistDisplayName: "Artist" };
  t.mock.method(AlbumCatalog, "findOne", async () => album);
  t.mock.method(BoardItem, "distinct", async () => []);
  t.mock.method(BoardListen, "aggregate", async () => []);
  t.mock.method(Review, "aggregate", async () => [{ _id: 4, count: 2 }, { _id: 2, count: 1 }]);
  return album;
}

test("album social context reports the viewer's newest rating and each followed reviewer's latest review", async (t) => {
  mockAlbum(t);
  const sortCalls = [];
  const viewerFilters = [];
  t.mock.method(Review, "findOne", (filter) => { viewerFilters.push(filter); return sorted(review("viewer", 3.5, "2026-10-02"), sortCalls); });
  t.mock.method(Follow, "find", async () => [{ followingId: "ana" }, { followingId: "ben" }, { followingId: "viewer" }]);
  // Newest first, as the route requests: Ana's 2 is her latest and replaces her older 5.
  const anaLatest = review("ana", 2, "2026-10-05");
  t.mock.method(Review, "find", () => sorted([anaLatest, review("ben", 4.5, "2026-10-03"), review("ana", 5, "2026-09-01")], sortCalls));
  t.mock.method(Like, "find", async () => []);
  viewerId = "viewer";
  const router = loadRoute(t);

  const response = await getSocial(router);
  assert.equal(response.status, 200);
  assert.equal(viewerFilters[0].userId, "viewer");
  assert.ok(sortCalls.every((order) => order.date === -1 && order._id === -1), "reviews must be read newest first");
  assert.equal(response.body.viewerRating, 3.5);
  assert.deepEqual(response.body.followedReviewers.map((reviewer) => [reviewer.userId, reviewer.rating]), [["ana", 2], ["ben", 4.5]]);
  assert.equal(response.body.followedReviewers[0].reviewId, anaLatest.reviewId);
  assert.equal(response.body.followedAverageRating, 3.3);
  assert.equal(response.body.averageRating, 3.3);
  assert.equal(JSON.stringify(response.body).includes("_id"), false);
});

test("album social context omits personal ratings for anonymous viewers and people without reviews", async (t) => {
  mockAlbum(t);
  const findOne = t.mock.method(Review, "findOne", () => sorted(null, []));
  const follows = t.mock.method(Follow, "find", async () => []);
  const router = loadRoute(t);
  viewerId = "";
  const anonymous = await getSocial(router);
  assert.equal(anonymous.status, 200);
  assert.equal(anonymous.body.viewerRating, null);
  assert.equal(anonymous.body.followedAverageRating, null);
  assert.deepEqual(anonymous.body.followedReviewers, []);
  assert.equal(findOne.mock.callCount(), 0);
  assert.equal(follows.mock.callCount(), 0);

  viewerId = "viewer";
  const signedIn = await getSocial(router);
  assert.equal(signedIn.body.viewerRating, null);
  assert.equal(signedIn.body.followedAverageRating, null);
});
