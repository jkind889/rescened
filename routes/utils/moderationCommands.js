const mongoose = require("mongoose");
const AlbumSubmission = require("../../models/AlbumSubmission");
const {
  ModerationConflictError,
  ModerationValidationError,
  isTransactionUnavailable,
} = require("./moderation");
const { recordSuggestionStatus } = require("./notifications");

const NEXT_STATUS = { request_changes: "needs_changes", reject: "rejected", mark_duplicate: "duplicate" };
const HISTORY_ACTION = { request_changes: "request_changes", reject: "rejected", mark_duplicate: "marked_duplicate" };

class ModerationUnavailableError extends Error {
  constructor() {
    super("Moderation is unavailable until MongoDB transactions are enabled");
    this.name = "ModerationUnavailableError";
    this.status = 503;
    this.code = "MODERATION_UNAVAILABLE";
  }
}

function withSession(query, session) {
  return query && typeof query.session === "function" ? query.session(session) : query;
}

// Request changes, reject, and mark duplicate. The status change, its audit
// event, and the contributor's notification commit together or not at all.
// Standalone MongoDB returns 503 rather than writing without the notification.
async function applyModerationCommand({ submissionId, actorUserId, action, body }) {
  if (!NEXT_STATUS[action]) throw new ModerationValidationError("moderation action is invalid");
  let session;
  let updated = null;
  // withTransaction may retry against a newer snapshot. Keep the command tied
  // to the revision it first observed, like the approval path does.
  let expectedRevision;
  try {
    if (typeof mongoose.startSession !== "function") throw new ModerationUnavailableError();
    session = await mongoose.startSession();
    if (!session || typeof session.withTransaction !== "function") throw new ModerationUnavailableError();
    await session.withTransaction(async () => {
      updated = null;
      const current = await withSession(AlbumSubmission.findOne({ submissionId }), session);
      if (!current) throw new ModerationConflictError("Suggestion not found", "SUGGESTION_NOT_FOUND");
      if (expectedRevision === undefined) expectedRevision = current.currentRevision;
      if (current.currentRevision !== expectedRevision) {
        throw new ModerationConflictError("Suggestion changed while it was being moderated", "STATE_CONFLICT");
      }
      if (current.status !== "pending") {
        throw new ModerationConflictError("Only pending suggestions can be moderated", "INVALID_SUBMISSION_STATE");
      }
      if (action === "mark_duplicate" && current.submissionType === "genre_suggestion") {
        throw new ModerationValidationError("Genre suggestions cannot be marked as duplicates; reject them instead");
      }

      const set = { status: NEXT_STATUS[action], approvedAlbumCatalogId: null, duplicateOfSubmissionId: null };
      if (action === "mark_duplicate") {
        const target = await withSession(AlbumSubmission.findOne({ submissionId: body.duplicateOfSubmissionId }), session);
        if (!target || target.submissionId === current.submissionId || target.status !== "approved" || !target.approvedAlbumCatalogId) {
          throw new ModerationConflictError("duplicateOfSubmissionId must reference another approved suggestion", "INVALID_DUPLICATE_TARGET");
        }
        set.duplicateOfSubmissionId = target._id;
      }
      const next = await AlbumSubmission.findOneAndUpdate(
        { submissionId, status: "pending", currentRevision: expectedRevision },
        {
          $set: set,
          // Rejected and duplicate suggestions close; needs-changes stays open.
          ...(action === "request_changes" ? {} : { $unset: { openGenreSuggestionKey: "" } }),
          $push: {
            moderationHistory: { actorUserId, action: HISTORY_ACTION[action], reason: body.reason, createdAt: new Date() },
          },
        },
        { returnDocument: "after", runValidators: true, session },
      );
      if (!next) throw new ModerationConflictError("Suggestion changed while it was being moderated", "STATE_CONFLICT");
      await recordSuggestionStatus({ submission: next, status: NEXT_STATUS[action], actorUserId, session });
      updated = next;
    });
    return updated;
  } catch (error) {
    if (error instanceof ModerationUnavailableError) throw error;
    if (isTransactionUnavailable(error)) throw new ModerationUnavailableError();
    throw error;
  } finally {
    if (session && typeof session.endSession === "function") await session.endSession();
  }
}

module.exports = { ModerationUnavailableError, applyModerationCommand };
