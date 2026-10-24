const crypto = require("node:crypto");
const mongoose = require("mongoose");

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NOTIFICATION_TYPES = ["review_like", "follow", "suggestion_status", "followed_review"];
const SUGGESTION_NOTIFICATION_STATUSES = ["approved", "needs_changes", "rejected", "duplicate"];
// Moderation notifications name this fixed actor instead of the moderator, so
// the moderator stays private and their account deletion never matches it.
const MODERATION_ACTOR_ID = "rescened:moderation";

const notificationSchema = new mongoose.Schema(
  {
    // Public, immutable identity. Mongo's _id remains an internal relation key
    // for read-state updates, review relations, and notification deduplication.
    // Do not manufacture an identifier while hydrating a legacy document.
    notificationId: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      lowercase: true,
      default: function defaultNotificationId() { return this.isNew ? crypto.randomUUID() : undefined; },
      match: UUID_V4,
    },
    recipientUserId: { type: String, required: true },
    actorUserId: { type: String, required: true },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    reviewId: { type: mongoose.Schema.Types.ObjectId, ref: "Review" },
    // suggestion_status only: the suggestion, the revision that was moderated,
    // and the status it moved to. Together with the recipient they are the
    // dedup key, so a retried moderation command inserts nothing.
    submissionId: { type: mongoose.Schema.Types.ObjectId, ref: "AlbumSubmission" },
    submissionRevision: { type: Number, min: 1 },
    submissionStatus: { type: String, enum: SUGGESTION_NOTIFICATION_STATUSES },
    readAt: { type: Date, default: null },
  },
  { timestamps: true },
);

notificationSchema.index({ recipientUserId: 1, readAt: 1, createdAt: -1 });
// Cursor paging reads a recipient's notifications newest first.
notificationSchema.index({ recipientUserId: 1, createdAt: -1, notificationId: -1 });
// Review deletion removes every notification that points at the review.
notificationSchema.index({ reviewId: 1, type: 1 }, { partialFilterExpression: { reviewId: { $exists: true } } });
// Account deletion removes notifications the user sent as well as received.
notificationSchema.index({ actorUserId: 1 });
notificationSchema.index(
  { recipientUserId: 1, actorUserId: 1, reviewId: 1, type: 1 },
  { unique: true, partialFilterExpression: { type: "review_like" } },
);
notificationSchema.index(
  { recipientUserId: 1, actorUserId: 1, type: 1 },
  { unique: true, partialFilterExpression: { type: "follow" } },
);
notificationSchema.index(
  { recipientUserId: 1, submissionId: 1, submissionRevision: 1, submissionStatus: 1, type: 1 },
  { unique: true, partialFilterExpression: { type: "suggestion_status" } },
);
notificationSchema.index(
  { recipientUserId: 1, reviewId: 1, type: 1 },
  { unique: true, partialFilterExpression: { type: "followed_review" } },
);

const Notification = mongoose.model("Notification", notificationSchema);
Notification.NOTIFICATION_TYPES = NOTIFICATION_TYPES;
Notification.SUGGESTION_NOTIFICATION_STATUSES = SUGGESTION_NOTIFICATION_STATUSES;
Notification.MODERATION_ACTOR_ID = MODERATION_ACTOR_ID;

module.exports = Notification;
