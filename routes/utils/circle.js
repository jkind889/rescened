const Follow = require("../../models/Follow");
const UserProfile = require("../../models/UserProfile");

// The viewer plus every followed account whose profile is not private. Following
// someone is not permission to read their private profile data, so circle-scoped
// aggregates leave private accounts out, the same as the network activity feed.
// Accounts without a profile document keep the default public behavior.
async function visibleCircleUserIds(viewerId) {
  const follows = await Follow.find({ followerId: viewerId }).select("followingId").lean();
  const followedIds = [...new Set(follows.map((row) => row.followingId).filter((id) => id && id !== viewerId))];
  if (!followedIds.length) return [viewerId];
  const privateProfiles = await UserProfile.find({ userId: { $in: followedIds }, isPrivate: true }).select("userId").lean();
  const privateIds = new Set(privateProfiles.map((profile) => profile.userId));
  return [viewerId, ...followedIds.filter((id) => !privateIds.has(id))];
}

module.exports = { visibleCircleUserIds };
