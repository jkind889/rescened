const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { once } = require("node:events");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const AccountFence = require("../models/AccountFence");
const { accountKey } = require("../lib/accountFence");
const AlbumCatalog = require("../models/AlbumCatalog");
const CommentModerationEvent = require("../models/CommentModerationEvent");
const CommentReport = require("../models/CommentReport");
const Notification = require("../models/Notification");
const Review = require("../models/Reviews");
const ReviewComment = require("../models/ReviewComment");
const UserProfile = require("../models/UserProfile");
const { createCatalogAlbum } = require("../routes/utils/albumCatalog");
const { deleteOwnedReview } = require("../routes/utils/reviewInteractions");
const { removeAccountData } = require("../lib/accountDeletion");
const { createComment, deleteComment, editComment, reportComment } = require("../lib/reviewComments/commands");
const { dismissReports, readReportQueue, removeComment } = require("../lib/reviewComments/moderation");
const { readThread } = require("../lib/reviewComments/read");

const enabled = process.env.RUN_MONGO_INTEGRATION === "true";
const integration = (name, fn) => test(name, { skip: !enabled }, fn);
const clerkPath = require.resolve("@clerk/express");
const models = [AccountFence, AlbumCatalog, CommentModerationEvent, CommentReport, Notification, Review, ReviewComment, UserProfile];
let replSet;
let server;
let baseUrl;

const authors = async (ids) => new Map(ids.map((id) => [id, { userId: id, username: id, imageUrl: "" }]));

async function createReview(userId = "user_reviewer") {
  const album = await createCatalogAlbum({
    albumId: crypto.randomUUID(),
    title: `Album ${crypto.randomUUID().slice(0, 8)}`,
    artistDisplayName: "Integration Artist",
    artistCredits: [{ name: "Integration Artist", role: "main" }],
    releaseDate: "2026",
    releaseDatePrecision: "year",
    releaseYear: 2026,
    tracks: [],
  });
  return Review.create({ userId, albumCatalogId: album._id, rating: 4, reviewText: "A review worth discussing" });
}

function comment(review, userId, body, parentCommentId = null) {
  return createComment({ reviewId: review.reviewId, userId, creationKey: crypto.randomUUID(), body, parentCommentId });
}

async function request(method, path, { userId = "", body, key } = {}) {
  const headers = { "x-test-user": userId };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (key) headers["idempotency-key"] = key;
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

test.before(async () => {
  if (!enabled) return;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: "rescened_review_comments" });
  await Promise.all(models.map((Model) => Model.syncIndexes()));
  require.cache[clerkPath] = {
    id: clerkPath, filename: clerkPath, loaded: true,
    exports: {
      getAuth: (req) => ({ userId: req.get("x-test-user") || null }),
      clerkClient: { users: { getUserList: async ({ userId }) => ({ data: userId.map((id) => ({ id, username: id, imageUrl: "" })) }) } },
    },
  };
  process.env.REVIEW_COMMENTS_ENABLED = "true";
  const app = express();
  app.use(express.json());
  app.use("/reviews", require("../routes/reviews"));
  app.use("/reviews", require("../routes/reviewComments"));
  app.use("/profile", require("../routes/profile"));
  server = app.listen(0);
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (!enabled) return;
  server?.close();
  delete require.cache[clerkPath];
  delete process.env.REVIEW_COMMENTS_ENABLED;
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  await replSet.stop();
});

integration("comments, replies, and replies to replies notify the right people once", async () => {
  const review = await createReview("user_owner");
  const { comment: top } = await comment(review, "user_alice", "First thought");
  const { comment: reply } = await comment(review, "user_bob", "Replying to Alice", top.commentId);
  const { comment: nested } = await comment(review, "user_carol", "Replying to Bob", reply.commentId);
  await comment(review, "user_alice", "Answering my own thread", top.commentId);

  assert.equal(String(reply.parentCommentId), String(top._id));
  assert.equal(String(nested.parentCommentId), String(top._id), "a reply to a reply joins the same thread");
  assert.equal(nested.replyToUserId, "user_bob");

  const rows = await Notification.find({ reviewId: review._id }).sort({ createdAt: 1 }).lean();
  assert.deepEqual(rows.map((row) => [row.recipientUserId, row.actorUserId, row.type]).sort(), [
    ["user_alice", "user_bob", "comment_reply"],
    ["user_alice", "user_carol", "comment_reply"],
    ["user_bob", "user_carol", "comment_reply"],
    ["user_owner", "user_alice", "review_comment"],
  ].sort());

  await UserProfile.create({ userId: "user_owner", notificationPreferences: { review_comment: false } });
  await comment(review, "user_dave", "Muted for the owner");
  assert.equal(await Notification.countDocuments({ recipientUserId: "user_owner" }), 1, "a muted type creates no row");
});

integration("an idempotent create retry produces one comment and one notification", async () => {
  const review = await createReview("user_owner_retry");
  const key = crypto.randomUUID();
  const attempts = await Promise.all([0, 1, 2].map(() => createComment({ reviewId: review.reviewId, userId: "user_retry", creationKey: key, body: "Only once", parentCommentId: null })));
  assert.equal(attempts.filter((attempt) => attempt.created).length, 1);
  assert.equal(new Set(attempts.map((attempt) => attempt.comment.commentId)).size, 1);
  assert.equal(await ReviewComment.countDocuments({ reviewId: review._id }), 1);
  assert.equal(await Notification.countDocuments({ reviewId: review._id, type: "review_comment" }), 1);

  const again = await comment(review, "user_retry", "Only once");
  assert.equal(again.created, false, "the same text in the same place within ten minutes returns the first comment");
  const { comment: top } = await comment(review, "user_other", "Another thread");
  const elsewhere = await comment(review, "user_retry", "Only once", top.commentId);
  assert.equal(elsewhere.created, true, "the same text under a different parent still posts");
});

integration("replies require a visible parent on the same review", async () => {
  const review = await createReview();
  const otherReview = await createReview();
  const { comment: top } = await comment(review, "user_a", "Top");
  await assert.rejects(comment(otherReview, "user_b", "Wrong review", top.commentId), { status: 404, code: "COMMENT_NOT_FOUND" });
  await removeComment({ commentId: top.commentId, actorUserId: "user_mod", reason: "spam" });
  await assert.rejects(comment(review, "user_b", "Too late", top.commentId), { status: 404, code: "COMMENT_NOT_FOUND" });
  await assert.rejects(createComment({ reviewId: crypto.randomUUID(), userId: "user_b", creationKey: crypto.randomUUID(), body: "x", parentCommentId: null }), { status: 404, code: "REVIEW_NOT_FOUND" });
});

integration("concurrent review deletion and comment creation leave no orphaned comments", async () => {
  for (let round = 0; round < 5; round += 1) {
    const review = await createReview("user_racer");
    const { comment: top } = await comment(review, "user_a", "Existing");
    await reportComment({ commentId: top.commentId, reporterUserId: "user_b", reason: "spam", note: "" });
    const outcomes = await Promise.allSettled([
      deleteOwnedReview(review.reviewId, "user_racer"),
      comment(review, "user_c", `Racing ${round}`),
      comment(review, "user_d", "Racing reply", top.commentId),
    ]);
    assert.equal(outcomes[0].status, "fulfilled");
    outcomes.slice(1).filter((outcome) => outcome.status === "rejected").forEach((outcome) => assert.equal(outcome.reason.status, 404));
    assert.equal(await Review.countDocuments({ _id: review._id }), 0);
    assert.equal(await ReviewComment.countDocuments({ reviewId: review._id }), 0);
    assert.equal(await Notification.countDocuments({ reviewId: review._id }), 0);
    assert.equal(await CommentReport.countDocuments({ commentId: top._id }), 0);
  }
});

integration("deleting a comment with replies leaves a tombstone that goes away with its last reply", async () => {
  const review = await createReview();
  const { comment: top } = await comment(review, "user_author", "Will be deleted");
  const { comment: reply } = await comment(review, "user_replier", "A reply", top.commentId);

  await assert.rejects(deleteComment({ commentId: top.commentId, userId: "user_replier" }), { status: 403 });
  await assert.rejects(deleteComment({ commentId: top.commentId, userId: review.userId }), { status: 403 }, "review authors cannot delete other people's comments");

  assert.deepEqual(await deleteComment({ commentId: top.commentId, userId: "user_author" }), { status: "deleted_by_author" });
  const tombstone = await ReviewComment.findById(top._id).lean();
  assert.equal(tombstone.status, "deleted_by_author");
  assert.equal(tombstone.body, undefined);
  assert.equal(await Notification.countDocuments({ commentId: top._id }), 0);
  assert.deepEqual(await deleteComment({ commentId: top.commentId, userId: "user_author" }), { status: "deleted_by_author" }, "a retried delete is a no-op");

  const thread = await readThread(review, null, authors);
  assert.deepEqual(Object.keys(thread.comments[0]).sort(), ["commentId", "createdAt", "replies", "repliesCursor", "replyCount", "status"]);
  assert.equal(thread.comments[0].replyCount, 1);

  assert.deepEqual(await deleteComment({ commentId: reply.commentId, userId: "user_replier" }), { status: "deleted" });
  assert.equal(await ReviewComment.countDocuments({ reviewId: review._id }), 0, "the empty tombstone is cleaned up");
});

integration("account deletion leaves tombstones only where other people replied", async () => {
  const review = await createReview("user_leaving");
  const { comment: answered } = await comment(review, "user_leaving", "Others replied to this");
  const { comment: lonely } = await comment(review, "user_leaving", "Nobody replied");
  const { comment: selfAnswered } = await comment(review, "user_leaving", "Only I replied");
  await comment(review, "user_leaving", "My own follow-up", selfAnswered.commentId);
  const { comment: friend } = await comment(review, "user_friend", "Friendly reply", answered.commentId);
  const { comment: answer } = await comment(review, "user_friend", "Another thread");
  await comment(review, "user_leaving", "My reply elsewhere", answer.commentId);
  const { comment: aside } = await comment(review, "user_third", "Answering the leaver", answer.commentId);
  await CommentReport.create({ commentId: friend._id, reporterUserId: "user_leaving", reason: "spam" });
  await CommentReport.create({ commentId: answered._id, reporterUserId: "user_friend", reason: "other" });

  const session = await mongoose.startSession();
  try { await session.withTransaction(() => removeAccountData("user_leaving", session)); } finally { await session.endSession(); }

  const remaining = await ReviewComment.find({ reviewId: review._id }).lean();
  assert.equal(remaining.some((row) => row.userId === "user_leaving"), false);
  const tombstone = remaining.find((row) => String(row._id) === String(answered._id));
  assert.equal(tombstone.status, "deleted_by_author");
  assert.equal(tombstone.body, undefined);
  assert.equal(tombstone.userId, ReviewComment.DELETED_AUTHOR_ID);
  assert.equal(remaining.some((row) => String(row._id) === String(lonely._id)), false);
  assert.equal(remaining.some((row) => String(row._id) === String(selfAnswered._id)), false, "a thread answered only by the leaver is deleted");
  assert.equal(remaining.find((row) => String(row._id) === String(aside._id)).replyToUserId, null);
  assert.equal(await CommentReport.countDocuments({ $or: [{ reporterUserId: "user_leaving" }, { commentId: answered._id }] }), 0);
  assert.equal(await Notification.countDocuments({ $or: [{ recipientUserId: "user_leaving" }, { actorUserId: "user_leaving" }] }), 0);
  assert.equal(await Review.countDocuments({ _id: review._id, userId: Review.DELETED_AUTHOR_ID }), 1);
});

integration("a moderator removal racing an author edit returns 409 to the losing edit", async () => {
  const review = await createReview();
  const { comment: target } = await comment(review, "user_author", "Original text");
  const edited = await editComment({ commentId: target.commentId, userId: "user_author", body: "Edited text" });
  assert.ok(edited.editedAt);
  await assert.rejects(editComment({ commentId: target.commentId, userId: "user_other", body: "Hijack" }), { status: 403 });

  const outcomes = await Promise.allSettled([
    removeComment({ commentId: target.commentId, actorUserId: "user_mod", reason: "harassment" }),
    editComment({ commentId: target.commentId, userId: "user_author", body: "Racing edit" }),
  ]);
  assert.equal(outcomes[0].status, "fulfilled");
  if (outcomes[1].status === "rejected") assert.equal(outcomes[1].reason.status, 409);
  await assert.rejects(editComment({ commentId: target.commentId, userId: "user_author", body: "After removal" }), { status: 409, code: "COMMENT_STATE_CONFLICT" });
  await assert.rejects(removeComment({ commentId: target.commentId, actorUserId: "user_mod", reason: "again" }), { status: 409 });
  assert.equal((await ReviewComment.findById(target._id).lean()).status, "removed_by_moderator");
});

integration("reports are one per reporter and the moderator queue sorts by count, then age", async () => {
  const review = await createReview();
  const { comment: once } = await comment(review, "user_x", "Reported once");
  const { comment: twice } = await comment(review, "user_y", "Reported twice");
  const { comment: hidden } = await comment(review, "user_z", "Reported then removed");
  await assert.rejects(reportComment({ commentId: once.commentId, reporterUserId: "user_x", reason: "spam", note: "" }), { status: 403 });
  const first = await reportComment({ commentId: once.commentId, reporterUserId: "user_r1", reason: "spam", note: "" });
  const repeat = await reportComment({ commentId: once.commentId, reporterUserId: "user_r1", reason: "other", note: "changed my mind" });
  assert.equal(first.created, true);
  assert.equal(repeat.created, false);
  assert.equal(repeat.report.reportId, first.report.reportId);
  await reportComment({ commentId: twice.commentId, reporterUserId: "user_r1", reason: "harassment", note: "" });
  await reportComment({ commentId: twice.commentId, reporterUserId: "user_r2", reason: "harassment", note: "Targets the reviewer" });
  await reportComment({ commentId: hidden.commentId, reporterUserId: "user_r1", reason: "spam", note: "" });

  const queue = await readReportQueue({}, authors);
  const ids = queue.items.map((item) => item.comment.commentId);
  assert.deepEqual(ids.slice(0, 3), [twice.commentId, once.commentId, hidden.commentId]);
  assert.deepEqual(queue.items[0].reasons, { harassment: 2 });
  assert.equal(queue.items[0].review.reviewId, review.reviewId);
  assert.equal(JSON.stringify(queue).includes(String(twice._id)), false, "the queue exposes public IDs only");

  const removed = await removeComment({ commentId: hidden.commentId, actorUserId: "user_mod", reason: "Spam link" });
  assert.equal(removed.reportsClosed, 1);
  const dismissed = await dismissReports({ commentId: twice.commentId, actorUserId: "user_mod", reason: "Within the rules" });
  assert.equal(dismissed.reportsClosed, 2);
  await assert.rejects(dismissReports({ commentId: twice.commentId, actorUserId: "user_mod", reason: "again" }), { status: 409 });
  const after = await readReportQueue({}, authors);
  assert.deepEqual(after.items.map((item) => item.comment.commentId).filter((id) => [once.commentId, twice.commentId, hidden.commentId].includes(id)), [once.commentId]);
  const events = await CommentModerationEvent.find({ commentId: { $in: [hidden._id, twice._id] } }).sort({ createdAt: 1 }).lean();
  assert.deepEqual(events.map((event) => [event.action, event.reportCount]), [["removed", 1], ["dismissed_reports", 2]]);
  assert.equal((await CommentReport.findOne({ commentId: hidden._id }).lean()).status, "actioned");
});

integration("threads page oldest first, preview replies, and hide removed comments without replies", async () => {
  const review = await createReview();
  const created = [];
  for (let index = 0; index < 4; index += 1) created.push((await comment(review, `user_${index}`, `Comment ${index}`)).comment);
  for (let index = 0; index < 5; index += 1) await comment(review, `user_r${index}`, `Reply ${index}`, created[0].commentId);
  await removeComment({ commentId: created[1].commentId, actorUserId: "user_mod", reason: "spam" });

  const first = await request("GET", `/reviews/review/${review.reviewId}/comments`, { userId: "user_0" });
  assert.equal(first.status, 200);
  assert.equal(first.body.commentsEnabled, true);
  assert.equal(first.body.commentCount, 8);
  assert.deepEqual(first.body.viewer, { profileIsPrivate: false });
  assert.deepEqual(first.body.comments.map((row) => row.body), ["Comment 0", "Comment 2", "Comment 3"]);
  const [top] = first.body.comments;
  assert.equal(top.replyCount, 5);
  assert.deepEqual(top.replies.map((row) => row.body), ["Reply 0", "Reply 1", "Reply 2"]);
  assert.ok(top.repliesCursor);

  const more = await request("GET", `/reviews/review/${review.reviewId}/comments/${top.commentId}/replies?cursor=${top.repliesCursor}`);
  assert.deepEqual(more.body.replies.map((row) => row.body), ["Reply 3", "Reply 4"]);
  assert.equal(more.body.nextCursor, null);
  assert.equal(JSON.stringify([first.body, more.body]).includes(String(created[0]._id)), false);

  const reviewRead = await request("GET", `/reviews/review/${review.reviewId}`);
  assert.equal(reviewRead.body.commentCount, 8);

  const single = await readThread(review, null, authors, { limit: 1 });
  assert.deepEqual(single.comments.map((row) => row.body), ["Comment 0"]);
  const skipped = await readThread(review, single.nextCursor, authors, { limit: 1 });
  assert.deepEqual(skipped.comments.map((row) => row.body), ["Comment 2"], "a hidden comment does not leave the page empty");
  const last = await readThread(review, skipped.nextCursor, authors, { limit: 1 });
  assert.deepEqual(last.comments.map((row) => row.body), ["Comment 3"]);
  assert.equal(last.nextCursor, null);

  await AlbumCatalog.deleteOne({ _id: review.albumCatalogId });
  const hidden = await request("GET", `/reviews/review/${review.reviewId}/comments`);
  assert.equal(hidden.status, 404, "a review hidden by its missing album hides its thread");
});

integration("comment creation over its limit returns 429 with Retry-After", async () => {
  const review = await createReview();
  let last;
  for (let index = 0; index < 21; index += 1) {
    last = await request("POST", `/reviews/review/${review.reviewId}/comments`, { userId: "user_flood", key: crypto.randomUUID(), body: { body: `Flood ${index}` } });
    if (index < 20) assert.equal(last.status, 201, `comment ${index}`);
  }
  assert.equal(last.status, 429);
  assert.equal(last.body.code, "RATE_LIMITED");
  assert.ok(Number(last.headers.get("retry-after")) > 0);
  assert.equal(await ReviewComment.countDocuments({ userId: "user_flood" }), 20);
});


integration("account deletion fences first-time comment creation and later retries", async () => {
  const review = await createReview("user_fence_review_owner");
  const userId = `user_leaving_${crypto.randomUUID()}`;
  const key = crypto.randomUUID();
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    await removeAccountData(userId, session);
    // Admission/authentication may have happened before deletion; the first
    // database write must still contend with the account's deletion marker.
    const pending = createComment({ reviewId: review.reviewId, userId, creationKey: key, body: "Must not survive", parentCommentId: null });
    const rejected = assert.rejects(pending, { status: 403, code: "COMMENT_FORBIDDEN" });
    await session.commitTransaction();
    await rejected;
    await assert.rejects(comment(review, userId, "Delayed request"), { status: 403 });
    assert.equal(await ReviewComment.countDocuments({ userId }), 0);
    assert.equal(await Notification.countDocuments({ actorUserId: userId }), 0);
    const marker = await AccountFence.findById(accountKey(userId)).lean();
    assert.equal(marker.deleted, true);
    assert.equal(JSON.stringify(marker).includes(userId), false);
  } finally {
    if (session.inTransaction()) await session.abortTransaction();
    await session.endSession();
  }
});

integration("first-time concurrent posts across reviews share one account fence", async () => {
  const reviews = await Promise.all([createReview(), createReview()]);
  const userId = `user_first_${crypto.randomUUID()}`;
  const results = await Promise.all(Array.from({ length: 6 }, (_, index) => comment(reviews[index % 2], userId, `Concurrent ${index}`)));
  assert.equal(results.length, 6);
  assert.equal(await ReviewComment.countDocuments({ userId }), 6);
  assert.equal(await AccountFence.countDocuments({ _id: accountKey(userId) }), 1);
});

integration("account deletion removes a winning post and blocks reports after deletion", async () => {
  const review = await createReview("user_fence_owner_2");
  const userId = `user_prior_${crypto.randomUUID()}`;
  const { comment: posted } = await comment(review, userId, "Committed before cleanup");
  const { comment: target } = await comment(review, "user_report_target", "Report target");
  const session = await mongoose.startSession();
  try { await session.withTransaction(() => removeAccountData(userId, session)); } finally { await session.endSession(); }
  assert.equal(await ReviewComment.exists({ _id: posted._id }), null);
  assert.equal(await Notification.countDocuments({ actorUserId: userId }), 0);
  await assert.rejects(reportComment({ commentId: target.commentId, reporterUserId: userId, reason: "spam", note: "" }), { status: 403 });
  assert.equal(await CommentReport.countDocuments({ reporterUserId: userId }), 0);
});

integration("rolling back account deletion does not disable later comment creation", async () => {
  const userId = `user_rollback_${crypto.randomUUID()}`;
  const review = await createReview();
  const session = await mongoose.startSession();
  session.startTransaction();
  try { await removeAccountData(userId, session); await session.abortTransaction(); } finally { await session.endSession(); }
  assert.equal((await comment(review, userId, "Still active")).created, true);
});

integration("profile activity carries the same live comment total as review detail", async () => {
  const userId = `user_activity_${crypto.randomUUID()}`;
  const review = await createReview(userId);
  const { comment: top } = await comment(review, "user_activity_a", "Top");
  await comment(review, "user_activity_b", "Reply", top.commentId);
  const { comment: removed } = await comment(review, "user_activity_c", "Hidden");
  await removeComment({ commentId: removed.commentId, actorUserId: "user_mod", reason: "spam" });
  for (const path of ["/profile/me/activity", `/profile/${userId}/activity`]) {
    const page = await request("GET", path, { userId });
    assert.equal(page.status, 200);
    assert.equal(page.body.find((row) => row.reviewId === review.reviewId).commentCount, 2);
  }
  assert.equal((await request("GET", `/reviews/review/${review.reviewId}`)).body.commentCount, 2);
});

integration("creation and duplicate responses supply real totals and existing thread previews", async () => {
  const review = await createReview();
  const { comment: top } = await comment(review, "user_duplicate_top", "Existing top");
  for (let index = 0; index < 4; index += 1) await comment(review, "user_duplicate_reply", `Reply ${index}`, top.commentId);
  const path = `/reviews/review/${review.reviewId}/comments`;
  const duplicate = await request("POST", path, { userId: "user_duplicate_reply", key: crypto.randomUUID(), body: { body: "Reply 3", parentCommentId: top.commentId } });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.commentCount, 5);
  assert.equal(duplicate.body.threadReplyCount, 4);
  const key = crypto.randomUUID();
  const options = { userId: "user_duplicate_reply", key, body: { body: "New reply", parentCommentId: top.commentId } };
  const created = await request("POST", path, options);
  const retried = await request("POST", path, options);
  assert.equal(created.status, 201);
  assert.equal(retried.status, 200);
  assert.equal(retried.body.commentCount, 6);
  assert.equal(retried.body.threadReplyCount, 5);
  assert.equal(retried.body.commentId, created.body.commentId);
  const existingTop = await request("POST", path, { userId: "user_duplicate_top", key: crypto.randomUUID(), body: { body: "Existing top" } });
  assert.equal(existingTop.body.replyCount, 5);
  assert.equal(existingTop.body.replies.length, 3);
  assert.ok(existingTop.body.repliesCursor);
});
