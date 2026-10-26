// Moderator queue and commands for reported comments. Reports never hide a
// comment on their own; a moderator removes it or dismisses its reports.

const AlbumCatalog = require("../../models/AlbumCatalog");
const CommentModerationEvent = require("../../models/CommentModerationEvent");
const CommentReport = require("../../models/CommentReport");
const Notification = require("../../models/Notification");
const Review = require("../../models/Reviews");
const ReviewComment = require("../../models/ReviewComment");
const { normalizeCatalogAlbum } = require("../../routes/utils/albumCatalog");
const { persistedReviewId } = require("../../routes/utils/reviewInteractions");
const { conflict, invalid, notFound, runCommentTransaction } = require("./common");

const DEFAULT_QUEUE_LIMIT = 20;
const MAX_QUEUE_LIMIT = 50;
const REPORTS_PER_ITEM = 20;

function idKey(value) { return String(value?._id || value || ""); }

function parseQueueLimit(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_QUEUE_LIMIT;
  const limit = Number(value);
  if (!/^\d+$/.test(String(value)) || limit < 1 || limit > MAX_QUEUE_LIMIT) throw invalid(`limit must be between 1 and ${MAX_QUEUE_LIMIT}`);
  return limit;
}

function person(authors, userId) {
  const author = authors.get(userId) || { userId, username: "rescened user", imageUrl: "" };
  return { userId: author.userId, username: author.username, imageUrl: author.imageUrl || "" };
}

// Visible comments with open reports, most reported first, then oldest
// report first. Acting on an item removes it, so the queue has no cursor:
// the next items surface as the first ones are handled.
async function readReportQueue({ limit: limitValue } = {}, getAuthors) {
  const limit = parseQueueLimit(limitValue);
  // Grouping by (comment, reason) first keeps per-comment state to one entry
  // per reason; only the page's items load their individual reports.
  const [result] = await CommentReport.aggregate([
    { $match: { status: "open" } },
    { $group: { _id: { commentId: "$commentId", reason: "$reason" }, count: { $sum: 1 }, firstReportedAt: { $min: "$createdAt" } } },
    { $group: {
      _id: "$_id.commentId",
      reportCount: { $sum: "$count" },
      firstReportedAt: { $min: "$firstReportedAt" },
      reasonCounts: { $push: { reason: "$_id.reason", count: "$count" } },
    } },
    { $lookup: { from: ReviewComment.collection.name, localField: "_id", foreignField: "_id", as: "comment" } },
    { $unwind: "$comment" },
    { $match: { "comment.status": "visible" } },
    { $sort: { reportCount: -1, firstReportedAt: 1, "comment.commentId": 1 } },
    { $facet: {
      total: [{ $count: "count" }],
      page: [
        { $limit: limit },
        { $lookup: {
          from: CommentReport.collection.name,
          let: { commentId: "$_id" },
          pipeline: [
            { $match: { $expr: { $and: [{ $eq: ["$commentId", "$$commentId"] }, { $eq: ["$status", "open"] }] } } },
            { $sort: { createdAt: 1 } },
            { $limit: REPORTS_PER_ITEM },
            { $project: { _id: 0, reportId: 1, reason: 1, note: 1, reporterUserId: 1, createdAt: 1 } },
          ],
          as: "reports",
        } },
      ],
    } },
  ]);
  const page = result?.page || [];
  const reviews = await Review.find({ _id: { $in: page.map((item) => item.comment.reviewId) } }).lean();
  const reviewMap = new Map(reviews.map((review) => [idKey(review), review]));
  const albums = await AlbumCatalog.find({ _id: { $in: reviews.map((review) => review.albumCatalogId) } });
  const albumMap = new Map(albums.map((album) => [idKey(album), normalizeCatalogAlbum(album)]));
  const authors = await getAuthors([
    ...page.map((item) => item.comment.userId),
    ...reviews.map((review) => review.userId).filter((id) => !Review.isDeletedAuthor(id)),
    ...page.flatMap((item) => item.reports.map((report) => report.reporterUserId)),
  ]);

  const items = page.map((item) => {
    const review = reviewMap.get(idKey(item.comment.reviewId));
    const reasons = Object.fromEntries(item.reasonCounts.map((entry) => [entry.reason, entry.count]));
    return {
      comment: {
        commentId: item.comment.commentId,
        body: item.comment.body,
        author: person(authors, item.comment.userId),
        isReply: Boolean(item.comment.parentCommentId),
        createdAt: item.comment.createdAt,
        editedAt: item.comment.editedAt || null,
      },
      review: review ? {
        reviewId: persistedReviewId(review),
        rating: review.rating,
        reviewText: review.reviewText,
        author: Review.isDeletedAuthor(review.userId) ? { userId: null, username: "deleted user", imageUrl: "" } : person(authors, review.userId),
      } : null,
      album: review ? albumMap.get(idKey(review.albumCatalogId)) || null : null,
      reportCount: item.reportCount,
      firstReportedAt: item.firstReportedAt,
      reasons,
      reports: item.reports.map((report) => ({
        reportId: report.reportId,
        reason: report.reason,
        note: report.note || "",
        createdAt: report.createdAt,
        reporter: person(authors, report.reporterUserId),
      })),
    };
  });
  return { items, total: result?.total?.[0]?.count || 0 };
}

async function closeReports(commentObjectId, status, session) {
  const result = await CommentReport.updateMany(
    { commentId: commentObjectId, status: "open" },
    { $set: { status, resolvedAt: new Date() } },
    { session },
  );
  return result.modifiedCount || 0;
}

// Removal hides the comment, closes its open reports as actioned, deletes its
// notifications, and appends an audit event, all in one transaction. Removing
// a comment that is no longer visible is a conflict, not a silent repeat.
async function removeComment({ commentId, actorUserId, reason }) {
  return runCommentTransaction(async (session) => {
    const comment = await ReviewComment.findOneAndUpdate(
      { commentId, status: "visible" },
      { $set: { status: "removed_by_moderator" }, $inc: { interactionRevision: 1 } },
      { returnDocument: "after", session, lean: true },
    );
    if (!comment) {
      if (!(await ReviewComment.exists({ commentId }).session(session))) throw notFound();
      throw conflict("This comment is no longer visible");
    }
    const reportCount = await closeReports(comment._id, "actioned", session);
    await Notification.deleteMany({ commentId: comment._id }, { session });
    await CommentModerationEvent.create([{ commentId: comment._id, actorUserId, action: "removed", reason, reportCount }], { session });
    return { commentId: comment.commentId, status: comment.status, reportsClosed: reportCount };
  });
}

async function dismissReports({ commentId, actorUserId, reason }) {
  return runCommentTransaction(async (session) => {
    const comment = await ReviewComment.findOneAndUpdate(
      { commentId },
      { $inc: { interactionRevision: 1 } },
      { returnDocument: "after", session, lean: true },
    );
    if (!comment) throw notFound();
    const reportCount = await closeReports(comment._id, "dismissed", session);
    if (!reportCount) throw conflict("This comment has no open reports");
    await CommentModerationEvent.create([{ commentId: comment._id, actorUserId, action: "dismissed_reports", reason, reportCount }], { session });
    return { commentId: comment.commentId, status: comment.status, reportsClosed: reportCount };
  });
}

module.exports = { MAX_QUEUE_LIMIT, dismissReports, parseQueueLimit, readReportQueue, removeComment };
