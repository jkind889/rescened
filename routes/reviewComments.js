const express = require("express");
const { getAuth } = require("@clerk/express");
const { commentAuthors } = require("../lib/reviewComments/authors");
const AlbumCatalog = require("../models/AlbumCatalog");
const Review = require("../models/Reviews");
const ReviewComment = require("../models/ReviewComment");
const UserProfile = require("../models/UserProfile");
const { assertReviewId } = require("./utils/reviewInteractions");
const {
  commentCreateRateLimit,
  commentMutationRateLimit,
  commentReportRateLimit,
} = require("./utils/rateLimit");
const {
  REPLY_PREVIEW_SIZE,
  assertCommentId,
  creationKey,
  isReviewCommentsEnabled,
  notFound,
  parseCreateBody,
  parseEditBody,
  parseReportBody,
  reviewNotFound,
} = require("../lib/reviewComments/common");
const { readFocusedThread, commentCounts, readReplies, readThread, serializeComment } = require("../lib/reviewComments/read");
const { createComment, deleteComment, editComment, reportComment } = require("../lib/reviewComments/commands");

// Mounted at /reviews next to the review routes.
const router = express.Router();

function viewer(req) { try { return getAuth(req).userId || ""; } catch { return ""; } }
function auth(req, res, next) {
  const userId = viewer(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized", code: "UNAUTHORIZED" });
  req.userId = userId;
  return next();
}
// With the flag off, threads stay readable and every write is refused.
function commentsEnabled(req, res, next) {
  if (!isReviewCommentsEnabled()) return res.status(503).json({ error: "Comments are currently turned off", code: "COMMENTS_DISABLED" });
  return next();
}
function sendError(res, error, fallback) {
  if (error?.status && error.status < 500) return res.status(error.status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
  if (error?.status === 503) return res.status(503).json({ error: error.message, code: error.code });
  if (error?.name === "ValidationError") return res.status(400).json({ error: "Comment is invalid", code: "INVALID_COMMENT_REQUEST" });
  return res.status(500).json({ error: fallback });
}

// Matches the review permalink: a review whose album no longer resolves is
// hidden, and so is its thread.
async function findReview(publicId) {
  const review = await Review.findOne({ reviewId: assertReviewId(publicId) }).lean();
  if (!review || !(await AlbumCatalog.exists({ _id: review.albumCatalogId }))) throw reviewNotFound();
  return review;
}

// Creation retries can return an existing top-level thread. Include its real
// reply preview; an edit leaves the client's thread state alone.
async function serializeOne(row, { newThread = false } = {}) {
  const parent = row.parentCommentId ? await ReviewComment.findById(row.parentCommentId, { commentId: 1 }).lean() : null;
  const authors = await commentAuthors([row.userId, row.replyToUserId]);
  let thread = null;
  if (newThread && !row.parentCommentId) {
    const [page, replyCount] = await Promise.all([
      readReplies({ _id: row.reviewId }, row, null, commentAuthors, { limit: REPLY_PREVIEW_SIZE }),
      ReviewComment.countDocuments({ parentCommentId: row._id, status: "visible" }),
    ]);
    thread = { replyCount, replies: page.replies, repliesCursor: page.nextCursor };
  }
  return serializeComment(row, { authors, parentPublicId: parent?.commentId || null, thread });
}

router.get("/review/:reviewId/comments", async (req, res) => {
  try {
    const review = await findReview(req.params.reviewId);
    const viewerId = viewer(req);
    const focusId = req.query?.focus ? assertCommentId(req.query.focus) : null;
    const [thread, counts, profile, focusedThread] = await Promise.all([
      readThread(review, req.query?.cursor, commentAuthors),
      commentCounts([review._id]),
      viewerId ? UserProfile.findOne({ userId: viewerId }, { isPrivate: 1 }).lean() : null,
      focusId ? readFocusedThread(review, focusId, commentAuthors) : null,
    ]);
    res.json({
      ...thread,
      ...(focusId ? { focusedThread } : {}),
      commentCount: counts.get(String(review._id)) || 0,
      commentsEnabled: isReviewCommentsEnabled(),
      // Lets the composer say that comments, and the commenter's name, are public.
      ...(viewerId ? { viewer: { profileIsPrivate: Boolean(profile?.isPrivate) } } : {}),
    });
  } catch (error) { sendError(res, error, "Failed to fetch comments"); }
});

router.get("/review/:reviewId/comments/:commentId/replies", async (req, res) => {
  try {
    const review = await findReview(req.params.reviewId);
    const commentId = assertCommentId(req.params.commentId);
    const parent = await ReviewComment.findOne({ commentId, reviewId: review._id, parentCommentId: null }).lean();
    if (!parent) throw notFound();
    res.json(await readReplies(review, parent, req.query?.cursor, commentAuthors));
  } catch (error) { sendError(res, error, "Failed to fetch replies"); }
});

router.post("/review/:reviewId/comments", auth, commentsEnabled, commentCreateRateLimit, async (req, res) => {
  try {
    const input = parseCreateBody(req.body);
    const key = creationKey(req.get?.("Idempotency-Key"));
    const review = await findReview(req.params.reviewId);
    const { reviewId } = review;
    const { comment, created } = await createComment({ reviewId, userId: req.userId, creationKey: key, ...input });
    const [serialized, counts, threadReplyCount] = await Promise.all([
      serializeOne(comment, { newThread: true }),
      commentCounts([review._id]),
      comment.parentCommentId ? ReviewComment.countDocuments({ parentCommentId: comment.parentCommentId, status: "visible" }) : null,
    ]);
    res.status(created ? 201 : 200).json({
      ...serialized,
      commentCount: counts.get(String(review._id)) || 0,
      ...(threadReplyCount === null ? {} : { threadReplyCount }),
    });
  } catch (error) { sendError(res, error, "Failed to post comment"); }
});

router.patch("/comments/:commentId", auth, commentsEnabled, commentMutationRateLimit, async (req, res) => {
  try {
    const commentId = assertCommentId(req.params.commentId);
    const { body } = parseEditBody(req.body);
    const comment = await editComment({ commentId, userId: req.userId, body });
    res.json(await serializeOne(comment));
  } catch (error) { sendError(res, error, "Failed to update comment"); }
});

router.delete("/comments/:commentId", auth, commentsEnabled, commentMutationRateLimit, async (req, res) => {
  try {
    const commentId = assertCommentId(req.params.commentId);
    const { status } = await deleteComment({ commentId, userId: req.userId });
    res.json({ commentId, status });
  } catch (error) { sendError(res, error, "Failed to delete comment"); }
});

router.post("/comments/:commentId/report", auth, commentsEnabled, commentReportRateLimit, async (req, res) => {
  try {
    const commentId = assertCommentId(req.params.commentId);
    const input = parseReportBody(req.body);
    const { report, created } = await reportComment({ commentId, reporterUserId: req.userId, ...input });
    res.status(created ? 201 : 200).json({ reportId: report.reportId, commentId, reason: report.reason });
  } catch (error) { sendError(res, error, "Failed to report comment"); }
});

module.exports = router;
