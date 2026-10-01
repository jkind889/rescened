const mongoose = require("mongoose");

const likeSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    targetType: { type: String, enum: ["album", "review"], required: true },
    albumCatalogId: { type: mongoose.Schema.Types.ObjectId, ref: "AlbumCatalog" },
    reviewId: { type: mongoose.Schema.Types.ObjectId, ref: "Review" },
  },
  { timestamps: true },
);

likeSchema.index(
  { userId: 1, targetType: 1, albumCatalogId: 1 },
  { unique: true, partialFilterExpression: { targetType: "album", albumCatalogId: { $exists: true } } },
);
likeSchema.index(
  { userId: 1, targetType: 1, reviewId: 1 },
  { unique: true, partialFilterExpression: { targetType: "review", reviewId: { $exists: true } } },
);
// The unique indexes above are partial, so a plain userId query (account
// deletion) cannot use them.
likeSchema.index({ userId: 1 });
likeSchema.index({ targetType: 1, albumCatalogId: 1 });
likeSchema.index({ targetType: 1, reviewId: 1 });
likeSchema.index({ targetType: 1, reviewId: 1, createdAt: 1 });

module.exports = mongoose.model("Like", likeSchema);
