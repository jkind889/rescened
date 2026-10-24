const mongoose = require("mongoose");

const followSchema = new mongoose.Schema(
  {
    followerId: {
      type: String,
      required: true,
    },
    followingId: {
      type: String,
      required: true,
    },
  },
  { timestamps: true },
);

followSchema.index({ followerId: 1, followingId: 1 }, { unique: true });
followSchema.index({ followingId: 1 });
// The followed-review fan-out walks a reviewer's followers, most recent first.
followSchema.index({ followingId: 1, createdAt: -1, _id: -1 });
followSchema.index({ followerId: 1, createdAt: -1 });

const Follow = mongoose.model("Follow", followSchema);

module.exports = Follow;
