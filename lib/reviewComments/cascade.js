// Comment cleanup that runs inside another command's transaction: comment
// deletion, review deletion, and account deletion. Requires only models, so
// review and account code can use it without a require cycle.

const CommentModerationEvent = require("../../models/CommentModerationEvent");
const CommentReport = require("../../models/CommentReport");
const Notification = require("../../models/Notification");
const ReviewComment = require("../../models/ReviewComment");

function requireSession(session) {
  if (!session) throw new Error("Comment cleanup requires a transaction session");
  return { session };
}

// Removes comments and everything that points at them.
async function hardDeleteComments(ids, session) {
  const options = requireSession(session);
  if (!ids.length) return 0;
  await CommentReport.deleteMany({ commentId: { $in: ids } }, options);
  await CommentModerationEvent.deleteMany({ commentId: { $in: ids } }, options);
  await Notification.deleteMany({ commentId: { $in: ids } }, options);
  const result = await ReviewComment.deleteMany({ _id: { $in: ids } }, options);
  return result.deletedCount || 0;
}

// An author-deleted tombstone exists only to hold its thread together. Once
// no reply of any status remains under it, it is removed too. A moderator
// removal is kept for the audit trail; reads hide it while it has no visible replies.
async function removeEmptyTombstones(parentIds, session) {
  const options = requireSession(session);
  if (!parentIds.length) return 0;
  const stillParents = new Set((await ReviewComment.distinct("parentCommentId", { parentCommentId: { $in: parentIds } }, options)).map(String));
  const empty = parentIds.filter((id) => !stillParents.has(String(id)));
  if (!empty.length) return 0;
  const tombstones = await ReviewComment.distinct("_id", { _id: { $in: empty }, status: "deleted_by_author" }, options);
  return hardDeleteComments(tombstones, session);
}

async function removeReviewComments(reviewId, session) {
  const options = requireSession(session);
  const ids = await ReviewComment.distinct("_id", { reviewId }, options);
  return hardDeleteComments(ids, session);
}

// Account deletion. Replies are deleted. A top-level comment that others have
// replied to becomes an anonymous tombstone with no text; any other is deleted.
// Comment text is never kept under an anonymous author, unlike reviews.
async function removeAccountComments(userId, session) {
  const options = requireSession(session);
  await CommentReport.deleteMany({ reporterUserId: userId }, options);
  await ReviewComment.updateMany({ replyToUserId: userId }, { $set: { replyToUserId: null } }, options);

  const owned = await ReviewComment.find({ userId }, { _id: 1, parentCommentId: 1 }, options).lean();
  if (!owned.length) return { tombstoned: 0, deleted: 0 };
  const topLevel = owned.filter((row) => !row.parentCommentId).map((row) => row._id);
  const replies = owned.filter((row) => row.parentCommentId);
  const answered = new Set((await ReviewComment.distinct(
    "parentCommentId",
    { parentCommentId: { $in: topLevel }, userId: { $ne: userId } },
    options,
  )).map(String));
  const tombstones = topLevel.filter((id) => answered.has(String(id)));
  const deleted = [...topLevel.filter((id) => !answered.has(String(id))), ...replies.map((row) => row._id)];

  if (tombstones.length) {
    await CommentReport.deleteMany({ commentId: { $in: tombstones } }, options);
    await Notification.deleteMany({ commentId: { $in: tombstones } }, options);
    // A moderator removal keeps its status; anything else reads as deleted.
    await ReviewComment.updateMany({ _id: { $in: tombstones }, status: "visible" }, { $set: { status: "deleted_by_author" } }, options);
    // Claiming each revision makes a concurrent edit, delete, or removal conflict.
    await ReviewComment.updateMany(
      { _id: { $in: tombstones } },
      {
        $set: { userId: ReviewComment.DELETED_AUTHOR_ID, replyToUserId: null },
        $unset: { body: 1, creationKey: 1 },
        $inc: { interactionRevision: 1 },
      },
      options,
    );
  }
  await hardDeleteComments(deleted, session);
  const parents = new Map(replies.map((row) => [String(row.parentCommentId), row.parentCommentId]));
  await removeEmptyTombstones([...parents.values()], session);
  return { tombstoned: tombstones.length, deleted: deleted.length };
}

module.exports = { hardDeleteComments, removeAccountComments, removeEmptyTombstones, removeReviewComments };
