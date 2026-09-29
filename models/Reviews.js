const crypto = require("node:crypto");
const mongoose = require("mongoose");

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const reviewSchema = new mongoose.Schema({
  // Public, immutable identity. Mongo's _id remains an internal relation key
  // for likes, notifications, profile pins, pagination, and transactions.
  // The conditional default deliberately does not manufacture an ID while
  // hydrating a legacy document that still needs the explicit backfill.
  reviewId: {
    type: String,
    required: true,
    unique: true,
    immutable: true,
    lowercase: true,
    default: function defaultReviewId() { return this.isNew ? crypto.randomUUID() : undefined; },
    match: UUID_V4,
  },
  userId: { type: String, required: true },
  albumCatalogId: { type: mongoose.Schema.Types.ObjectId, ref: "AlbumCatalog", required: true },
  reviewText: { type: String, required: true, trim: true, maxlength: 300 },
  rating: {
    type: Number,
    required: true,
    min: 1,
    max: 5,
    validate: { validator: (value) => Number.isInteger(value * 2), message: "Rating must be a whole or half number" },
  },
  date: { type: Date, default: Date.now },
  // Internal serialization token for review deletion, likes, and pinning.
  // This is intentionally excluded from every public representation.
  interactionRevision: { type: Number, default: 0, select: false },
  // Private request key used only to make a creation retry idempotent. It is
  // not a public review identifier and is excluded from all serializers.
  creationKey: { type: String, select: false, immutable: true },
});

// Server-only author kept on reviews after their account is deleted. The colon
// places it outside Clerk's user ID format; serializers never expose it.
const DELETED_AUTHOR_ID = "rescened:deleted-user";
reviewSchema.statics.DELETED_AUTHOR_ID = DELETED_AUTHOR_ID;
reviewSchema.statics.isDeletedAuthor = function isDeletedAuthor(userId) { return userId === DELETED_AUTHOR_ID; };

reviewSchema.index({ albumCatalogId: 1, date: -1, _id: -1 });
reviewSchema.index({ userId: 1, date: -1, _id: -1 });
reviewSchema.index({ date: -1, _id: -1 });
reviewSchema.index(
  { userId: 1, creationKey: 1 },
  { unique: true, partialFilterExpression: { creationKey: { $type: "string" } } },
);

module.exports = mongoose.model("Review", reviewSchema);
