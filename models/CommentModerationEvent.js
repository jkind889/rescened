const mongoose = require("mongoose");

// `restored` is reserved for a later restore command; nothing writes it yet.
const MODERATION_ACTIONS = ["removed", "restored", "dismissed_reports"];

// Append-only audit trail for comment moderation. Events are only deleted
// together with their comment (review deletion or account deletion).
const commentModerationEventSchema = new mongoose.Schema({
  commentId: { type: mongoose.Schema.Types.ObjectId, ref: "ReviewComment", required: true, immutable: true },
  actorUserId: { type: String, required: true, immutable: true },
  action: { type: String, enum: MODERATION_ACTIONS, required: true, immutable: true },
  reason: { type: String, required: true, maxlength: 1000, immutable: true },
  // Open reports the command closed.
  reportCount: { type: Number, default: 0, min: 0, immutable: true },
  createdAt: { type: Date, default: Date.now, immutable: true },
});

commentModerationEventSchema.index({ commentId: 1, createdAt: 1 });

const CommentModerationEvent = mongoose.model("CommentModerationEvent", commentModerationEventSchema);
CommentModerationEvent.MODERATION_ACTIONS = MODERATION_ACTIONS;

module.exports = CommentModerationEvent;
