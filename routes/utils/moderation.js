const mongoose = require("mongoose");
const { isTransactionUnavailable } = require("./transactions");

const SUBMISSION_STATUSES = new Set([
  "pending",
  "needs_changes",
  "approved",
  "rejected",
  "duplicate",
  "withdrawn",
]);
const SUBMISSION_TYPES = new Set(["new_album", "catalog_correction", "genre_suggestion"]);
const CORRECTION_FIELDS = new Set(["title", "artists", "releaseType", "releaseDate", "label", "cover", "tracks", "externalReferences"]);
const MODERATOR_DEFAULT_PAGE_LIMIT = 20;
const MODERATOR_MAX_PAGE_LIMIT = 50;
const PUBLIC_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class ModerationValidationError extends Error {
  constructor(message, code = "INVALID_MODERATION_REQUEST", details = []) {
    super(message);
    this.name = "ModerationValidationError";
    this.status = 400;
    this.code = code;
    this.details = details.length ? details : [message];
  }
}

class ModerationConflictError extends Error {
  constructor(message, code = "STATE_CONFLICT", details = []) {
    super(message);
    this.name = "ModerationConflictError";
    this.status = 409;
    this.code = code;
    this.details = details;
  }
}

class ApprovalUnavailableError extends Error {
  constructor(message = "Approval is unavailable until MongoDB transactions are enabled") {
    super(message);
    this.name = "ApprovalUnavailableError";
    this.status = 503;
    this.code = "APPROVAL_UNAVAILABLE";
  }
}

function fail(message, code = "INVALID_MODERATION_REQUEST") {
  throw new ModerationValidationError(message, code);
}

function assertRecord(value, path = "request body") {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${path} must be an object`);
}

function assertKeys(value, allowed, path = "request body") {
  Object.keys(value).forEach((key) => {
    if (!allowed.has(key)) fail(`${path}.${key} is not allowed`);
  });
}

function requiredReason(value) {
  if (typeof value !== "string" || !value.trim()) fail("reason is required");
  const reason = value.trim();
  if (reason.length > 1000) fail("reason must be 1000 characters or fewer");
  return reason;
}

function optionalReason(value) {
  if (value === undefined) return "";
  if (typeof value !== "string") fail("reason must be a string");
  const reason = value.trim();
  if (reason.length > 1000) fail("reason must be 1000 characters or fewer");
  return reason;
}

// The duplicate target already explains the decision, so the note is optional.
const DEFAULT_DUPLICATE_REASON = "Duplicate of an approved suggestion.";

function publicUuid(value, path) {
  if (typeof value !== "string" || !PUBLIC_UUID_V4.test(value.trim())) {
    fail(`${path} must be a UUID v4`);
  }
  return value.trim().toLowerCase();
}

function normalizeCommandBody(body, action) {
  assertRecord(body || {});
  if (action === "request_changes" || action === "reject") {
    assertKeys(body, new Set(["reason"]));
    return { reason: requiredReason(body.reason) };
  }
  if (action === "mark_duplicate") {
    assertKeys(body, new Set(["duplicateOfSubmissionId", "reason"]));
    return {
      duplicateOfSubmissionId: publicUuid(body.duplicateOfSubmissionId, "duplicateOfSubmissionId"),
      reason: optionalReason(body.reason) || DEFAULT_DUPLICATE_REASON,
    };
  }
  if (action === "approve") {
    assertKeys(body, new Set(["albumId", "confirmPossibleDuplicate", "reason", "applyFields"]));
    if (body.albumId !== undefined && body.albumId !== null && body.albumId !== "") {
      body.albumId = publicUuid(body.albumId, "albumId");
    }
    if (body.confirmPossibleDuplicate !== undefined && typeof body.confirmPossibleDuplicate !== "boolean") {
      fail("confirmPossibleDuplicate must be a boolean");
    }
    if (body.applyFields !== undefined) {
      if (!Array.isArray(body.applyFields) || body.applyFields.length < 1) fail("applyFields must contain at least one field group");
      const fields = [...new Set(body.applyFields)];
      if (fields.length !== body.applyFields.length || fields.some((field) => typeof field !== "string" || !CORRECTION_FIELDS.has(field))) {
        fail("applyFields contains an invalid or duplicate field group");
      }
      body.applyFields = fields;
    }
    return {
      albumId: body.albumId || "",
      confirmPossibleDuplicate: body.confirmPossibleDuplicate === true,
      confirmPossibleDuplicateProvided: Object.prototype.hasOwnProperty.call(body, "confirmPossibleDuplicate"),
      applyFields: body.applyFields,
      reason: optionalReason(body.reason),
    };
  }
  fail("moderation action is invalid");
}

function parseStatusFilter(value) {
  if (value === undefined || value === null || value === "") return ["pending"];
  if (typeof value !== "string") fail("status must be a comma-separated list");
  const statuses = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  if (!statuses.length || statuses.some((status) => !SUBMISSION_STATUSES.has(status))) {
    fail("status contains an invalid submission state");
  }
  return statuses;
}

function parseSubmissionTypeFilter(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !SUBMISSION_TYPES.has(value.trim())) {
    fail("submissionType must be new_album, catalog_correction, or genre_suggestion");
  }
  return value.trim();
}

function parseBooleanFilter(value, path) {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === true || value === false) return value;
  if (value === "true") return true;
  if (value === "false") return false;
  fail(`${path} must be true or false`);
}

function parseModeratorLimit(value) {
  if (value === undefined || value === null || value === "") return MODERATOR_DEFAULT_PAGE_LIMIT;
  if (!/^\d+$/.test(String(value))) fail("limit must be a positive integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MODERATOR_MAX_PAGE_LIMIT) {
    fail(`limit must be between 1 and ${MODERATOR_MAX_PAGE_LIMIT}`);
  }
  return parsed;
}

function encodeModerationCursor(updatedAt, id) {
  return Buffer.from(JSON.stringify({
    updatedAt: new Date(updatedAt).toISOString(),
    id: String(id),
  })).toString("base64url");
}

function decodeModerationCursor(cursor) {
  if (!cursor || typeof cursor !== "string") return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const updatedAt = new Date(decoded.updatedAt);
    if (!decoded.id || !mongoose.isValidObjectId(decoded.id) || Number.isNaN(updatedAt.getTime())) throw new Error("invalid");
    return { updatedAt, id: decoded.id };
  } catch {
    throw new ModerationValidationError("cursor is invalid", "INVALID_CURSOR");
  }
}

function moderationCursorFilter(cursor) {
  if (!cursor) return {};
  return {
    $or: [
      { updatedAt: { $gt: cursor.updatedAt } },
      { updatedAt: cursor.updatedAt, _id: { $gt: cursor.id } },
    ],
  };
}

module.exports = {
  ApprovalUnavailableError,
  ModerationConflictError,
  ModerationValidationError,
  MODERATOR_DEFAULT_PAGE_LIMIT,
  MODERATOR_MAX_PAGE_LIMIT,
  SUBMISSION_STATUSES,
  SUBMISSION_TYPES,
  parseSubmissionTypeFilter,
  decodeModerationCursor,
  encodeModerationCursor,
  isTransactionUnavailable,
  moderationCursorFilter,
  normalizeCommandBody,
  parseBooleanFilter,
  parseModeratorLimit,
  parseStatusFilter,
  publicUuid,
};
