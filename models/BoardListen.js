const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  userId: { type: String, required: true },
  boardId: { type: mongoose.Schema.Types.ObjectId, ref: "Board", required: true },
  listenId: { type: mongoose.Schema.Types.ObjectId, ref: "Listen", required: true },
  albumCatalogId: { type: mongoose.Schema.Types.ObjectId, ref: "AlbumCatalog", required: true },
  addedAt: { type: Date, default: Date.now, required: true },
});

schema.index({ boardId: 1, listenId: 1 }, { unique: true });
schema.index({ boardId: 1, albumCatalogId: 1 });
schema.index({ listenId: 1 });
schema.index({ userId: 1, albumCatalogId: 1 });
schema.index({ albumCatalogId: 1, userId: 1 });

module.exports = mongoose.model("BoardListen", schema);
