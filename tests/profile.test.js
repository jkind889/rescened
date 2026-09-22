const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const mongoose = require("mongoose");
const Follow = require("../models/Follow");
const UserProfile = require("../models/UserProfile");
const Review = require("../models/Reviews");
const AlbumCatalog = require("../models/AlbumCatalog");
const Like = require("../models/Like");
const Listen = require("../models/Listen");

const clerkPath = require.resolve("@clerk/express");
const profilePath = require.resolve("../routes/profile");
const VIEWER = "user_network_viewer";
const ALBUM_ID = "184c836b-14dc-4f85-a3f6-e5a166b3156d";

function reviewRow(userId, overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    reviewId: crypto.randomUUID(),
    userId,
    albumCatalogId: new mongoose.Types.ObjectId(),
    date: new Date("2026-09-04T12:00:00.000Z"),
    rating: 4.5,
    reviewText: "A review from someone I follow.",
    // An obsolete snapshot must not replace the current joined catalog metadata.
    album: { title: "Outdated title", albumId: "obsolete-provider-id" },
    interactionRevision: 7,
    catalogAlbum: {
      _id: new mongoose.Types.ObjectId(),
      albumId: ALBUM_ID,
      title: "Current catalog title",
      artistDisplayName: "Current artist",
      cover: "https://example.test/current-cover.jpg",
      releaseDate: "2026-01-02",
      catalogSource: "manual",
    },
    likeCount: 3,
    likedByViewer: true,
    ...overrides,
  };
}

function installNetworkRoute(t, options = {}) {
  const calls = { follows: [], profiles: [], aggregates: [], authors: [] };
  const follows = options.follows ?? [{ followingId: "user_alex" }];
  const privateProfiles = options.privateProfiles ?? [];
  const rows = options.rows ?? [];

  function selectedRows(kind, result, failure) {
    return (filter) => {
      const call = { filter, select: null, lean: false };
      calls[kind].push(call);
      return {
        select(fields) { call.select = fields; return this; },
        async lean() {
          call.lean = true;
          if (failure) throw failure;
          return result;
        },
      };
    };
  }

  t.mock.method(Follow, "find", selectedRows("follows", follows, options.followError));
  t.mock.method(UserProfile, "find", selectedRows("profiles", privateProfiles, options.profileError));
  t.mock.method(Review, "aggregate", async (pipeline) => {
    calls.aggregates.push(pipeline);
    if (options.reviewError) throw options.reviewError;
    // These are already-aggregated rows. Filtering and sorting semantics are
    // exercised against MongoDB by the integration suite, not simulated here.
    return rows;
  });

  t.mock.method(Listen, "aggregate", async () => {
    if (options.listenError) throw options.listenError;
    return options.listens ?? [];
  });

  const previousClerk = require.cache[clerkPath];
  const previousProfile = require.cache[profilePath];
  require.cache[clerkPath] = {
    id: clerkPath,
    filename: clerkPath,
    loaded: true,
    exports: {
      getAuth: () => ({ userId: options.viewerId ?? VIEWER }),
      clerkClient: {
        users: {
          async getUserList(query) {
            calls.authors.push(query);
            if (options.authorError) throw options.authorError;
            return { data: options.users ?? [] };
          },
        },
      },
    },
  };
  delete require.cache[profilePath];
  const router = require("../routes/profile");
  t.after(() => {
    if (previousClerk) require.cache[clerkPath] = previousClerk;
    else delete require.cache[clerkPath];
    if (previousProfile) require.cache[profilePath] = previousProfile;
    else delete require.cache[profilePath];
  });

  return {
    calls,
    async request() {
      const layer = router.stack.find((item) => item.route?.path === "/me/network" && item.route.methods.get);
      assert.ok(layer, "GET /me/network must remain registered");
      const req = { headers: {} };
      const res = {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
      };
      for (const entry of layer.route.stack) {
        let nextCalled = false;
        await entry.handle(req, res, () => { nextCalled = true; });
        if (!nextCalled) break;
      }
      return { status: res.statusCode, body: res.body };
    },
  };
}

test("network activity requires authentication before database or author queries", async (t) => {
  const route = installNetworkRoute(t, { viewerId: "" });
  assert.deepEqual(await route.request(), { status: 401, body: { error: "Unauthorized" } });
  assert.deepEqual(route.calls, { follows: [], profiles: [], aggregates: [], authors: [] });
});

test("network returns followed-user review activities with current catalog metadata and viewer likes", async (t) => {
  const alex = reviewRow("user_alex");
  const sam = reviewRow("user_sam", {
    date: new Date("2026-09-03T12:00:00.000Z"),
    rating: 3,
    likeCount: 0,
    likedByViewer: false,
  });
  const route = installNetworkRoute(t, {
    follows: ["user_alex", "user_sam", "user_without_reviews"].map((followingId) => ({ followingId })),
    rows: [alex, sam],
    users: [
      { id: "user_alex", username: "alex", imageUrl: "https://example.test/alex.jpg" },
      { id: "user_sam", username: "sam", imageUrl: "https://example.test/sam.jpg" },
    ],
  });
  const result = await route.request();
  assert.equal(result.status, 200);
  assert.equal(result.body.length, 2);
  assert.deepEqual(result.body[0], {
    id: alex.reviewId,
    reviewId: alex.reviewId,
    type: "review",
    actor: { userId: "user_alex", username: "alex", imageUrl: "https://example.test/alex.jpg" },
    userId: "user_alex",
    createdAt: alex.date,
    album: {
      albumId: ALBUM_ID,
      title: "Current catalog title",
      artistDisplayName: "Current artist",
      artistCredits: [],
      releaseType: "album",
      releaseDate: "2026-01-02",
      releaseDatePrecision: "",
      releaseYear: 2026,
      cover: "https://example.test/current-cover.jpg",
      tracks: [],
      label: "",
      externalReferences: [],
      catalogSource: "manual",
    },
    rating: 4.5,
    reviewText: alex.reviewText,
    likeCount: 3,
    likedByViewer: true,
  });
  assert.equal(result.body[1].actor.username, "sam");
  assert.equal(result.body[1].likeCount, 0);
  assert.equal(result.body[1].likedByViewer, false);
  assert.equal(result.body[1].album.albumId, ALBUM_ID);
  assert.deepEqual(route.calls.follows, [{ filter: { followerId: VIEWER }, select: "followingId", lean: true }]);
  assert.deepEqual(route.calls.authors, [{ userId: ["user_alex", "user_sam"], limit: 20 }]);
});

test("network requests enough Clerk users to resolve all 20 distinct feed actors", async (t) => {
  const users = Array.from({ length: 20 }, (_, index) => ({
    id: `user_followed_${index}`,
    username: `listener_${index}`,
    imageUrl: `https://example.test/listener-${index}.jpg`,
  }));
  const route = installNetworkRoute(t, {
    follows: users.map((user) => ({ followingId: user.id })),
    rows: users.map((user) => reviewRow(user.id)),
    users,
  });
  const result = await route.request();
  assert.equal(result.status, 200);
  assert.equal(result.body.length, 20);
  assert.deepEqual(route.calls.authors, [{ userId: users.map((user) => user.id), limit: 20 }]);
  assert.deepEqual(result.body.map((activity) => activity.actor), users.map((user) => ({
    userId: user.id,
    username: user.username,
    imageUrl: user.imageUrl,
  })));
});

test("network queries deduplicated followed accounts and excludes self and private profiles", async (t) => {
  const route = installNetworkRoute(t, {
    follows: [
      { followingId: VIEWER },
      { followingId: "" },
      {},
      { followingId: "user_alex" },
      { followingId: "user_alex" },
      { followingId: "user_private" },
    ],
    privateProfiles: [{ userId: "user_private" }],
  });
  assert.deepEqual(await route.request(), { status: 200, body: [] });
  assert.deepEqual(route.calls.profiles, [{
    filter: { userId: { $in: ["user_alex", "user_private"] }, isPrivate: true },
    select: "userId",
    lean: true,
  }]);
  assert.equal(route.calls.aggregates.length, 1);
  assert.deepEqual(route.calls.aggregates[0][0], { $match: { userId: { $in: ["user_alex"] } } });
  assert.deepEqual(route.calls.authors, [], "empty review results must not cause an author request");
});

for (const [name, follows] of [
  ["no followed accounts", []],
  ["only empty or self-follow records", [{ followingId: VIEWER }, { followingId: "" }, {}]],
]) {
  test(`network short-circuits with ${name}`, async (t) => {
    const route = installNetworkRoute(t, { follows });
    assert.deepEqual(await route.request(), { status: 200, body: [] });
    assert.equal(route.calls.follows.length, 1);
    assert.deepEqual(route.calls.profiles, []);
    assert.deepEqual(route.calls.aggregates, []);
    assert.deepEqual(route.calls.authors, []);
  });
}

test("network short-circuits when every followed profile is private", async (t) => {
  const route = installNetworkRoute(t, {
    follows: [{ followingId: "user_private" }],
    privateProfiles: [{ userId: "user_private" }],
  });
  assert.deepEqual(await route.request(), { status: 200, body: [] });
  assert.equal(route.calls.profiles.length, 1);
  assert.deepEqual(route.calls.aggregates, []);
  assert.deepEqual(route.calls.authors, []);
});

test("network pipeline filters followed users and missing catalog rows before its deterministic top-20 limit", () => {
  const { NETWORK_ACTIVITY_LIMIT, buildNetworkReviewsPipeline } = require("../routes/utils/networkActivity");
  assert.equal(NETWORK_ACTIVITY_LIMIT, 20);
  const pipeline = buildNetworkReviewsPipeline(["user_alex", "user_sam"], VIEWER);
  assert.deepEqual(pipeline[0], { $match: { userId: { $in: ["user_alex", "user_sam"] } } });
  const catalogIndex = pipeline.findIndex((stage) => stage.$lookup?.from === AlbumCatalog.collection.name);
  const limitIndex = pipeline.findIndex((stage) => stage.$limit);
  const sortIndex = pipeline.findIndex((stage) => stage.$sort);
  assert.ok(catalogIndex >= 0 && catalogIndex < limitIndex, "join current albums before limiting results");
  assert.deepEqual(pipeline[catalogIndex + 1], { $unwind: "$catalogAlbum" });
  assert.ok(catalogIndex + 1 < limitIndex, "missing albums must not consume a result slot");
  assert.ok(sortIndex >= 0 && sortIndex < limitIndex);
  assert.deepEqual(pipeline[sortIndex], { $sort: { date: -1, _id: -1 } });
  assert.equal(pipeline[limitIndex].$limit, 20);
});

test("network pipeline counts only review likes and computes the authenticated viewer's like state", () => {
  const { buildNetworkReviewsPipeline } = require("../routes/utils/networkActivity");
  const pipeline = buildNetworkReviewsPipeline(["user_alex"], VIEWER);
  const lookup = pipeline.find((stage) => stage.$lookup?.from === Like.collection.name)?.$lookup;
  assert.ok(lookup, "network reviews need a like-state lookup");
  assert.deepEqual(lookup.let, { currentReviewId: "$_id" });
  assert.deepEqual(lookup.pipeline[0], {
    $match: {
      $expr: {
        $and: [
          { $eq: ["$targetType", "review"] },
          { $eq: ["$reviewId", "$$currentReviewId"] },
        ],
      },
    },
  });
  assert.deepEqual(lookup.pipeline[1].$group, {
    _id: null,
    count: { $sum: 1 },
    viewerCount: { $sum: { $cond: [{ $eq: ["$userId", VIEWER] }, 1, 0] } },
  });
  const projection = pipeline.at(-1).$project;
  assert.equal(projection.reviewId, 1);
  assert.deepEqual(projection.likeCount, { $ifNull: [{ $arrayElemAt: ["$likeStats.count", 0] }, 0] });
  assert.deepEqual(projection.likedByViewer, { $gt: [{ $ifNull: [{ $arrayElemAt: ["$likeStats.viewerCount", 0] }, 0] }, 0] });
});

for (const [name, options] of [
  ["an author is absent from Clerk", { users: [] }],
  ["Clerk is unavailable", { authorError: new Error("Clerk unavailable") }],
]) {
  test(`network keeps useful activity when ${name}`, async (t) => {
    const row = reviewRow("user_alex");
    const route = installNetworkRoute(t, { rows: [row], ...options });
    const result = await route.request();
    assert.equal(result.status, 200);
    assert.equal(result.body[0].id, row.reviewId);
    assert.equal(result.body[0].reviewId, row.reviewId);
    assert.deepEqual(result.body[0].actor, { userId: "user_alex", username: "rescened user", imageUrl: "" });
    assert.equal(result.body[0].album.albumId, ALBUM_ID);
    assert.equal(result.body[0].likedByViewer, true);
  });
}

for (const failureKey of ["followError", "profileError", "reviewError", "listenError"]) {
  test(`network sanitizes ${failureKey} failures`, async (t) => {
    const error = Object.assign(new Error("mongodb://secret-user:secret-password@internal-host/private-db"), { status: 503, code: "INTERNAL_SECRET" });
    const route = installNetworkRoute(t, { [failureKey]: error });
    assert.deepEqual(await route.request(), {
      status: 500,
      body: { error: "Failed to fetch network activity" },
    });
    assert.deepEqual(route.calls.authors, []);
  });
}
