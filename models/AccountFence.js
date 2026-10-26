const mongoose = require("mongoose");

// Internal account lifecycle lock. A deletion marker must survive cleanup so
// an already-authenticated request cannot recreate data after the webhook.
// The key is a digest of the Clerk ID; no profile or content is retained here.
const accountFenceSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  deleted: { type: Boolean, default: false, required: true },
  revision: { type: Number, default: 0, required: true },
}, { versionKey: false });

module.exports = mongoose.model("AccountFence", accountFenceSchema);
