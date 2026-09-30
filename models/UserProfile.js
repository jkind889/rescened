const mongoose = require("mongoose");

const favoriteAlbumSchema = new mongoose.Schema(
  {
    albumCatalogId: { type: mongoose.Schema.Types.ObjectId, ref: "AlbumCatalog", required: true },
    rank: { type: Number, required: true, min: 0, max: 4 },
  },
  { _id: false },
);

const profileAlbumSchema = new mongoose.Schema(
  { albumCatalogId: { type: mongoose.Schema.Types.ObjectId, ref: "AlbumCatalog", required: true } },
  { _id: false },
);

const userProfileSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, unique: true },
    bio: { type: String, default: "", maxlength: 280, trim: true },
    spotifyProfileUrl: { type: String, default: "", trim: true },
    isPrivate: { type: Boolean, default: false },
    favoriteAlbums: {
      type: [favoriteAlbumSchema],
      default: [],
      validate: { validator: (value) => value.length <= 5, message: "A profile can have at most five favorite albums." },
    },
    listeningNextAlbum: { type: profileAlbumSchema, default: null },
    pinnedReviewId: { type: mongoose.Schema.Types.ObjectId, ref: "Review", default: null },
    pinnedBoardId: { type: mongoose.Schema.Types.ObjectId, ref: "Board", default: null },
  },
  { timestamps: true },
);

// Board and account deletion unpin every profile that pinned a removed board.
userProfileSchema.index({ pinnedBoardId: 1 });

module.exports = mongoose.model("UserProfile", userProfileSchema);
