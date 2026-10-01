const crypto = require("node:crypto");
const mongoose = require("mongoose");

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    type: { type: String, enum: ["review_like", "follow"], required: true },
    reviewId: { type: mongoose.Schema.Types.ObjectId, ref: "Review" },
    readAt: { type: Date, default: null },
  },
  { timestamps: true },
);

notificationSchema.index({ recipientUserId: 1, readAt: 1, createdAt: -1 });
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

module.exports = mongoose.model("Notification", notificationSchema);
