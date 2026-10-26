const crypto = require("node:crypto");
const mongoose = require("mongoose");

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMENT_STATUSES = ["visible", "deleted_by_author", "removed_by_moderator"];
const MAX_COMMENT_LENGTH = 500;

const reviewCommentSchema = new mongoose.Schema({
  // Public, immutable identity. Parent links, cursors, and every response use
  // it; Mongo's _id stays an internal relation key for reports and notifications.
  commentId: {
    type: String,
    required: true,
    unique: true,
    immutable: true,
    lowercase: true,
    default: function defaultCommentId() { return this.isNew ? crypto.randomUUID() : undefined; },
    match: UUID_V4,
  },
  reviewId: { type: mongoose.Schema.Types.ObjectId, ref: "Review", required: true, immutable: true },
  // null is a top-level comment. Replies always point at a top-level comment,
  // so threads are two levels deep.
  parentCommentId: { type: mongoose.Schema.Types.ObjectId, ref: "ReviewComment", default: null, immutable: true },
  // Who a reply answers when it replies to a reply.
  replyToUserId: { type: String, default: null },
  userId: { type: String, required: true },
  // Cleared when the author deletes the comment. A moderator removal keeps it
  // for the audit trail; serializers never return it once it is not visible.
  body: {
    type: String,
    maxlength: MAX_COMMENT_LENGTH,
    required: function bodyRequired() { return this.status === "visible"; },
  },
  status: { type: String, enum: COMMENT_STATUSES, default: "visible", required: true },
  createdAt: { type: Date, default: Date.now, immutable: true },
  editedAt: { type: Date, default: null },
  // Private request key used only to make a creation retry idempotent.
  creationKey: { type: String, select: false, immutable: true },
  // Internal serialization token for edits, deletion, and moderator removal.
  interactionRevision: { type: Number, default: 0, select: false },
});

// Server-only author kept on tombstones after their account is deleted. The
// colon places it outside Clerk's user ID format; serializers never expose it.
const DELETED_AUTHOR_ID = "rescened:deleted-user";
reviewCommentSchema.statics.DELETED_AUTHOR_ID = DELETED_AUTHOR_ID;

// Threads: top-level comments and each comment's replies, oldest first, with
// the public commentId breaking timestamp ties for cursor paging.
reviewCommentSchema.index({ reviewId: 1, parentCommentId: 1, createdAt: 1, commentId: 1 });
// Account deletion, duplicate detection, and rate checks.
reviewCommentSchema.index({ userId: 1, createdAt: -1 });
reviewCommentSchema.index(
  { userId: 1, creationKey: 1 },
  { unique: true, partialFilterExpression: { creationKey: { $type: "string" } } },
);

const ReviewComment = mongoose.model("ReviewComment", reviewCommentSchema);
ReviewComment.COMMENT_STATUSES = COMMENT_STATUSES;
ReviewComment.MAX_COMMENT_LENGTH = MAX_COMMENT_LENGTH;

module.exports = ReviewComment;
