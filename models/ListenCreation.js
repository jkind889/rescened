const mongoose = require("mongoose");
const { UUID_V4 } = require("../routes/utils/diaryValidation");

// Minimal receipts survive listen deletion; a delayed retry cannot resurrect it.
const schema = new mongoose.Schema({
  userId: { type: String, required: true, immutable: true },
  key: { type: String, required: true, immutable: true, match: UUID_V4 },
  fingerprint: { type: String, required: true, immutable: true },
  listenId: { type: String, required: true, immutable: true, match: UUID_V4 },
});
schema.index({ userId: 1, key: 1 }, { unique: true });

module.exports = mongoose.model("ListenCreation", schema);
