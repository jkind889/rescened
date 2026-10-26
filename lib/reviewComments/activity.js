const ReviewComment = require("../../models/ReviewComment");
const Review = require("../../models/Reviews");
const AlbumCatalog = require("../../models/AlbumCatalog");
const { normalizeCatalogAlbum } = require("../../routes/utils/albumCatalog");
const { excerpt, isReviewCommentsEnabled } = require("./common");

// Virtual events: edits update the excerpt without moving the event; removal
// and cascades disappear on the next read. Callers enforce actor visibility.
async function getCommentActivity(userIds, limit, getAuthors) {
  if (!isReviewCommentsEnabled() || !userIds.length) return [];
  const rows = await ReviewComment.aggregate([
    { $match: { userId: { $in: userIds, $ne: ReviewComment.DELETED_AUTHOR_ID }, status: "visible" } },
    { $sort: { createdAt: -1, commentId: -1 } },
    { $lookup: { from: Review.collection.name, localField: "reviewId", foreignField: "_id", as: "review" } },
    { $unwind: "$review" },
    { $lookup: { from: AlbumCatalog.collection.name, localField: "review.albumCatalogId", foreignField: "_id", as: "album" } },
    { $unwind: "$album" },
    { $lookup: { from: ReviewComment.collection.name, localField: "parentCommentId", foreignField: "_id", as: "parent" } },
    // Replies to tombstones remain public, but orphaned/cross-review replies do not.
    { $match: { $or: [{ parentCommentId: null }, { $expr: { $and: [
      { $eq: [{ $arrayElemAt: ["$parent.reviewId", 0] }, "$reviewId"] },
      { $eq: [{ $arrayElemAt: ["$parent.parentCommentId", 0] }, null] },
    ] } }] } },
    { $limit: limit },
    { $project: { _id: 0, commentId: 1, userId: 1, body: 1, createdAt: 1,
      reviewId: "$review.reviewId", reviewAuthorId: "$review.userId", album: 1,
      threadId: { $ifNull: [{ $arrayElemAt: ["$parent.commentId", 0] }, "$commentId"] },
      isReply: { $ne: ["$parentCommentId", null] } } },
  ]);
  if (!rows.length) return [];
  const authorIds = [...new Set(rows.map((row) => row.reviewAuthorId).filter((id) => !Review.isDeletedAuthor(id)))];
  const authors = authorIds.length ? await getAuthors(authorIds) : new Map();
  return rows.map((row) => ({
    id: `comment:${row.commentId}`,
    type: row.isReply ? "comment_reply" : "review_comment",
    userId: row.userId,
    createdAt: row.createdAt,
    commentId: row.commentId,
    threadId: row.threadId,
    reviewId: row.reviewId,
    reviewAuthor: Review.isDeletedAuthor(row.reviewAuthorId)
      ? { userId: null, username: "Deleted user", imageUrl: "" }
      : authors.get(row.reviewAuthorId) || { userId: row.reviewAuthorId, username: "rescened user", imageUrl: "" },
    excerpt: excerpt(row.body),
    album: normalizeCatalogAlbum(row.album),
  }));
}

// Preserve existing source ordering on ties. Comment events (both kinds)
// share one public-ID tie break, matching their database candidate ordering.
const TYPE_ORDER = ["review", "listen", "ranked_album", "saved_album"];
const typeOrder = (item) => item.id.startsWith("comment:") ? 4 : TYPE_ORDER.indexOf(item.type);
function compareActivity(a, b) {
  return new Date(b.createdAt) - new Date(a.createdAt)
    || typeOrder(a) - typeOrder(b)
    || (typeOrder(a) === 4 ? b.id.localeCompare(a.id) : 0);
}

module.exports = { getCommentActivity, compareActivity };
