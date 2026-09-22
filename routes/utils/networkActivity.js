const Follow = require("../../models/Follow");
const UserProfile = require("../../models/UserProfile");
const Review = require("../../models/Reviews");
const AlbumCatalog = require("../../models/AlbumCatalog");
const Like = require("../../models/Like");
const { normalizeCatalogAlbum } = require("./albumCatalog");
const { persistedReviewId } = require("./reviewInteractions");
const { getListenActivity } = require("./listenActivity");

const NETWORK_ACTIVITY_LIMIT = 20;

function buildNetworkReviewsPipeline(userIds, viewerId) {
  return [
    { $match: { userId: { $in: userIds } } },
    { $sort: { date: -1, _id: -1 } },
    {
      $lookup: {
        from: AlbumCatalog.collection.name,
        localField: "albumCatalogId",
        foreignField: "_id",
        as: "catalogAlbum",
      },
    },
    // Missing catalog records must not produce broken links or consume a slot.
    { $unwind: "$catalogAlbum" },
    { $limit: NETWORK_ACTIVITY_LIMIT },
    {
      $lookup: {
        from: Like.collection.name,
        let: { currentReviewId: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$targetType", "review"] },
                  { $eq: ["$reviewId", "$$currentReviewId"] },
                ],
              },
            },
          },
          {
            $group: {
              _id: null,
              count: { $sum: 1 },
              viewerCount: { $sum: { $cond: [{ $eq: ["$userId", viewerId] }, 1, 0] } },
            },
          },
        ],
        as: "likeStats",
      },
    },
    {
      $project: {
        _id: 1,
        reviewId: 1,
        userId: 1,
        date: 1,
        rating: 1,
        reviewText: 1,
        catalogAlbum: 1,
        likeCount: { $ifNull: [{ $arrayElemAt: ["$likeStats.count", 0] }, 0] },
        likedByViewer: { $gt: [{ $ifNull: [{ $arrayElemAt: ["$likeStats.viewerCount", 0] }, 0] }, 0] },
      },
    },
  ];
}

async function getNetworkActivity(viewerId, getAuthors) {
  const follows = await Follow.find({ followerId: viewerId }).select("followingId").lean();
  const followedIds = [...new Set(follows.map((row) => row.followingId).filter((id) => id && id !== viewerId))];
  if (followedIds.length === 0) return [];

  // Following someone is not permission to read their private profile activity.
  // Profiles that have not been created yet retain the default public behavior.
  const privateProfiles = await UserProfile.find({ userId: { $in: followedIds }, isPrivate: true }).select("userId").lean();
  const privateIds = new Set(privateProfiles.map((profile) => profile.userId));
  const visibleIds = followedIds.filter((id) => !privateIds.has(id));
  if (visibleIds.length === 0) return [];

  // Fetch bounded candidates across all visible accounts for each event type.
  const [reviews, listens] = await Promise.all([
    Review.aggregate(buildNetworkReviewsPipeline(visibleIds, viewerId)),
    getListenActivity(visibleIds, NETWORK_ACTIVITY_LIMIT),
  ]);
  const reviewActivities = reviews.map((review) => {
    const reviewId = persistedReviewId(review);
    return {
      id: reviewId,
      reviewId,
      type: "review",
      userId: review.userId,
      createdAt: review.date,
      album: normalizeCatalogAlbum(review.catalogAlbum),
      rating: review.rating,
      reviewText: review.reviewText,
      likeCount: review.likeCount,
      likedByViewer: review.likedByViewer,
    };
  });
  // Stable ties preserve each query's internal ordering, with reviews first.
  const activities = [...reviewActivities, ...listens]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, NETWORK_ACTIVITY_LIMIT);
  if (activities.length === 0) return [];
  const authors = await getAuthors(activities.map((item) => item.userId));
  return activities.map((item) => ({
    ...item,
    actor: authors.get(item.userId) || { userId: item.userId, username: "rescened user", imageUrl: "" },
  }));
}

module.exports = { NETWORK_ACTIVITY_LIMIT, buildNetworkReviewsPipeline, getNetworkActivity };
