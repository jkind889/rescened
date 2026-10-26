// Public comment reads. Threads follow review visibility: reviews are public,
// so their comments are too. Responses carry public IDs only.

const mongoose = require("mongoose");
const ReviewComment = require("../../models/ReviewComment");
const {
  REPLY_PAGE_SIZE,
  REPLY_PREVIEW_SIZE,
  THREAD_PAGE_SIZE,
  afterCursor,
  decodeCursor,
  encodeCursor,
} = require("./common");

const DEFAULT_AUTHOR = "rescened user";
const THREAD_ORDER = { createdAt: 1, commentId: 1 };

function idKey(value) { return String(value?._id || value || ""); }

// Visible comments and replies per review, keyed by the review's _id. Computed
// per page like like counts, so there is no stored counter to drift.
async function commentCounts(reviewIds) {
  const ids = [...new Set(reviewIds.map(idKey).filter((id) => mongoose.isValidObjectId(id)))];
  const counts = new Map(ids.map((id) => [id, 0]));
  if (!ids.length) return counts;
  const rows = await ReviewComment.aggregate([
    { $match: { reviewId: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) }, status: "visible" } },
    { $group: { _id: "$reviewId", count: { $sum: 1 } } },
  ]);
  rows.forEach((row) => counts.set(idKey(row._id), row.count));
  return counts;
}

function authorOf(map, userId) {
  return map.get(userId) || { userId, username: DEFAULT_AUTHOR, imageUrl: "" };
}

// Tombstones keep their place in a thread but carry no body and no author.
// thread is { replyCount, replies, repliesCursor } for top-level comments.
function serializeComment(row, { authors, parentPublicId = null, thread = null }) {
  const comment = { commentId: row.commentId, status: row.status, createdAt: row.createdAt };
  if (row.parentCommentId) comment.parentCommentId = parentPublicId;
  if (row.status === "visible") {
    const replyTo = row.replyToUserId ? authorOf(authors, row.replyToUserId) : null;
    Object.assign(comment, {
      body: row.body,
      author: authorOf(authors, row.userId),
      replyTo: replyTo ? { userId: replyTo.userId, username: replyTo.username } : null,
      editedAt: row.editedAt || null,
    });
  }
  return thread ? { ...comment, ...thread } : comment;
}

function visibleUserIds(rows) {
  return rows.flatMap((row) => (row.status === "visible" ? [row.userId, row.replyToUserId] : [])).filter(Boolean);
}

async function replyPreviews(reviewId, parentIds) {
  if (!parentIds.length) return { counts: new Map(), previews: new Map() };
  const countRows = await ReviewComment.aggregate([
    { $match: { reviewId, parentCommentId: { $in: parentIds }, status: "visible" } },
    { $group: { _id: "$parentCommentId", count: { $sum: 1 } } },
  ]);
  const counts = new Map(countRows.map((row) => [idKey(row._id), row.count]));
  const withReplies = parentIds.filter((id) => counts.get(idKey(id)));
  const pages = await Promise.all(withReplies.map((parentId) => ReviewComment.find({ reviewId, parentCommentId: parentId, status: "visible" })
    .sort(THREAD_ORDER)
    .limit(REPLY_PREVIEW_SIZE)
    .lean()));
  return { counts, previews: new Map(withReplies.map((id, index) => [idKey(id), pages[index]])) };
}

// Hidden rows are skipped while filling a page; this bounds how many extra
// reads one request may spend doing so.
const MAX_FILL_ROUNDS = 5;

// Top-level comments oldest first, each with its first replies. A tombstone
// without visible replies is hidden, and the page keeps reading past hidden
// rows (within MAX_FILL_ROUNDS) so it is not cut short by them.
async function readThread(review, cursorValue, getAuthors, { limit = THREAD_PAGE_SIZE } = {}) {
  let cursor = decodeCursor(cursorValue);
  const shown = [];
  let exhausted = false;
  for (let round = 0; round < MAX_FILL_ROUNDS && shown.length < limit && !exhausted; round += 1) {
    const wanted = limit - shown.length;
    const rows = await ReviewComment.find({ reviewId: review._id, parentCommentId: null, ...afterCursor(cursor) })
      .sort(THREAD_ORDER)
      .limit(wanted + 1)
      .lean();
    exhausted = rows.length <= wanted;
    const batch = rows.slice(0, wanted);
    if (!batch.length) break;
    const { counts, previews } = await replyPreviews(review._id, batch.map((row) => row._id));
    batch.forEach((row) => {
      const replyCount = counts.get(idKey(row)) || 0;
      if (row.status === "visible" || replyCount) shown.push({ row, replyCount, preview: previews.get(idKey(row)) || [] });
    });
    cursor = batch.at(-1);
  }
  const authors = await getAuthors(visibleUserIds(shown.flatMap(({ row, preview }) => [row, ...preview])));
  const comments = shown.map(({ row, replyCount, preview }) => serializeComment(row, {
    authors,
    thread: {
      replyCount,
      replies: preview.map((reply) => serializeComment(reply, { authors, parentPublicId: row.commentId })),
      repliesCursor: replyCount > preview.length && preview.length ? encodeCursor(preview.at(-1)) : null,
    },
  }));
  return { comments, nextCursor: exhausted || !cursor ? null : encodeCursor(cursor) };
}

async function readReplies(review, parent, cursorValue, getAuthors, { limit = REPLY_PAGE_SIZE } = {}) {
  const cursor = decodeCursor(cursorValue);
  const rows = await ReviewComment.find({ reviewId: review._id, parentCommentId: parent._id, status: "visible", ...afterCursor(cursor) })
    .sort(THREAD_ORDER)
    .limit(limit + 1)
    .lean();
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const authors = await getAuthors(visibleUserIds(page));
  return {
    replies: page.map((row) => serializeComment(row, { authors, parentPublicId: parent.commentId })),
    nextCursor: hasMore ? encodeCursor(page.at(-1)) : null,
  };
}

// A permalink may target a reply beyond the preview or a later thread page.
// Return bounded context alongside the normal first page, without advancing
// its cursors. Removed text is never serialized, even for a stale activity link.
async function readFocusedThread(review, commentId, getAuthors) {
  const target = await ReviewComment.findOne({ reviewId: review._id, commentId, status: "visible" }).lean();
  if (!target) return null;
  const root = target.parentCommentId
    ? await ReviewComment.findOne({ _id: target.parentCommentId, reviewId: review._id, parentCommentId: null }).lean()
    : target;
  if (!root) return null;
  const { counts, previews } = await replyPreviews(review._id, [root._id]);
  const preview = previews.get(idKey(root)) || [];
  const rows = target.parentCommentId && !preview.some((row) => row.commentId === target.commentId) ? [...preview, target] : preview;
  const authors = await getAuthors(visibleUserIds([root, ...rows]));
  const replyCount = counts.get(idKey(root)) || 0;
  const serialized = serializeComment(root, { authors, thread: {
    replyCount,
    replies: preview.map((row) => serializeComment(row, { authors, parentPublicId: root.commentId })),
    repliesCursor: replyCount > preview.length && preview.length ? encodeCursor(preview.at(-1)) : null,
  } });
  return { ...serialized, focusedReply: rows.length > preview.length
    ? serializeComment(target, { authors, parentPublicId: root.commentId }) : null };
}

module.exports = { readFocusedThread, commentCounts, readReplies, readThread, serializeComment };
