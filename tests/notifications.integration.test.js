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
const { applyModerationCommand } = require("../routes/utils/moderationCommands");
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

test("a failed moderation transition leaves neither the status change nor the notification", { skip: !enabled }, async (t) => {
  const submission = await createSubmission("Rolled Back Album", "contributor-rollback");
  t.mock.method(Notification, "updateOne", async () => { throw new Error("forced notification failure"); });
  await assert.rejects(
    applyModerationCommand({ submissionId: submission.submissionId, actorUserId: "moderator", action: "reject", body: { reason: "Nope" } }),
    /forced notification failure/,
  );
  t.mock.restoreAll();
  const persisted = await AlbumSubmission.findOne({ submissionId: submission.submissionId }).lean();
  assert.equal(persisted.status, "pending");
  assert.equal(persisted.moderationHistory.length, 1);
  assert.equal(await Notification.countDocuments({ recipientUserId: "contributor-rollback" }), 0);

  await applyModerationCommand({ submissionId: submission.submissionId, actorUserId: "moderator-secret-id", action: "request_changes", body: { reason: "Add a source" } });
  const [row] = await Notification.find({ recipientUserId: "contributor-rollback" }).lean();
  assert.equal(row.type, "suggestion_status");
  assert.equal(row.submissionStatus, "needs_changes");
  assert.equal(row.submissionRevision, 1);
  assert.equal(row.actorUserId, Notification.MODERATION_ACTOR_ID);

  const [serialized] = await serializeNotifications([row], new Map());
  assert.equal(serialized.actor.username, "Rescened moderators");
  assert.equal(serialized.actorUserId, null);
  assert.deepEqual(serialized.subject, {
    submissionId: submission.submissionId, submissionType: "new_album", title: "Rolled Back Album", status: "needs_changes",
  });
  assert.equal(JSON.stringify(serialized).includes("moderator-secret-id"), false, "the moderator's ID never reaches the contributor");
  assert.equal(JSON.stringify(serialized).includes(String(submission._id)), false);
});

test("approval writes exactly one notification across retries and concurrent approvals", { skip: !enabled }, async () => {
  const submission = await createSubmission("Notified Album", "contributor-approved");
  const approve = (actorUserId) => approveAlbumSubmission({
    submissionId: submission.submissionId, actorUserId, confirmPossibleDuplicate: true, coverResolver: null,
  });
  const results = await Promise.all([approve("moderator-a"), approve("moderator-b")]);
  await approve("moderator-a");
  const rows = await Notification.find({ recipientUserId: "contributor-approved" }).lean();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].submissionStatus, "approved");
  const [serialized] = await serializeNotifications(rows, new Map());
  assert.equal(serialized.subject.albumId, results[0].album.albumId);
});

test("followed reviews reach followers with the album on a board, once, and leave with the review", { skip: !enabled }, async () => {
  const album = await createAlbum("Shared Shelf");
  const reviewer = "fan-reviewer";
  await follow("saved-follower", reviewer, new Date("2026-10-01"));
  await follow("listened-follower", reviewer, new Date("2026-10-02"));
  await follow("unrelated-follower", reviewer, new Date("2026-10-03"));
  await follow("muted-follower", reviewer, new Date("2026-10-04"));
  await saveAlbum("saved-follower", album);
  await linkListen("listened-follower", album);
  await saveAlbum("muted-follower", album);
  await saveAlbum("not-a-follower", album);
  await UserProfile.create({ userId: "muted-follower", notificationPreferences: { followed_review: false } });

  const review = await Review.create({ userId: reviewer, albumCatalogId: album._id, rating: 5, reviewText: "Shared" });
  const first = await fanOutFollowedReview(review, { logger: quietLogger() });
  const retry = await fanOutFollowedReview(review, { logger: quietLogger() });
  assert.equal(first.notified, 2);
  assert.equal(retry.notified, 2);
  const rows = await Notification.find({ type: "followed_review", reviewId: review._id }).lean();
  assert.deepEqual(rows.map((row) => row.recipientUserId).sort(), ["listened-follower", "saved-follower"]);
  assert.ok(rows.every((row) => row.actorUserId === reviewer));

  await deleteOwnedReview(review.reviewId, reviewer);
  assert.equal(await Notification.countDocuments({ reviewId: review._id }), 0);
});

test("the fan-out cap keeps the most recent follows and logs the skip", { skip: !enabled }, async () => {
  const album = await createAlbum("Capped Shelf");
  const reviewer = "capped-reviewer";
  for (const [index, follower] of ["oldest", "middle", "newest"].entries()) {
    await follow(`cap-${follower}`, reviewer, new Date(Date.UTC(2026, 9, 1 + index)));
    await saveAlbum(`cap-${follower}`, album);
  }
  const review = await Review.create({ userId: reviewer, albumCatalogId: album._id, rating: 3, reviewText: "Capped" });
  const logger = quietLogger();
  const result = await fanOutFollowedReview(review, { cap: 2, logger });
  assert.deepEqual(result, { notified: 2, skipped: 1 });
  const recipients = (await Notification.find({ type: "followed_review", reviewId: review._id }).lean()).map((row) => row.recipientUserId);
  assert.deepEqual(recipients.sort(), ["cap-middle", "cap-newest"]);
  assert.equal(logger.warnings.length, 1);
  assert.equal(logger.warnings[0][1].reviewId, review.reviewId);
  assert.equal(logger.warnings[0][1].skipped, 1);
});

test("a fan-out for a review deleted mid-run leaves no rows behind", { skip: !enabled }, async () => {
  const album = await createAlbum("Vanishing Review");
  await follow("vanish-follower", "vanish-reviewer", new Date());
  await saveAlbum("vanish-follower", album);
  const review = await Review.create({ userId: "vanish-reviewer", albumCatalogId: album._id, rating: 2, reviewText: "Gone" });
  await Review.deleteOne({ _id: review._id });
  const result = await fanOutFollowedReview(review, { logger: quietLogger() });
  assert.equal(result.notified, 0);
  assert.equal(await Notification.countDocuments({ reviewId: review._id }), 0);
});
