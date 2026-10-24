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

const queuedAlbumSchema = new mongoose.Schema(
  {
    albumCatalogId: { type: mongoose.Schema.Types.ObjectId, ref: "AlbumCatalog", required: true },
    addedAt: { type: Date, required: true },
  },
  { _id: false },
);

// One switch per notification type a user can mute. Missing values read as on,
// so profiles written before preferences existed receive everything.
// suggestion_status is deliberately absent: it cannot be muted.
const notificationPreferencesSchema = new mongoose.Schema(
  {
    review_like: { type: Boolean, default: true },
    follow: { type: Boolean, default: true },
    followed_review: { type: Boolean, default: true },
  },
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
    // Legacy single "listening next" album. It reads as the queue until the
    // first queue write, which moves it into listenQueue and clears it.
    listeningNextAlbum: { type: profileAlbumSchema, default: null },
    listenQueue: {
      type: [queuedAlbumSchema],
      default: [],
      validate: { validator: (value) => value.length <= 15, message: "A listen queue can hold at most 15 albums." },
    },
    // Internal concurrency token for queue writes; 0 means the queue was never written.
    queueRevision: { type: Number, default: 0, min: 0 },
    pinnedReviewId: { type: mongoose.Schema.Types.ObjectId, ref: "Review", default: null },
    pinnedBoardId: { type: mongoose.Schema.Types.ObjectId, ref: "Board", default: null },
    notificationPreferences: { type: notificationPreferencesSchema, default: () => ({}) },
  },
  { timestamps: true },
);

// Board and account deletion unpin every profile that pinned a removed board.
userProfileSchema.index({ pinnedBoardId: 1 });

module.exports = mongoose.model("UserProfile", userProfileSchema);
