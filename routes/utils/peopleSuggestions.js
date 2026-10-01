const Review = require("../../models/Reviews");
const Follow = require("../../models/Follow");
const UserProfile = require("../../models/UserProfile");

const DEFAULT_SUGGESTION_LIMIT = 5;
const MAX_SUGGESTION_LIMIT = 12;
const SUGGESTION_WINDOW_DAYS = 30;
// The site-wide ranking is shared by every viewer and cached, so the reviews
// scan runs at most once per TTL per process instead of on every page view.
// The pool is deep enough that removing a viewer's circle and private profiles
// still leaves a full list in practice.
const CANDIDATE_POOL_SIZE = 100;
const CANDIDATE_POOL_TTL_MS = 5 * 60 * 1000;
const RANKING_MAX_TIME_MS = 5_000;

let cachedPool = null;

function getSuggestionLimit(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_SUGGESTION_LIMIT;
  return Math.min(MAX_SUGGESTION_LIMIT, Math.max(1, parsed));
}

// Rank reviewers by reviews written in the last 30 days, then by all-time
// reviews, so a quiet month still suggests the most established reviewers.
function buildSuggestionPipeline({ limit = CANDIDATE_POOL_SIZE, now = new Date() } = {}) {
  const since = new Date(now.getTime() - SUGGESTION_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return [
    { $match: { userId: { $ne: Review.DELETED_AUTHOR_ID } } },
    { $group: {
      _id: "$userId",
      recentReviewCount: { $sum: { $cond: [{ $gte: ["$date", since] }, 1, 0] } },
      reviewCount: { $sum: 1 },
      latestReviewDate: { $max: "$date" },
    } },
    { $sort: { recentReviewCount: -1, reviewCount: -1, latestReviewDate: -1, _id: 1 } },
    { $limit: limit },
  ];
}

async function rankCandidates({ now, authors }) {
  const ranked = await Review.aggregate(buildSuggestionPipeline({ now })).option({ maxTimeMS: RANKING_MAX_TIME_MS });
  if (!ranked.length) return [];
  // Clerk's user list returns 10 users unless a larger limit is requested.
  const authorMap = await authors(ranked.map((row) => row._id), { limit: ranked.length });
  return ranked.map((row) => {
    const author = authorMap.get(row._id) || {};
    return {
      userId: row._id,
      username: author.username || "rescened user",
      imageUrl: author.imageUrl || "",
      recentReviewCount: row.recentReviewCount,
      reviewCount: row.reviewCount,
    };
  });
}

// Concurrent requests share one in-flight ranking; a failed ranking is not cached.
function candidatePool({ now, authors, clock = Date.now }) {
  const current = clock();
  if (cachedPool && cachedPool.expiresAt > current) return cachedPool.promise;
  const promise = rankCandidates({ now: now || new Date(current), authors });
  const entry = { expiresAt: current + CANDIDATE_POOL_TTL_MS, promise };
  cachedPool = entry;
  promise.catch(() => { if (cachedPool === entry) cachedPool = null; });
  return promise;
}

function resetSuggestionCache() {
  cachedPool = null;
}

// People worth following: active reviewers who are not the viewer, not already
// followed by the viewer, and not private. Follows and privacy are read fresh
// on every request, so the cache never shows a stale circle or a private profile.
async function suggestPeople({ viewerId = "", limit, now, authors, clock }) {
  const size = getSuggestionLimit(limit);
  const [pool, following] = await Promise.all([
    candidatePool({ now, authors, clock }),
    viewerId ? Follow.find({ followerId: viewerId }).select("followingId").lean() : [],
  ]);
  const excluded = new Set(viewerId ? [viewerId, ...following.map((row) => row.followingId)] : []);
  const remaining = pool.filter((row) => !excluded.has(row.userId));
  if (!remaining.length) return [];

  const privateIds = new Set((await UserProfile.find({
    userId: { $in: remaining.map((row) => row.userId) },
    isPrivate: true,
  }).select("userId").lean()).map((row) => row.userId));
  return remaining
    .filter((row) => !privateIds.has(row.userId))
    .slice(0, size)
    .map((row) => ({ ...row, isFollowing: false }));
}

module.exports = {
  DEFAULT_SUGGESTION_LIMIT,
  MAX_SUGGESTION_LIMIT,
  SUGGESTION_WINDOW_DAYS,
  CANDIDATE_POOL_SIZE,
  CANDIDATE_POOL_TTL_MS,
  RANKING_MAX_TIME_MS,
  getSuggestionLimit,
  buildSuggestionPipeline,
  resetSuggestionCache,
  suggestPeople,
};
