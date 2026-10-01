const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { once } = require("node:events");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const AlbumCatalog = require("../models/AlbumCatalog");
const AlbumSubmission = require("../models/AlbumSubmission");
const Board = require("../models/Board");
const BoardItem = require("../models/BoardItem");
const BoardListen = require("../models/BoardListen");
const Follow = require("../models/Follow");
const Like = require("../models/Like");
const Listen = require("../models/Listen");
const ListenCreation = require("../models/ListenCreation");
const Notification = require("../models/Notification");
const Review = require("../models/Reviews");
const UserProfile = require("../models/UserProfile");
const Listening = require("../models/Listening");
const Automatic = require("../models/AutomaticListen");
const { cleanupUserData } = require("../lib/listening/connections");
const { createListen } = require("../routes/utils/listeningDiary");
const { setMembership, saveAlbum } = require("../routes/utils/boardMutations");
const { mutateReviewLike } = require("../routes/utils/reviewInteractions");

const enabled = process.env.RUN_MONGO_INTEGRATION === "true";
const models = [
  AlbumCatalog, AlbumSubmission, Board, BoardItem, BoardListen, Follow, Like, Listen, ListenCreation, Notification, Review, UserProfile,
  ...Object.values(Listening), ...Object.values(Automatic),
];
let replSet;
let server;
let baseUrl;
let deleted;
let other;
let album;
let board;
let secondBoard;
let otherBoard;

const integration = (name, fn) => test(name, { skip: !enabled }, fn);

function log(userId, overrides = {}) {
  return createListen(userId, { albumId: album.albumId, listenedOn: "2020-01-02", timeZone: "UTC", ...overrides }, crypto.randomUUID());
}
async function request(path, userId = "") {
  const response = await fetch(`${baseUrl}${path}`, { headers: { "x-test-user": userId } });
  return { status: response.status, body: await response.json() };
}
async function diaryCounts(userId) {
  const [listens, memberships, receipts] = await Promise.all([
    Listen.countDocuments({ userId }), BoardListen.countDocuments({ userId }), ListenCreation.countDocuments({ userId }),
  ]);
  return { listens, memberships, receipts };
}
async function accountCounts(userId) {
  const [boards, items, likes, follows, notifications, profiles, reviews] = await Promise.all([
    Board.countDocuments({ userId }), BoardItem.countDocuments({ userId }), Like.countDocuments({ userId }),
    Follow.countDocuments({ $or: [{ followerId: userId }, { followingId: userId }] }),
    Notification.countDocuments({ $or: [{ recipientUserId: userId }, { actorUserId: userId }] }),
    UserProfile.countDocuments({ userId }), Review.countDocuments({ userId }),
  ]);
  return { ...(await diaryCounts(userId)), boards, items, likes, follows, notifications, profiles, reviews };
}

test.before(async () => {
  if (!enabled) return;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: "rescened_account_deletion" });
  await Promise.all(models.map((model) => model.syncIndexes()));
  const clerkPath = require.resolve("@clerk/express");
  const previous = require.cache[clerkPath];
  require.cache[clerkPath] = {
    id: clerkPath, filename: clerkPath, loaded: true,
    exports: {
      getAuth: (req) => ({ userId: req.headers["x-test-user"] || null }),
      clerkClient: { users: { getUserList: async () => ({ data: [] }) } },
    },
  };
  const app = express();
  app.use(express.json());
  app.use("/reviews", require("../routes/reviews"));
  app.use("/profile", require("../routes/profile"));
  if (previous) require.cache[clerkPath] = previous;
  else delete require.cache[clerkPath];
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(async () => {
  if (!enabled) return;
  await Promise.all(models.map((model) => model.deleteMany({})));
  deleted = `deleted-${crypto.randomUUID()}`;
  other = `other-${crypto.randomUUID()}`;
  album = await AlbumCatalog.create({ albumId: crypto.randomUUID(), title: "Account album", artistDisplayName: "An artist", catalogSource: "manual" });
  board = await Board.create({ userId: deleted, title: "Mornings" });
  secondBoard = await Board.create({ userId: deleted, title: "January" });
  otherBoard = await Board.create({ userId: other, title: "Other" });
});

test.after(async () => {
  if (!enabled) return;
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
});

integration("account deletion removes diary, boards, social data, and profile, and anonymizes reviews", async () => {
  // Deleted user's diary, boards, and saved albums.
  await log(deleted, { boardIds: [board.boardId, secondBoard.boardId] });
  await log(deleted, { listenedOn: "2020-01-03" });
  await setMembership(deleted, board.boardId, (await log(deleted, { listenedOn: "2020-01-04" })).listen.listenId, true);
  await saveAlbum(deleted, board.boardId, album._id);
  // Another user's data that must survive.
  await log(other, { boardIds: [otherBoard.boardId] });
  await saveAlbum(other, otherBoard.boardId, album._id);
  await UserProfile.updateOne({ userId: other }, { $set: { pinnedBoardId: otherBoard._id } });
  // Reviews, likes, follows, and notifications in both directions.
  const review = await Review.create({ userId: deleted, albumCatalogId: album._id, rating: 4, reviewText: "Kept anonymously", creationKey: crypto.randomUUID() });
  const otherReview = await Review.create({ userId: other, albumCatalogId: album._id, rating: 3, reviewText: "Other review" });
  await UserProfile.updateOne({ userId: deleted }, { $set: { pinnedReviewId: review._id, pinnedBoardId: board._id } });
  await mutateReviewLike(review.reviewId, other, true);
  await mutateReviewLike(otherReview.reviewId, deleted, true);
  await Like.create({ userId: deleted, targetType: "album", albumCatalogId: album._id });
  await Follow.create([{ followerId: deleted, followingId: other }, { followerId: other, followingId: deleted }]);
  await Notification.create([
    { recipientUserId: other, actorUserId: deleted, type: "follow" },
    { recipientUserId: deleted, actorUserId: other, type: "follow" },
  ]);
  const submission = await AlbumSubmission.collection.insertOne({ submittedByUserId: deleted, status: "pending" });
  assert.equal((await request(`/profile/${deleted}`)).status, 200);
  const otherBefore = await accountCounts(other);
  const revisionBefore = (await Review.findById(review._id).select("+interactionRevision").lean()).interactionRevision;

  await cleanupUserData(deleted);

  assert.deepEqual(await accountCounts(deleted), {
    listens: 0, memberships: 0, receipts: 0, boards: 0, items: 0, likes: 0, follows: 0, notifications: 0, profiles: 0, reviews: 0,
  });
  assert.equal(await BoardListen.countDocuments({ boardId: { $in: [board._id, secondBoard._id] } }), 0);
  // The other user keeps everything except the follow edge and notification involving the deleted user.
  assert.deepEqual(await accountCounts(other), { ...otherBefore, follows: 0, notifications: 0 });
  assert.equal(String((await UserProfile.findOne({ userId: other }).lean()).pinnedBoardId), String(otherBoard._id));
  assert.ok(await Like.exists({ userId: other, targetType: "review", reviewId: review._id }));
  // Submissions are append-only moderation history and stay unchanged.
  assert.equal((await AlbumSubmission.collection.findOne({ _id: submission.insertedId })).submittedByUserId, deleted);

  const anonymized = await Review.findById(review._id).select("+creationKey +interactionRevision").lean();
  assert.equal(anonymized.userId, Review.DELETED_AUTHOR_ID);
  assert.equal(anonymized.reviewId, review.reviewId);
  assert.equal(anonymized.creationKey, undefined);
  assert.equal(anonymized.interactionRevision, revisionBefore + 1);

  // Public responses show an anonymous author with no profile link or internal sentinel.
  const albumReviews = await request(`/reviews/review/album/${album.albumId}`);
  assert.equal(albumReviews.status, 200);
  const shown = albumReviews.body.reviews.find((item) => item.reviewId === review.reviewId);
  assert.equal(shown.userId, null);
  assert.deepEqual(shown.author, { userId: null, username: "deleted user", imageUrl: "" });
  assert.equal(shown.likeCount, 1);
  assert.equal(JSON.stringify(albumReviews.body).includes(Review.DELETED_AUTHOR_ID), false);
  assert.equal(JSON.stringify(albumReviews.body).includes(deleted), false);

  // Neither the deleted user nor the sentinel resolves to a profile or review list.
  assert.equal((await request(`/profile/${deleted}`)).status, 404);
  assert.equal((await request(`/profile/${encodeURIComponent(Review.DELETED_AUTHOR_ID)}`)).status, 404);
  assert.equal(await UserProfile.exists({ userId: Review.DELETED_AUTHOR_ID }), null);
  assert.deepEqual((await request(`/reviews/review/user/${encodeURIComponent(Review.DELETED_AUTHOR_ID)}`)).body, { reviews: [], nextCursor: null });
  assert.deepEqual((await request(`/reviews/review/user/${deleted}`)).body.reviews, []);

  // Liking an anonymized review never notifies the sentinel author.
  const third = `third-${crypto.randomUUID()}`;
  await mutateReviewLike(review.reviewId, third, true);
  assert.equal(await Notification.countDocuments({ recipientUserId: Review.DELETED_AUTHOR_ID }), 0);
  assert.equal(await Like.countDocuments({ targetType: "review", reviewId: review._id }), 2);

  // A retried deletion webhook is idempotent.
  await cleanupUserData(deleted);
  assert.equal(await Review.countDocuments({ userId: Review.DELETED_AUTHOR_ID }), 1);
  assert.deepEqual(await accountCounts(other), { ...otherBefore, follows: 0, notifications: 0 });
});

integration("account deletion removes the Last.fm connection and its private evidence without the worker", async () => {
  // Raw inserts: deletion only filters on userId and connectionId.
  const { Connection, Scrobble, Detection, DetectionEvidence, Job } = Listening;
  async function lastfmAccount(userId, username) {
    const { insertedId: connectionId } = await Connection.collection.insertOne({ userId, username, usernameKey: username, state: "active", revision: 1 });
    await Scrobble.collection.insertOne({ eventId: crypto.randomUUID(), connectionId, identityKey: `${username}-event`, artist: "Artist", album: "Album", track: "Track" });
    await Detection.collection.insertOne({ connectionId, userId, sessionId: crypto.randomUUID() });
    await DetectionEvidence.collection.insertOne({ connectionId, sessionId: crypto.randomUUID(), eventId: crypto.randomUUID() });
    await Job.collection.insertOne({ key: `sync:${connectionId}`, type: "sync", status: "pending", payload: { connectionId: String(connectionId), connectionRevision: 1 }, runAt: new Date() });
    return connectionId;
  }
  const deletedConnection = await lastfmAccount(deleted, "deleted-listener");
  const otherConnection = await lastfmAccount(other, "other-listener");
  // Awaiting worker cleanup after a disconnect: still removed immediately.
  await Connection.collection.updateOne({ _id: deletedConnection }, { $set: { state: "disconnected", revision: 2 } });

  const result = await cleanupUserData(deleted);

  assert.deepEqual(result, { removed: 1 });
  assert.equal(await Connection.countDocuments({ userId: deleted }), 0);
  assert.equal(await Connection.exists({ username: "deleted-listener" }), null);
  for (const Model of [Scrobble, Detection, DetectionEvidence]) {
    assert.equal(await Model.countDocuments({ connectionId: deletedConnection }), 0);
    assert.equal(await Model.countDocuments({ connectionId: otherConnection }), 1);
  }
  // Jobs keep no reference to the removed connection, and no cleanup job is queued.
  assert.deepEqual((await Job.findOne({ key: `sync:${deletedConnection}` }).lean()).payload, {});
  assert.equal(await Job.countDocuments({ "payload.connectionId": String(deletedConnection) }), 0);
  assert.equal(await Job.countDocuments({ type: "cleanup" }), 0);
  assert.equal((await Job.findOne({ key: `sync:${otherConnection}` }).lean()).payload.connectionId, String(otherConnection));
  assert.equal((await Connection.findById(otherConnection).lean()).username, "other-listener");

  // A retried webhook finds nothing left to remove.
  assert.deepEqual(await cleanupUserData(deleted), { removed: 0 });
});

integration("account deletion rolls back every removal when the cleanup transaction does not commit", async () => {
  await log(deleted, { boardIds: [board.boardId] });
  await saveAlbum(deleted, board.boardId, album._id);
  const review = await Review.create({ userId: deleted, albumCatalogId: album._id, rating: 4, reviewText: "Rolled back", creationKey: crypto.randomUUID() });
  await Like.create({ userId: deleted, targetType: "album", albumCatalogId: album._id });
  await Follow.create({ followerId: other, followingId: deleted });
  await Notification.create({ recipientUserId: deleted, actorUserId: other, type: "follow" });
  const { insertedId: connectionId } = await Listening.Connection.collection.insertOne({ userId: deleted, username: "kept-listener", usernameKey: "kept-listener", state: "active", revision: 1 });
  await Listening.Scrobble.collection.insertOne({ eventId: crypto.randomUUID(), connectionId, identityKey: "kept-event" });
  const before = await accountCounts(deleted);
  const sessionFactory = async () => {
    const session = await mongoose.startSession();
    session.commitTransaction = async () => { throw new Error("synthetic commit failure"); };
    return session;
  };

  await assert.rejects(cleanupUserData(deleted, { sessionFactory }), /synthetic commit failure/);

  assert.deepEqual(await accountCounts(deleted), before);
  assert.deepEqual(before, {
    listens: 1, memberships: 1, receipts: 1, boards: 2, items: 1, likes: 1, follows: 1, notifications: 1, profiles: 1, reviews: 1,
  });
  assert.ok((await Review.findById(review._id).select("+creationKey").lean()).creationKey);
  assert.equal((await Listening.Connection.findById(connectionId).lean()).state, "active");
  assert.equal(await Listening.Scrobble.countDocuments({ connectionId }), 1);
});
