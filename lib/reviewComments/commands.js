// Contributor comment commands: create, edit, delete, and report. Every
// command returns stored rows; routes serialize them.

const CommentReport = require("../../models/CommentReport");
const Notification = require("../../models/Notification");
const ReviewComment = require("../../models/ReviewComment");
const { claimReview } = require("../../routes/utils/reviewInteractions");
const { recordCommentNotifications } = require("../../routes/utils/notifications");
const { hardDeleteComments, removeEmptyTombstones } = require("./cascade");
const {
  DUPLICATE_WINDOW_MS,
  conflict,
  forbidden,
  notFound,
  reviewNotFound,
  runCommentTransaction,
} = require("./common");

const UNAVAILABLE_PARENT = "The comment you're replying to is no longer available";

function claimComment(filter, session) {
  return ReviewComment.findOneAndUpdate(filter, { $inc: { interactionRevision: 1 } }, { returnDocument: "after", session, lean: true });
}

async function findCreated(userId, creationKey) {
  return ReviewComment.findOne({ userId, creationKey }).lean();
}

// Explains why an author-scoped claim matched nothing.
async function authorClaimFailure(commentId, userId, action, session) {
  const current = await ReviewComment.findOne({ commentId }, null, { session }).lean();
  if (!current) return { error: notFound() };
  if (current.userId !== userId) return { error: forbidden(`Only the comment's author can ${action} it`) };
  return { current };
}

// One transaction claims the review (so a concurrent review deletion
// conflicts) and the comment being answered, inserts the comment, and writes
// its notifications. parentCommentId may name a reply: the new comment then
// joins that reply's thread and names whom it answers.
async function createComment({ reviewId, userId, creationKey, body, parentCommentId }) {
  const existing = await findCreated(userId, creationKey);
  if (existing) return { comment: existing, created: false };
  try {
    return await runCommentTransaction(async (session) => {
      const review = await claimReview(reviewId, undefined, session);
      if (!review) throw reviewNotFound();

      let thread = null;
      let replyToUserId = null;
      if (parentCommentId) {
        const parent = await claimComment({ commentId: parentCommentId, reviewId: review._id, status: "visible" }, session);
        if (!parent) throw notFound(UNAVAILABLE_PARENT);
        if (parent.parentCommentId) {
          // Claiming the thread too serializes with tombstone cleanup.
          thread = await claimComment({ _id: parent.parentCommentId }, session);
          if (!thread) throw notFound(UNAVAILABLE_PARENT);
          replyToUserId = parent.userId;
        } else {
          thread = parent;
        }
      }

      // The same author posting the same text in the same place shortly after
      // gets the comment they already posted.
      const duplicate = await ReviewComment.findOne({
        reviewId: review._id,
        parentCommentId: thread?._id || null,
        userId,
        body,
        status: "visible",
        createdAt: { $gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
      }, null, { session }).sort({ createdAt: -1 }).lean();
      if (duplicate) return { comment: duplicate, created: false };

      const [comment] = await ReviewComment.create([{
        reviewId: review._id,
        parentCommentId: thread?._id || null,
        replyToUserId,
        userId,
        body,
        creationKey,
      }], { session });
      await recordCommentNotifications({ comment, review, thread, session });
      return { comment: comment.toObject(), created: true };
    });
  } catch (error) {
    if (error?.code === 11000) {
      const created = await findCreated(userId, creationKey);
      if (created) return { comment: created, created: false };
    }
    throw error;
  }
}

// A single conditional write: it claims the revision only while the comment is
// visible, so an edit that loses a race with moderator removal returns 409.
async function editComment({ commentId, userId, body }) {
  const updated = await ReviewComment.findOneAndUpdate(
    { commentId, userId, status: "visible", body: { $ne: body } },
    { $set: { body, editedAt: new Date() }, $inc: { interactionRevision: 1 } },
    { returnDocument: "after", runValidators: true, lean: true },
  );
  if (updated) return updated;
  const { error, current } = await authorClaimFailure(commentId, userId, "edit");
  if (error) throw error;
  if (current.status === "visible" && current.body === body) return current;
  throw conflict("This comment can no longer be edited");
}

// A comment with replies becomes a tombstone; any other is deleted outright,
// along with its reports, moderation events, and notifications.
async function deleteComment({ commentId, userId }) {
  return runCommentTransaction(async (session) => {
    const comment = await claimComment({ commentId, userId, status: "visible" }, session);
    if (!comment) {
      const { error, current } = await authorClaimFailure(commentId, userId, "delete", session);
      if (error) throw error;
      // A retried delete of a tombstone is already done.
      if (current.status === "deleted_by_author") return { status: "deleted_by_author" };
      throw conflict("This comment was removed by a moderator");
    }

    const hasReplies = !comment.parentCommentId && await ReviewComment.exists({ parentCommentId: comment._id }).session(session);
    if (hasReplies) {
      await CommentReport.deleteMany({ commentId: comment._id }, { session });
      await Notification.deleteMany({ commentId: comment._id }, { session });
      await ReviewComment.updateOne({ _id: comment._id }, { $set: { status: "deleted_by_author" }, $unset: { body: 1 } }, { session });
      return { status: "deleted_by_author" };
    }
    await hardDeleteComments([comment._id], session);
    if (comment.parentCommentId) await removeEmptyTombstones([comment.parentCommentId], session);
    return { status: "deleted" };
  });
}

// One report per reporter; a repeat returns the first. Claiming the comment
// keeps a report from outliving a comment deleted at the same moment.
async function reportComment({ commentId, reporterUserId, reason, note }) {
  try {
    return await fileReport({ commentId, reporterUserId, reason, note });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const comment = await ReviewComment.findOne({ commentId }, { _id: 1 }).lean();
    const report = comment && await CommentReport.findOne({ commentId: comment._id, reporterUserId }).lean();
    if (!report) throw error;
    return { report, created: false };
  }
}

function fileReport({ commentId, reporterUserId, reason, note }) {
  return runCommentTransaction(async (session) => {
    const comment = await claimComment({ commentId, status: "visible" }, session);
    if (!comment) throw notFound();
    if (comment.userId === reporterUserId) throw forbidden("You can't report your own comment");
    const existing = await CommentReport.findOne({ commentId: comment._id, reporterUserId }, null, { session }).lean();
    if (existing) return { report: existing, created: false };
    const [report] = await CommentReport.create([{ commentId: comment._id, reporterUserId, reason, note }], { session });
    return { report: report.toObject(), created: true };
  });
}

module.exports = { createComment, deleteComment, editComment, reportComment };
