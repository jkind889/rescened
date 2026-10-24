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
const Like = require("../models/Like");
const ListenCreation = require("../models/ListenCreation");
const TrackRanking = require("../models/TrackRanking");
const Notification = require("../models/Notification");
const Review = require("../models/Reviews");
const UserProfile = require("../models/UserProfile");
const { createCatalogAlbum } = require("../routes/utils/albumCatalog");
const { approveAlbumSubmission } = require("../routes/utils/approval");
const { applyModerationCommand } = require("../routes/utils/moderationCommands");
const { removeAccountData } = require("../lib/accountDeletion");
const { deleteOwnedReview, mutateReviewLike } = require("../routes/utils/reviewInteractions");
const {
  clearNotifications,
  fanOutFollowedReview,
  followedReviewRecipients,
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
  await Promise.all([AlbumCatalog, AlbumSubmission, Board, BoardItem, BoardListen, Follow, Listen, Like, ListenCreation, TrackRanking, Notification, Review, UserProfile]
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
  assert.equal(retry.notified, 0, "a committed delivery is not replayed");
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

test("pages are stable across equal timestamps and read state changes only on request", { skip: !enabled }, async () => {
  const recipientUserId = "pager";
  const createdAt = new Date("2026-10-10T00:00:00.000Z");
  await Notification.insertMany(Array.from({ length: 35 }, (_, index) => ({
    recipientUserId, actorUserId: `actor-${index}`, type: "follow", createdAt: index < 20 ? createdAt : new Date(createdAt.getTime() + index),
  })));
  const first = await readPage(recipientUserId);
  const second = await readPage(recipientUserId, first.nextCursor);
  assert.equal(first.rows.length, 30);
  assert.equal(second.rows.length, 5);
  assert.equal(second.nextCursor, null);
  const ids = [...first.rows, ...second.rows].map((row) => row.notificationId);
  assert.equal(new Set(ids).size, 35);
  assert.equal(await unreadCount(recipientUserId), 35, "reading pages changes nothing");

  assert.equal(await markRead(recipientUserId, { notificationIds: ids.slice(0, 3) }), 3);
  assert.equal(await markRead("someone-else", { notificationIds: ids.slice(3, 6) }), 0, "other users' rows are untouched");
  assert.equal(await unreadCount(recipientUserId), 32);
  assert.equal(await markRead(recipientUserId, { all: true }), 32);
  assert.equal(await clearNotifications(recipientUserId, { notificationIds: ids.slice(0, 5) }), 5);
  assert.equal(await clearNotifications(recipientUserId, { all: true }), 30);
});

function gate() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function reviewedShelf(prefix) {
  const album = await createAlbum(prefix);
  const userId = `${prefix}-author`;
  const followerId = `${prefix}-follower`;
  await follow(followerId, userId, new Date());
  await saveAlbum(followerId, album);
  const review = await Review.create({ userId, albumCatalogId: album._id, rating: 4, reviewText: prefix });
  return { album, userId, followerId, review };
}

test("delivery and its durable receipt roll back together and retry only once", { skip: !enabled }, async (t) => {
  const { review, followerId } = await reviewedShelf("receipt-rollback");
  const original = Notification.bulkWrite;
  t.mock.method(Notification, "bulkWrite", async function (...args) {
    await original.apply(this, args);
    throw new Error("fail after notifications were written");
  });
  await assert.rejects(fanOutFollowedReview(review), /fail after notifications/);
  assert.equal(await Notification.countDocuments({ reviewId: review._id }), 0);
  assert.equal((await Review.findById(review._id).select("+followedReviewFanoutAt")).followedReviewFanoutAt, undefined);
  t.mock.restoreAll();

  await Promise.all([fanOutFollowedReview(review), fanOutFollowedReview(review)]);
  assert.equal(await Notification.countDocuments({ reviewId: review._id }), 1);
  assert.ok((await Review.findById(review._id).select("+followedReviewFanoutAt")).followedReviewFanoutAt);
  assert.equal((await Review.findById(review._id).lean()).followedReviewFanoutAt, undefined, "receipt is private");
  await clearNotifications(followerId, { all: true });
  assert.equal((await fanOutFollowedReview(review)).notified, 0);
  assert.equal(await Notification.countDocuments({ reviewId: review._id }), 0, "clearing cannot re-enable delivery");
});

test("retry eligibility cannot expand a review's recipient cap, including an empty delivery", { skip: !enabled }, async () => {
  const { album, userId, review } = await reviewedShelf("stable-cap");
  await fanOutFollowedReview(review, { cap: 1 });
  await follow("stable-cap-new-follower", userId, new Date(Date.now() + 1000));
  await saveAlbum("stable-cap-new-follower", album);
  await fanOutFollowedReview(review, { cap: 1 });
  assert.equal(await Notification.countDocuments({ reviewId: review._id }), 1);

  const empty = await Review.create({ userId: "empty-audience", albumCatalogId: album._id, rating: 4, reviewText: "Empty" });
  assert.equal((await fanOutFollowedReview(empty)).notified, 0);
  await follow("stable-cap-new-follower", "empty-audience", new Date());
  assert.equal((await fanOutFollowedReview(empty)).notified, 0);
  assert.equal(await Notification.countDocuments({ reviewId: empty._id }), 0);
});

test("follower eligibility scanning is bounded even when most followers are ineligible", { skip: !enabled }, async () => {
  const { album, userId, review } = await reviewedShelf("bounded-scan");
  await follow("bounded-newer-a", userId, new Date(Date.now() + 1000));
  await follow("bounded-newer-b", userId, new Date(Date.now() + 2000));
  const result = await followedReviewRecipients({ reviewerId: userId, albumCatalogId: album._id, scanLimit: 2 });
  assert.deepEqual(result, { recipients: [], skipped: 0, scanned: 2, scanLimited: true });
  const logger = quietLogger();
  await fanOutFollowedReview(review, { scanLimit: 2, logger });
  assert.equal(logger.warnings.length, 1);
  assert.match(logger.warnings[0][0], /follower scan hit its limit/);
  assert.equal(logger.warnings[0][1].scanned, 2);
});

test("fan-out cannot insert after a review deletion's notification sweep", { skip: !enabled }, async (t) => {
  const { userId, review } = await reviewedShelf("delete-overlap");
  const swept = gate();
  const resumeDelete = gate();
  const claimAttempted = gate();
  const originalDelete = Review.deleteOne;
  const originalClaim = Review.findOneAndUpdate;
  t.mock.method(Review, "deleteOne", async function (...args) {
    swept.resolve();
    await resumeDelete.promise;
    return originalDelete.apply(this, args);
  });
  t.mock.method(Review, "findOneAndUpdate", function (...args) {
    if (args[1]?.$set?.followedReviewFanoutAt) claimAttempted.resolve();
    return originalClaim.apply(this, args);
  });
  const deletion = deleteOwnedReview(review.reviewId, userId);
  await swept.promise;
  const delivery = fanOutFollowedReview(review);
  try {
    // Old delivery completed here without claiming the review; the fixed
    // delivery waits for the deletion's write claim to finish.
    await Promise.race([claimAttempted.promise, delivery]);
  } finally { resumeDelete.resolve(); }
  await Promise.all([deletion, delivery]);
  assert.equal(await Review.exists({ _id: review._id }), null);
  assert.equal(await Notification.countDocuments({ reviewId: review._id }), 0);
});

test("account cleanup winning after recipient selection cannot restore an author's identity", { skip: !enabled }, async (t) => {
  const { userId, review } = await reviewedShelf("account-overlap");
  const original = BoardItem.distinct;
  t.mock.method(BoardItem, "distinct", async function (...args) {
    const recipients = await original.apply(this, args);
    const session = await mongoose.startSession();
    try { await session.withTransaction(() => removeAccountData(userId, session)); }
    finally { await session.endSession(); }
    return recipients;
  });
  await fanOutFollowedReview(review);
  assert.equal((await Review.findById(review._id)).userId, Review.DELETED_AUTHOR_ID);
  assert.equal(await Notification.countDocuments({ actorUserId: userId }), 0);
  assert.equal(await Notification.countDocuments({ reviewId: review._id }), 0);
});

test("account cleanup waits for an in-flight delivery then removes its notifications", { skip: !enabled }, async (t) => {
  const { userId, review } = await reviewedShelf("account-after-claim");
  const original = Notification.bulkWrite;
  const claimed = gate();
  const resume = gate();
  t.mock.method(Notification, "bulkWrite", async function (...args) {
    claimed.resolve();
    await resume.promise;
    return original.apply(this, args);
  });
  const delivery = fanOutFollowedReview(review);
  await claimed.promise;
  const session = await mongoose.startSession();
  const deletion = session.withTransaction(() => removeAccountData(userId, session));
  resume.resolve();
  try { await Promise.all([delivery, deletion]); }
  finally { await session.endSession(); }
  assert.equal((await Review.findById(review._id)).userId, Review.DELETED_AUTHOR_ID);
  assert.equal(await Notification.countDocuments({ actorUserId: userId }), 0);
});

test("a retried moderation command conflicts instead of deciding on a newer revision", { skip: !enabled }, async (t) => {
  const submission = await createSubmission("First Revision", "revision-owner");
  const ready = gate();
  const resume = gate();
  const original = AlbumSubmission.findOneAndUpdate;
  let paused = false;
  t.mock.method(AlbumSubmission, "findOneAndUpdate", async function (...args) {
    if (!paused && args[1]?.$set?.status === "rejected") {
      paused = true;
      ready.resolve();
      await resume.promise;
    }
    return original.apply(this, args);
  });
  const rejection = applyModerationCommand({ submissionId: submission.submissionId, actorUserId: "stale-moderator", action: "reject", body: { reason: "Old revision is wrong" } });
  const conflict = assert.rejects(rejection, (error) => error.status === 409 && error.code === "STATE_CONFLICT");
  await ready.promise;
  try {
    await applyModerationCommand({ submissionId: submission.submissionId, actorUserId: "other-moderator", action: "request_changes", body: { reason: "Please revise" } });
    const clerkPath = require.resolve("@clerk/express");
    const routePath = require.resolve("../routes/suggestions");
    const oldClerk = require.cache[clerkPath];
    require.cache[clerkPath] = { id: clerkPath, filename: clerkPath, loaded: true, exports: { getAuth: () => ({ userId: "revision-owner" }), clerkClient: {} } };
    delete require.cache[routePath];
    const router = require(routePath);
    t.after(() => { if (oldClerk) require.cache[clerkPath] = oldClerk; else delete require.cache[clerkPath]; delete require.cache[routePath]; });
    const layer = router.stack.find((item) => item.route?.path === "/:submissionId/revise" && item.route.methods.post);
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await layer.route.stack.at(-1).handle({ userId: "revision-owner", params: { submissionId: submission.submissionId }, body: {
      proposedMetadata: { title: "Corrected Revision", artistCredits: [{ name: "Notification Artist" }], releaseType: "album", releaseDate: "2026" },
      supportingSources: [{ type: "other", url: "https://example.com/evidence" }], externalReferences: [],
    } }, res);
    assert.equal(res.statusCode, 200);
  } finally { resume.resolve(); }
  await conflict;
  const persisted = await AlbumSubmission.findById(submission._id);
  assert.equal(persisted.currentRevision, 2);
  assert.equal(persisted.status, "pending");
  assert.equal(persisted.moderationHistory.some((event) => event.action === "rejected"), false);
  assert.equal(await Notification.countDocuments({ submissionId: submission._id, submissionStatus: "rejected" }), 0);
});
