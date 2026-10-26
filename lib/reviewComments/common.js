// Shared rules for review comments: the feature flag, request parsing, body
// normalization, public-ID cursors, errors, and the transaction runner.
// Nothing here reads the database except runCommentTransaction's session.

const mongoose = require("mongoose");
const ReviewComment = require("../../models/ReviewComment");
const CommentReport = require("../../models/CommentReport");
const { isTransactionUnavailable } = require("../../routes/utils/transactions");

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const { MAX_COMMENT_LENGTH } = ReviewComment;
const { REPORT_REASONS, MAX_REPORT_NOTE_LENGTH } = CommentReport;
const MAX_MODERATION_REASON_LENGTH = 1000;
const THREAD_PAGE_SIZE = 20;
const REPLY_PAGE_SIZE = 20;
const REPLY_PREVIEW_SIZE = 3;
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const EXCERPT_LENGTH = 140;

class CommentError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "CommentError";
    this.status = status;
    this.code = code;
  }
}

const invalid = (message, code = "INVALID_COMMENT_REQUEST") => new CommentError(400, code, message);
const notFound = (message = "Comment not found") => new CommentError(404, "COMMENT_NOT_FOUND", message);
const reviewNotFound = () => new CommentError(404, "REVIEW_NOT_FOUND", "Review not found");
const forbidden = (message) => new CommentError(403, "COMMENT_FORBIDDEN", message);
const conflict = (message) => new CommentError(409, "COMMENT_STATE_CONFLICT", message);

function isReviewCommentsEnabled(env = process.env) {
  return String(env.REVIEW_COMMENTS_ENABLED || "").trim().toLowerCase() === "true";
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Rejects unknown fields, which covers client-owned ones such as commentId,
// userId, status, and replyToUserId.
function assertKeys(body, allowed) {
  if (!isRecord(body)) throw invalid("Request body must be an object");
  for (const key of Object.keys(body)) if (!allowed.includes(key)) throw invalid(`${key} is not allowed`);
}

// Bidirectional overrides and zero-width spaces can disguise text, so they are
// dropped along with other control characters. Newlines survive, and so do the
// zero-width joiners that emoji sequences and several scripts depend on.
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B\u202A-\u202E\u2060-\u2069\uFEFF]/g;

// Plain text only: horizontal whitespace runs become one space, lines are
// trimmed, and runs of blank lines collapse to one.
function normalizeBody(value) {
  if (typeof value !== "string") throw invalid("body must be text");
  const body = value
    .replace(/\r\n?/g, "\n")
    .replace(INVISIBLE, "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!body) throw invalid("Write something before posting");
  if (body.length > MAX_COMMENT_LENGTH) throw invalid(`Comments must be ${MAX_COMMENT_LENGTH} characters or fewer`);
  return body;
}

function assertCommentId(value, path = "commentId") {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!UUID_V4.test(id)) throw invalid(`${path} must be a UUID v4`, "INVALID_COMMENT_ID");
  return id;
}

function parseCreateBody(body) {
  assertKeys(body, ["body", "parentCommentId"]);
  const parent = body.parentCommentId;
  return {
    body: normalizeBody(body.body),
    parentCommentId: parent === undefined || parent === null ? null : assertCommentId(parent, "parentCommentId"),
  };
}

function parseEditBody(body) {
  assertKeys(body, ["body"]);
  return { body: normalizeBody(body.body) };
}

function parseReportBody(body) {
  assertKeys(body, ["reason", "note"]);
  if (!REPORT_REASONS.includes(body.reason)) throw invalid(`reason must be one of ${REPORT_REASONS.join(", ")}`);
  let note = "";
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== "string") throw invalid("note must be text");
    note = body.note.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
    if (note.length > MAX_REPORT_NOTE_LENGTH) throw invalid(`note must be ${MAX_REPORT_NOTE_LENGTH} characters or fewer`);
  }
  return { reason: body.reason, note };
}

function parseModerationBody(body) {
  assertKeys(body || {}, ["reason"]);
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (!reason) throw invalid("reason is required");
  if (reason.length > MAX_MODERATION_REASON_LENGTH) throw invalid(`reason must be ${MAX_MODERATION_REASON_LENGTH} characters or fewer`);
  return { reason };
}

function creationKey(value) {
  const key = String(value || "").trim();
  if (!UUID_V4.test(key)) throw invalid("Idempotency-Key must be a UUID v4", "INVALID_IDEMPOTENCY_KEY");
  return key.toLowerCase();
}

// Cursors carry the last row's timestamp and public commentId, never _id.
function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ createdAt: new Date(row.createdAt).toISOString(), commentId: row.commentId })).toString("base64url");
}

function decodeCursor(value) {
  if (value === undefined || value === null || value === "") return null;
  try {
    if (typeof value !== "string") throw new Error("invalid");
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const createdAt = new Date(decoded?.createdAt);
    const commentId = String(decoded?.commentId || "").toLowerCase();
    if (Number.isNaN(createdAt.getTime()) || !UUID_V4.test(commentId)) throw new Error("invalid");
    return { createdAt, commentId };
  } catch {
    throw invalid("Comment cursor is invalid", "INVALID_COMMENT_CURSOR");
  }
}

function afterCursor(cursor) {
  if (!cursor) return {};
  return { $or: [
    { createdAt: { $gt: cursor.createdAt } },
    { createdAt: cursor.createdAt, commentId: { $gt: cursor.commentId } },
  ] };
}

// Counts code points, so an emoji is never cut in half.
function excerpt(body) {
  const characters = Array.from(String(body || "").replace(/\s+/g, " ").trim());
  return characters.length > EXCERPT_LENGTH ? `${characters.slice(0, EXCERPT_LENGTH - 1).join("").trimEnd()}…` : characters.join("");
}

// Every comment write commits atomically. Standalone MongoDB cannot, so it
// returns 503 instead of writing without its notifications or cascades.
async function runCommentTransaction(callback) {
  const unavailable = () => new CommentError(503, "COMMENT_WRITE_UNAVAILABLE", "Comments are unavailable until MongoDB transactions are enabled");
  let session;
  try {
    if (typeof mongoose.startSession !== "function") throw unavailable();
    session = await mongoose.startSession();
    if (!session || typeof session.withTransaction !== "function") throw unavailable();
    let result;
    await session.withTransaction(async () => { result = await callback(session); });
    return result;
  } catch (error) {
    if (error instanceof CommentError) throw error;
    if (isTransactionUnavailable(error)) throw unavailable();
    throw error;
  } finally {
    if (session && typeof session.endSession === "function") await session.endSession();
  }
}

module.exports = {
  CommentError,
  DUPLICATE_WINDOW_MS,
  MAX_MODERATION_REASON_LENGTH,
  REPLY_PAGE_SIZE,
  REPLY_PREVIEW_SIZE,
  THREAD_PAGE_SIZE,
  afterCursor,
  assertCommentId,
  conflict,
  creationKey,
  decodeCursor,
  encodeCursor,
  excerpt,
  forbidden,
  invalid,
  isReviewCommentsEnabled,
  normalizeBody,
  notFound,
  parseCreateBody,
  parseEditBody,
  parseModerationBody,
  parseReportBody,
  reviewNotFound,
  runCommentTransaction,
};
