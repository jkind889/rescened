const mongoose = require("mongoose");
const { UUID_V4 } = require("../routes/utils/diaryValidation");

// Durable suppression receipt for an automatically detected play. It survives
// listen deletion so retries, reprocessing, or reconnects cannot resurrect a
// removed or dismissed entry. It holds opaque identifiers only: no listening
// sequence or playback timestamps.
const receiptSchema = new mongoose.Schema({
  userId: { type: String, required: true, immutable: true },
  playId: { type: String, required: true, immutable: true, match: UUID_V4 },
  firstEventId: { type: String, required: true, immutable: true },
  qualifyingEventId: { type: String, required: true, immutable: true },
  outcome: { type: String, required: true, immutable: true, enum: ["published", "dismissed"] },
  listenId: { type: String, default: null, immutable: true },
  // Day-rounded: after this, the play's evidence can no longer be re-ingested.
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
}, { timestamps: { createdAt: true, updatedAt: false } });
receiptSchema.index({ userId: 1, playId: 1 }, { unique: true });
receiptSchema.index({ userId: 1, firstEventId: 1 });
receiptSchema.index({ userId: 1, qualifyingEventId: 1 });

// Write fence shared by manual and automatic listen creation for one album, so
// the duplicate check and the insert serialize without a date unique constraint.
const fenceSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  albumCatalogId: { type: mongoose.Schema.Types.ObjectId, ref: "AlbumCatalog", required: true },
  revision: { type: Number, required: true, default: 0 },
});
fenceSchema.index({ userId: 1, albumCatalogId: 1 }, { unique: true });

function model(name, schema) {
  return mongoose.models[name] || mongoose.model(name, schema);
}

module.exports = {
  AutomaticListenReceipt: model("AutomaticListenReceipt", receiptSchema),
  DiaryAlbumFence: model("DiaryAlbumFence", fenceSchema),
};
