const crypto = require("node:crypto");
const mongoose = require("mongoose");
const { UUID_V4, isCalendarDate } = require("../routes/utils/diaryValidation");

const schema = new mongoose.Schema({
  listenId: {
    type: String, required: true, unique: true, immutable: true, lowercase: true, match: UUID_V4,
    default: function defaultListenId() { return this.isNew ? crypto.randomUUID() : undefined; },
  },
  userId: { type: String, required: true, immutable: true },
  albumCatalogId: { type: mongoose.Schema.Types.ObjectId, ref: "AlbumCatalog", required: true, immutable: true },
  listenedOn: { type: String, required: true, validate: isCalendarDate },
  // Server-authored; manual creation input cannot set it.
  source: { type: String, enum: ["manual", "automatic"], default: "manual", immutable: true },
  interactionRevision: { type: Number, default: 0, select: false },
}, { timestamps: true });

schema.index({ userId: 1, listenedOn: -1, createdAt: -1, _id: -1 });
schema.index({ userId: 1, albumCatalogId: 1, listenedOn: -1, createdAt: -1, _id: -1 });
// Network and profile activity order listens by creation across many users.
schema.index({ userId: 1, createdAt: -1, _id: -1 });

module.exports = mongoose.model("Listen", schema);
