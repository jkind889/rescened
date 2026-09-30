const Review = require("../../models/Reviews");
const Follow = require("../../models/Follow");
const UserProfile = require("../../models/UserProfile");

const DEFAULT_SUGGESTION_LIMIT = 5;
const MAX_SUGGESTION_LIMIT = 12;
const SUGGESTION_WINDOW_DAYS = 30;
// Private profiles are dropped after ranking, so over-fetch to keep the list full.
const CANDIDATE_MULTIPLIER = 3;

function getSuggestionLimit(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_SUGGESTION_LIMIT;
  return Math.min(MAX_SUGGESTION_LIMIT, Math.max(1, parsed));
}

// Rank reviewers by reviews written in the last 30 days, then by all-time
// reviews, so a quiet month still suggests the most established reviewers.
function buildSuggestionPipeline({ excludedUserIds = [], limit = DEFAULT_SUGGESTION_LIMIT, now = new Date() } = {}) {
  const since = new Date(now.getTime() - SUGGESTION_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return [
    { $match: { userId: { $nin: [...new Set([Review.DELETED_AUTHOR_ID, ...excludedUserIds])] } } },
    { $group: {
      _id: "$userId",
      recentReviewCount: { $sum: { $cond: [{ $gte: ["$date", since] }, 1, 0] } },
      reviewCount: { $sum: 1 },
      latestReviewDate: { $max: "$date" },
    } },
    { $sort: { recentReviewCount: -1, reviewCount: -1, latestReviewDate: -1, _id: 1 } },
    { $limit: limit * CANDIDATE_MULTIPLIER },
  ];
}

// People worth following: active reviewers who are not the viewer, not already
// followed by the viewer, and not private.
async function suggestPeople({ viewerId = "", limit, now, authors }) {
  const size = getSuggestionLimit(limit);
  const following = viewerId
    ? (await Follow.find({ followerId: viewerId }).select("followingId").lean()).map((row) => row.followingId)
    : [];
  const excludedUserIds = viewerId ? [viewerId, ...following] : [];
  const candidates = await Review.aggregate(buildSuggestionPipeline({ excludedUserIds, limit: size, now }));
  if (!candidates.length) return [];

  const privateIds = new Set((await UserProfile.find({
    userId: { $in: candidates.map((row) => row._id) },
    isPrivate: true,
  }).select("userId").lean()).map((row) => row.userId));
  const visible = candidates.filter((row) => !privateIds.has(row._id)).slice(0, size);
  if (!visible.length) return [];

  const authorMap = await authors(visible.map((row) => row._id));
  return visible.map((row) => {
    const author = authorMap.get(row._id) || {};
    return {
      userId: row._id,
      username: author.username || "rescened user",
      imageUrl: author.imageUrl || "",
      recentReviewCount: row.recentReviewCount,
      reviewCount: row.reviewCount,
      isFollowing: false,
    };
  });
}

module.exports = {
  DEFAULT_SUGGESTION_LIMIT,
  MAX_SUGGESTION_LIMIT,
  SUGGESTION_WINDOW_DAYS,
  getSuggestionLimit,
  buildSuggestionPipeline,
  suggestPeople,
};
