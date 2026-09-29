const Board = require("../models/Board");
const BoardItem = require("../models/BoardItem");
const BoardListen = require("../models/BoardListen");
const Follow = require("../models/Follow");
const Like = require("../models/Like");
const Listen = require("../models/Listen");
const ListenCreation = require("../models/ListenCreation");
const Notification = require("../models/Notification");
const Review = require("../models/Reviews");
const UserProfile = require("../models/UserProfile");

// Removes a deleted account's user-owned data inside the caller's transaction.
// Reviews stay public under a server-only anonymous author; other users' likes
// on them are theirs and are kept. Album submissions and moderation history are
// append-only and are not touched.
async function removeAccountData(userId, session) {
  if (!session) throw new Error("Account data removal requires a transaction session");
  const options = { session };
  const boardIds = await Board.distinct("_id", { userId }).session(session);
  const ownedByUserOrBoard = { $or: [{ userId }, { boardId: { $in: boardIds } }] };

  // Memberships go before listens so no committed state holds one without its listen.
  await BoardListen.deleteMany(ownedByUserOrBoard, options);
  await Listen.deleteMany({ userId }, options);
  await ListenCreation.deleteMany({ userId }, options);
  await BoardItem.deleteMany(ownedByUserOrBoard, options);
  await UserProfile.updateMany({ pinnedBoardId: { $in: boardIds } }, { $set: { pinnedBoardId: null } }, options);
  await Board.deleteMany({ userId }, options);

  await Like.deleteMany({ userId }, options);
  await Follow.deleteMany({ $or: [{ followerId: userId }, { followingId: userId }] }, options);
  await Notification.deleteMany({ $or: [{ recipientUserId: userId }, { actorUserId: userId }] }, options);
  await UserProfile.deleteOne({ userId }, options);

  // Claiming each review's revision makes a concurrent like, pin, edit, or
  // delete conflict with the anonymization instead of racing it.
  await Review.updateMany(
    { userId },
    { $set: { userId: Review.DELETED_AUTHOR_ID }, $unset: { creationKey: 1 }, $inc: { interactionRevision: 1 } },
    { ...options, overwriteImmutable: true },
  );
}

module.exports = { removeAccountData };
