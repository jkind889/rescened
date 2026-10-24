const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const AlbumCatalog = require("../models/AlbumCatalog");
const AlbumSubmission = require("../models/AlbumSubmission");
const Board = require("../models/Board");
const BoardItem = require("../models/BoardItem");
const BoardListen = require("../models/BoardListen");
const Follow = require("../models/Follow");
const Listen = require("../models/Listen");
const Notification = require("../models/Notification");
const Review = require("../models/Reviews");
const UserProfile = require("../models/UserProfile");
const { createCatalogAlbum } = require("../routes/utils/albumCatalog");
const { approveAlbumSubmission } = require("../routes/utils/approval");
const { deleteOwnedReview, mutateReviewLike } = require("../routes/utils/reviewInteractions");
const {
  clearNotifications,
  fanOutFollowedReview,
  markRead,
  readPage,
  recordFollow,
  serializeNotifications,
  unreadCount,
} = require("../routes/utils/notifications");
const { findDuplicateSignals, normalizeSubmissionPayload, snapshotForSubmission } = require("../routes/utils/submissions");

const enabled = String(process.env.RUN_MONGO_INTEGRATION || "").toLowerCase() === "true";
let replSet;

test.before(async () => {
  if (!enabled) return;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: "rescened_notifications" });
  await Promise.all([AlbumCatalog, AlbumSubmission, Board, BoardItem, BoardListen, Follow, Listen, Notification, Review, UserProfile]
    .map((Model) => Model.syncIndexes()));
});

test.after(async () => {
  if (!enabled) return;
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await replSet.stop();
});

function quietLogger() {
  const warnings = [];
  return { warnings, warn: (...args) => warnings.push(args) };
}

async function createAlbum(title) {
  return createCatalogAlbum({
    albumId: crypto.randomUUID(),
    title,
    artistDisplayName: "Notification Artist",
    artistCredits: [{ name: "Notification Artist", role: "main" }],
    releaseDate: "2026",
    releaseDatePrecision: "year",
    releaseYear: 2026,
    tracks: [],
  });
}

async function createSubmission(title, submittedByUserId) {
  const payload = normalizeSubmissionPayload({
    proposedMetadata: { title, artistCredits: [{ name: "Notification Artist" }], releaseType: "album", releaseDate: "2026" },
    supportingSources: [{ type: "other", url: "https://example.com/evidence" }],
    externalReferences: [],
  });
  const duplicate = await findDuplicateSignals(payload);
  const submittedAt = new Date();
  return AlbumSubmission.create({
    submissionId: crypto.randomUUID(),
    submittedByUserId,
    proposedMetadata: payload.proposedMetadata,
    supportingSources: payload.supportingSources,
    externalReferences: payload.externalReferences,
    normalizedFingerprint: duplicate.fingerprint,
    candidateAlbumCatalogId: duplicate.candidateAlbumCatalogId,
    candidateSubmissionIds: duplicate.candidateSubmissionIds,
    duplicateSignals: duplicate.duplicateSignals,
    status: "pending",
    currentRevision: 1,
    revisions: [snapshotForSubmission(payload, duplicate, submittedAt, 1)],
    moderationHistory: [{ actorUserId: submittedByUserId, action: "submitted", reason: "", createdAt: submittedAt }],
  });
}

async function follow(followerId, followingId, createdAt) {
  return Follow.create({ followerId, followingId, createdAt, updatedAt: createdAt });
}

async function saveAlbum(userId, album) {
  const board = await Board.create({ userId, title: `${userId} board` });
  await BoardItem.create({ userId, boardId: board._id, albumCatalogId: album._id });
}

async function linkListen(userId, album) {
  const board = await Board.create({ userId, title: `${userId} diary board` });
  const listen = await Listen.create({ userId, albumCatalogId: album._id, listenedOn: "2026-10-01" });
  await BoardListen.create({ userId, boardId: board._id, listenId: listen._id, albumCatalogId: album._id });
}

function profileRoute(t, userId) {
  const clerkPath = require.resolve("@clerk/express");
  const routePath = require.resolve("../routes/profile");
  const oldClerk = require.cache[clerkPath];
  require.cache[clerkPath] = {
    id: clerkPath, filename: clerkPath, loaded: true,
    exports: { getAuth: () => ({ userId }), clerkClient: { users: { getUserList: async () => ({ data: [] }) } } },
  };
  delete require.cache[routePath];
  const router = require(routePath);
  t.after(() => {
    if (oldClerk) require.cache[clerkPath] = oldClerk;
    else delete require.cache[clerkPath];
    delete require.cache[routePath];
  });
  return async (method, path, body) => {
    const layer = router.stack.find((item) => item.route?.path === path && item.route.methods[method]);
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    await layer.route.stack.at(-1).handle({ userId, body, params: {}, query: {} }, res);
    return { status: res.statusCode, body: res.body };
  };
}

test("preferences upsert a missing profile, mute on write, and keep suggestion updates locked", { skip: !enabled }, async (t) => {
  const call = profileRoute(t, "pref-user");
  const initial = await call("get", "/me/notification-preferences");
  assert.deepEqual(initial.body.preferences, { review_like: true, follow: true, followed_review: true, suggestion_status: true });

  await recordFollow({ recipientUserId: "pref-user", actorUserId: "early-follower" });
  const muted = await call("patch", "/me/notification-preferences", { follow: false });
  assert.equal(muted.status, 200);
  assert.equal(muted.body.preferences.follow, false);
  assert.equal(muted.body.preferences.review_like, true);
  assert.equal((await UserProfile.findOne({ userId: "pref-user" })).notificationPreferences.follow, false);

  await recordFollow({ recipientUserId: "pref-user", actorUserId: "late-follower" });
  const rows = await Notification.find({ recipientUserId: "pref-user" }).lean();
  assert.deepEqual(rows.map((row) => row.actorUserId), ["early-follower"], "muting keeps old rows and blocks new ones");

  const locked = await call("patch", "/me/notification-preferences", { suggestion_status: false });
  assert.equal(locked.status, 400);
  assert.equal(locked.body.code, "NOTIFICATION_PREFERENCE_LOCKED");
  const unknown = await call("patch", "/me/notification-preferences", { follow: false, digest: true });
  assert.equal(unknown.body.code, "INVALID_NOTIFICATION_PREFERENCES");
});

test("a muted review author gets no like notification while the like still commits", { skip: !enabled }, async () => {
  const album = await createAlbum("Muted Likes");
  const review = await Review.create({ userId: "quiet-author", albumCatalogId: album._id, rating: 4, reviewText: "Quiet" });
  await UserProfile.create({ userId: "quiet-author", notificationPreferences: { review_like: false } });
  const result = await mutateReviewLike(review.reviewId, "liker", true);
  assert.equal(result.likeCount, 1);
  assert.equal(await Notification.countDocuments({ recipientUserId: "quiet-author" }), 0);
});
