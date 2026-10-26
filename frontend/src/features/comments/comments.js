import { API_BASE_URL } from "../../config/api";
import { getApiErrorMessage } from "../../utils/apiErrors";

export const MAX_COMMENT_LENGTH = 500;
export const REPORT_REASONS = [
  { value: "spam", label: "Spam" },
  { value: "harassment", label: "Harassment" },
  { value: "off_topic", label: "Off topic" },
  { value: "other", label: "Something else" },
];

const DRAFT_PREFIX = "rescened:comment-draft:v1:";

// One draft per review for the main composer, and one per thread for replies.
export function commentDraftKey(userId, reviewId, parentCommentId = "") {
  return userId && reviewId ? `${DRAFT_PREFIX}${userId}:${reviewId}${parentCommentId ? `:${parentCommentId}` : ""}` : "";
}

// Comment text is plain: only https URLs become links. Trailing punctuation
// stays text, so "see https://x.test." links without the period.
const URL_PATTERN = /https:\/\/[^\s<>"]+/g;
const TRAILING = /[.,;:!?)\]}'"]+$/;

export function linkSegments(text) {
  const segments = [];
  let index = 0;
  for (const match of String(text || "").matchAll(URL_PATTERN)) {
    const trailing = match[0].match(TRAILING)?.[0] || "";
    const href = trailing ? match[0].slice(0, -trailing.length) : match[0];
    if (href.length <= "https://".length) continue;
    if (match.index > index) segments.push({ type: "text", value: text.slice(index, match.index) });
    segments.push({ type: "link", value: href, href });
    index = match.index + href.length;
  }
  if (index < String(text || "").length) segments.push({ type: "text", value: text.slice(index) });
  return segments;
}

// Comments posted on this page are marked isLocal. They are the newest, so
// they stay last when older pages load in after them.
function mergeById(current, incoming) {
  const local = current.filter((item) => item.isLocal);
  const localIds = new Set(local.map((item) => item.commentId));
  const loaded = current.filter((item) => !item.isLocal);
  const seen = new Set(loaded.map((item) => item.commentId));
  return [...loaded, ...incoming.filter((item) => !seen.has(item.commentId) && !localIds.has(item.commentId)), ...local];
}

function mapThreads(thread, fn) {
  return { ...thread, comments: thread.comments.map(fn) };
}

export function appendThreadPage(thread, page) {
  return {
    ...thread,
    comments: mergeById(thread.comments, page.comments || []),
    nextCursor: page.nextCursor || null,
  };
}

export function appendReplies(thread, parentId, page) {
  return mapThreads(thread, (comment) => (comment.commentId === parentId
    ? { ...comment, replies: mergeById(comment.replies || [], page.replies || []), repliesCursor: page.nextCursor || null }
    : comment));
}

// A new comment goes at the end even when older ones are not loaded yet; it
// stays last as they load, since pages merge by commentId around it.
export function addComment(thread, response) {
  const { commentCount, threadReplyCount, ...created } = response;
  const comment = { ...created, isLocal: true };
  const exists = thread.comments.some((item) => item.commentId === comment.commentId
    || (item.replies || []).some((reply) => reply.commentId === comment.commentId));
  // Older API instances may omit totals during a rolling deployment.
  const counted = { ...thread, commentCount: Number.isInteger(commentCount)
    ? commentCount : (Number(thread.commentCount) || 0) + (exists ? 0 : 1) };
  if (!comment.parentCommentId) {
    if (thread.comments.some((item) => item.commentId === comment.commentId)) return counted;
    return { ...counted, comments: [...thread.comments, { replies: [], replyCount: 0, repliesCursor: null, ...comment }] };
  }
  return mapThreads(counted, (item) => {
    if (item.commentId !== comment.parentCommentId) return item;
    const replies = item.replies || [];
    return {
      ...item,
      replies: replies.some((reply) => reply.commentId === comment.commentId) ? replies : [...replies, comment],
      replyCount: Number.isInteger(threadReplyCount) ? threadReplyCount : (Number(item.replyCount) || 0) + (exists ? 0 : 1),
    };
  });
}

export function hasReplyContent(comment, replyingThreadId) {
  return Boolean(comment.replies?.length || comment.repliesCursor || replyingThreadId === comment.commentId);
}

export function updateComment(thread, comment) {
  const merge = (item) => (item.commentId === comment.commentId ? { ...item, ...comment } : item);
  return mapThreads(thread, (item) => ({ ...merge(item), replies: (item.replies || []).map(merge) }));
}

// status is what DELETE returned: "deleted" drops the comment, while
// "deleted_by_author" keeps a tombstone holding its replies.
export function removeComment(thread, commentId, status) {
  const counted = { ...thread, commentCount: Math.max(0, (Number(thread.commentCount) || 0) - 1) };
  const tombstone = ({ commentId: id, createdAt, replyCount, replies, repliesCursor }) => (
    { commentId: id, status: "deleted_by_author", createdAt, replyCount, replies, repliesCursor }
  );
  const comments = [];
  for (const item of thread.comments) {
    if (item.commentId === commentId) {
      if (status === "deleted_by_author") comments.push(tombstone(item));
      continue;
    }
    const replies = (item.replies || []).filter((reply) => reply.commentId !== commentId);
    if (replies.length === (item.replies || []).length) {
      comments.push(item);
      continue;
    }
    const replyCount = Math.max(0, (Number(item.replyCount) || 0) - 1);
    // A tombstone whose last reply is gone disappears, as it does on the server.
    if (item.status !== "visible" && replyCount === 0) continue;
    comments.push({ ...item, replies, replyCount });
  }
  return { ...counted, comments };
}

async function failure(response, fallback) {
  const data = await response.clone().json().catch(() => ({}));
  const error = new Error(await getApiErrorMessage(response, fallback));
  error.status = response.status;
  error.code = data.code || "";
  return error;
}

async function request(path, { token, method = "GET", body, idempotencyKey, signal, fallback }) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const response = await fetch(`${API_BASE_URL}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal });
  if (!response.ok) throw await failure(response, fallback);
  return response.json();
}

const reviewPath = (reviewId) => `/reviews/review/${encodeURIComponent(reviewId)}/comments`;
const commentPath = (commentId) => `/reviews/comments/${encodeURIComponent(commentId)}`;

export function fetchThread(reviewId, { token, cursor, signal } = {}) {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return request(`${reviewPath(reviewId)}${query}`, { token, signal, fallback: "Comments are unavailable right now." });
}

export function fetchReplies(reviewId, commentId, cursor) {
  return request(`${reviewPath(reviewId)}/${encodeURIComponent(commentId)}/replies?cursor=${encodeURIComponent(cursor)}`, { fallback: "Could not load more replies." });
}

export function postComment(token, reviewId, { body, parentCommentId }, idempotencyKey) {
  return request(reviewPath(reviewId), {
    token,
    method: "POST",
    body: parentCommentId ? { body, parentCommentId } : { body },
    idempotencyKey,
    fallback: "Could not post your comment.",
  });
}

export function editComment(token, commentId, body) {
  return request(commentPath(commentId), { token, method: "PATCH", body: { body }, fallback: "Could not save your edit." });
}

export function deleteComment(token, commentId) {
  return request(commentPath(commentId), { token, method: "DELETE", fallback: "Could not delete your comment." });
}

export function reportComment(token, commentId, { reason, note }) {
  return request(`${commentPath(commentId)}/report`, {
    token,
    method: "POST",
    body: note ? { reason, note } : { reason },
    fallback: "Could not send your report.",
  });
}
