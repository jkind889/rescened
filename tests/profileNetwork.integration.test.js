const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const AlbumCatalog = require("../models/AlbumCatalog");
const Follow = require("../models/Follow");
const UserProfile = require("../models/UserProfile");
const Review = require("../models/Reviews");
const Like = require("../models/Like");
const { createCatalogAlbum, UUID_V4 } = require("../routes/utils/albumCatalog");
const { getNetworkActivity, NETWORK_ACTIVITY_LIMIT } = require("../routes/utils/networkActivity");
const { suggestPeople } = require("../routes/utils/peopleSuggestions");

const enabled = String(process.env.RUN_MONGO_INTEGRATION || "").toLowerCase() === "true";
const collections = [AlbumCatalog, Follow, UserProfile, Review, Like];
let replSet;
let albumSequence = 0;

function objectId(value) {
  return new mongoose.Types.ObjectId(value.toString(16).padStart(24, "0"));
}

async function createAlbum(title) {
  albumSequence += 1;
  return createCatalogAlbum({
    albumId: `00000000-0000-4000-8000-${String(albumSequence).padStart(12, "0")}`,
    title,
    artistDisplayName: "Network Artist",
    releaseDate: "2026",
    tracks: [],
  });
}

function reviewRow(id, album, userId, date) {
  return {
    _id: objectId(id),
    reviewId: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    albumCatalogId: album._id,
    userId,
    rating: 4.5,
    reviewText: `Review ${id}`,
    date: new Date(date),
  };
}

async function authors(userIds) {
  return new Map(userIds.map((userId) => [userId, {
    userId,
    username: `${userId}-name`,
    imageUrl: `https://example.test/${userId}.png`,
  }]));
}

test.before(async () => {
  if (!enabled) return;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: "rescened_profile_network" });
  await Promise.all(collections.map((model) => model.syncIndexes()));
});

test.beforeEach(async () => {
  if (!enabled) return;
  await Promise.all(collections.map((model) => model.deleteMany({})));
  albumSequence = 0;
});

test.after(async () => {
  if (!enabled) return;
  if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
});

test("network feed is empty without visible followed users and does not fetch authors", { skip: !enabled }, async () => {
  const album = await createAlbum("No follows");
  await Review.create(reviewRow(1, album, "unfollowed", "2026-09-03T12:00:00Z"));
  const unexpectedAuthors = async () => assert.fail("An empty feed must not fetch author profiles");
  assert.deepEqual(await getNetworkActivity("viewer", unexpectedAuthors), []);

  await Follow.create([
    { followerId: "viewer", followingId: "viewer" },
    { followerId: "viewer", followingId: "private" },
  ]);
  await UserProfile.create({ userId: "private", isPrivate: true });
  await Review.create([
    reviewRow(2, album, "viewer", "2026-09-03T13:00:00Z"),
    reviewRow(3, album, "private", "2026-09-03T14:00:00Z"),
  ]);
  assert.deepEqual(await getNetworkActivity("viewer", unexpectedAuthors), []);
});

test("network feed merges followed public users globally and filters excluded users before the newest-20 limit", { skip: !enabled }, async () => {
  const album = await createAlbum("Shared catalog album");
  const followedUsers = ["public-a", "public-b", "no-profile"];
  await Follow.create([...followedUsers, "private", "viewer"].map((followingId) => ({ followerId: "viewer", followingId })));
  await UserProfile.create([
    { userId: "public-a", isPrivate: false },
    { userId: "public-b" },
    { userId: "private", isPrivate: true },
  ]);
  const visibleRows = Array.from({ length: 25 }, (_, index) => reviewRow(
    index + 1,
    album,
    followedUsers[index % followedUsers.length],
    new Date(Date.UTC(2026, 8, 1, index)),
  ));
  // Equal dates deliberately have different IDs: the larger ID must come first.
  visibleRows.push(reviewRow(100, album, "public-a", "2026-09-03T12:00:00Z"));
  visibleRows.push(reviewRow(101, album, "public-b", "2026-09-03T12:00:00Z"));
  const excludedRows = ["private", "viewer", "unfollowed"].flatMap((userId, userIndex) => (
    Array.from({ length: 25 }, (_, index) => reviewRow(
      1000 + userIndex * 100 + index,
      album,
      userId,
      new Date(Date.UTC(2026, 8, 4, index)),
    ))
  ));
  await Review.insertMany([...visibleRows, ...excludedRows]);

  const requestedAuthors = [];
  const result = await getNetworkActivity("viewer", async (userIds) => {
    requestedAuthors.push(...userIds);
    return authors(userIds);
  });
  const expected = visibleRows.sort((left, right) => (
    right.date - left.date || String(right._id).localeCompare(String(left._id))
  )).slice(0, NETWORK_ACTIVITY_LIMIT);

  assert.equal(result.length, 20);
  assert.deepEqual(result.map((item) => item.id), expected.map((row) => row.reviewId));
  assert.deepEqual(result.slice(0, 2).map((item) => item.id), ["00000000-0000-4000-8000-000000000101", "00000000-0000-4000-8000-000000000100"]);
  assert.deepEqual(new Set(result.map((item) => item.userId)), new Set(followedUsers));
  assert.deepEqual(new Set(requestedAuthors), new Set(followedUsers));
  assert.equal(await UserProfile.exists({ userId: "no-profile" }), null);
  for (const item of result) {
    assert.equal(item.type, "review");
    assert.equal(item.id, item.reviewId);
    assert.equal(item.actor.userId, item.userId);
    assert.equal(item.actor.username, `${item.userId}-name`);
    assert.equal(item.likeCount, 0);
    assert.equal(item.likedByViewer, false);
  }
  assert.deepEqual((await getNetworkActivity("viewer", authors)).map((item) => item.id), result.map((item) => item.id));
});

test("missing and deleted catalog rows cannot consume network feed slots", { skip: !enabled }, async () => {
  const album = await createAlbum("Available");
  const deletedAlbum = await createAlbum("Deleted");
  await Follow.create({ followerId: "viewer", followingId: "followed" });
  const validRows = Array.from({ length: 21 }, (_, index) => reviewRow(
    index + 1, album, "followed", new Date(Date.UTC(2026, 8, 1, index)),
  ));
  const unavailableRows = [deletedAlbum, { _id: objectId(99999) }].flatMap((missingAlbum, albumIndex) => (
    Array.from({ length: 25 }, (_, index) => reviewRow(
      1000 + albumIndex * 100 + index,
      missingAlbum,
      "followed",
      new Date(Date.UTC(2026, 8, 4, index)),
    ))
  ));
  await Review.insertMany([...validRows, ...unavailableRows]);
  await AlbumCatalog.deleteOne({ _id: deletedAlbum._id });

  const result = await getNetworkActivity("viewer", async () => new Map());
  assert.equal(result.length, 20);
  assert.deepEqual(result.map((item) => item.id), validRows.slice(1).reverse().map((row) => row.reviewId));
  assert.ok(result.every((item) => item.album.albumId === album.albumId));
  assert.deepEqual(result[0].actor, { userId: "followed", username: "rescened user", imageUrl: "" });
});

test("network activities use current catalog metadata and review-specific viewer like state", { skip: !enabled }, async () => {
  const album = await createAlbum("Original title");
  await Follow.create({ followerId: "viewer", followingId: "followed" });
  const [liked, otherLiked, zeroLikes, unrelated] = await Review.create([
    reviewRow(1, album, "followed", "2026-09-03T12:00:00Z"),
    reviewRow(2, album, "followed", "2026-09-03T11:00:00Z"),
    reviewRow(3, album, "followed", "2026-09-03T10:00:00Z"),
    reviewRow(4, album, "unfollowed", "2026-09-03T13:00:00Z"),
  ]);
  await Like.create([
    { userId: "viewer", targetType: "review", reviewId: liked._id },
    { userId: "another-liker", targetType: "review", reviewId: liked._id },
    { userId: "another-liker", targetType: "review", reviewId: otherLiked._id },
    { userId: "viewer", targetType: "review", reviewId: unrelated._id },
    { userId: "viewer", targetType: "album", albumCatalogId: album._id },
  ]);
  const before = await getNetworkActivity("viewer", authors);
  assert.ok(before.every((item) => item.album.title === "Original title"));

  await AlbumCatalog.updateOne({ _id: album._id }, {
    $set: { title: "Updated title", artistDisplayName: "Updated Artist", cover: "https://example.test/new-cover.jpg" },
  });
  const result = await getNetworkActivity("viewer", authors);
  assert.deepEqual(result.map((item) => [item.id, item.likeCount, item.likedByViewer]), [
    [liked.reviewId, 2, true],
    [otherLiked.reviewId, 1, false],
    [zeroLikes.reviewId, 0, false],
  ]);
  const reviewTextById = new Map([liked, otherLiked, zeroLikes].map((review) => [review.reviewId, review.reviewText]));
  for (const item of result) {
    assert.equal(item.album.albumId, album.albumId);
    assert.match(item.album.albumId, UUID_V4);
    assert.equal(item.album.title, "Updated title");
    assert.equal(item.album.artistDisplayName, "Updated Artist");
    assert.equal(item.album.cover, "https://example.test/new-cover.jpg");
    assert.equal(item.rating, 4.5);
    assert.ok(item.createdAt instanceof Date);
    assert.equal(item.id, item.reviewId);
    assert.equal(item.reviewText, reviewTextById.get(item.reviewId));
    assert.equal(Object.hasOwn(item.album, "_id"), false);
    assert.equal(Object.hasOwn(item, "albumCatalogId"), false);
    assert.equal(Object.hasOwn(item, "interactionRevision"), false);
    assert.equal(Object.hasOwn(item, "_id"), false);
    assert.equal(JSON.stringify(item).includes(String(album._id)), false);
  }
});

test("people suggestions rank active public reviewers outside the viewer's circle", { skip: !enabled }, async () => {
  const now = new Date("2026-09-30T12:00:00Z");
  const album = await createAlbum("Suggested");
  await Review.create([
    reviewRow(1, album, "busy", "2026-09-20T12:00:00Z"),
    reviewRow(2, album, "busy", "2026-09-21T12:00:00Z"),
    reviewRow(3, album, "veteran", "2026-01-01T12:00:00Z"),
    reviewRow(4, album, "veteran", "2026-01-02T12:00:00Z"),
    reviewRow(5, album, "veteran", "2026-01-03T12:00:00Z"),
    reviewRow(6, album, "recent-one", "2026-09-25T12:00:00Z"),
    reviewRow(7, album, "viewer", "2026-09-26T12:00:00Z"),
    reviewRow(8, album, "followed", "2026-09-27T12:00:00Z"),
    reviewRow(9, album, "hidden", "2026-09-28T12:00:00Z"),
    reviewRow(10, album, Review.DELETED_AUTHOR_ID, "2026-09-29T12:00:00Z"),
  ]);
  await Follow.create({ followerId: "viewer", followingId: "followed" });
  await UserProfile.create({ userId: "hidden", isPrivate: true });

  const people = await suggestPeople({ viewerId: "viewer", now, authors });
  // Recent activity outranks all-time totals; the viewer, people they follow,
  // private profiles, and deleted authors are never suggested.
  assert.deepEqual(people.map((person) => person.userId), ["busy", "recent-one", "veteran"]);
  assert.deepEqual(people[0], {
    userId: "busy",
    username: "busy-name",
    imageUrl: "https://example.test/busy.png",
    recentReviewCount: 2,
    reviewCount: 2,
    isFollowing: false,
  });
  assert.equal(people[2].recentReviewCount, 0);
  assert.equal(people[2].reviewCount, 3);

  const signedOut = await suggestPeople({ now, authors, limit: "10" });
  assert.deepEqual(signedOut.map((person) => person.userId).sort(), ["busy", "followed", "recent-one", "veteran", "viewer"]);
  assert.deepEqual((await suggestPeople({ viewerId: "viewer", now, authors, limit: "1" })).map((person) => person.userId), ["busy"]);
});
