const crypto = require("node:crypto");
const mongoose = require("mongoose");
const { ARTIST_ID_PATTERN } = require("../lib/artists/identity");
const { artistProposalSchema } = require("./schemas/artistProposal");

// Standalone artist suggestion: one proposed artist (a MusicBrainz artist
// with a server observation, or a community artist with private evidence),
// reviewed on its own. Approval creates or reuses one registry artist.
// Revisions and moderation history are append-only, like AlbumSubmission.

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUSES = ["pending", "needs_changes", "approved", "rejected", "duplicate", "withdrawn"];
const ACTIONS = ["submitted", "revised", "withdrawn", "request_changes", "approved", "rejected", "marked_duplicate"];

const revisionSchema = new mongoose.Schema(
  {
    revision: { type: Number, required: true, min: 1 },
    submittedAt: { type: Date, required: true },
    proposal: { type: artistProposalSchema, required: true },
    note: { type: String, default: "", maxlength: 500 },
  },
  { _id: false, strict: "throw" },
);

const eventSchema = new mongoose.Schema(
  {
    actorUserId: { type: String, required: true, trim: true, maxlength: 128 },
    action: { type: String, enum: ACTIONS, required: true },
    reason: { type: String, default: "", trim: true, maxlength: 1000 },
    revision: { type: Number, required: true, min: 1 },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false, strict: "throw" },
);

const receiptSchema = new mongoose.Schema(
  {
    revision: { type: Number, required: true, min: 1 },
    artistId: { type: String, required: true, lowercase: true, match: ARTIST_ID_PATTERN },
    outcome: { type: String, enum: ["created", "reused"], required: true },
    approvedAt: { type: Date, required: true },
  },
  { _id: false, strict: "throw" },
);

const artistSubmissionSchema = new mongoose.Schema(
  {
    submissionId: { type: String, required: true, unique: true, immutable: true, lowercase: true, default: () => crypto.randomUUID(), match: UUID_V4 },
    submittedByUserId: { type: String, required: true, trim: true, maxlength: 128, immutable: true },
    status: { type: String, enum: STATUSES, default: "pending", required: true },
    currentRevision: { type: Number, required: true, min: 1, default: 1 },
    // The current revision's proposal and note (also kept on each revision).
    proposal: { type: artistProposalSchema, required: true },
    note: { type: String, default: "", maxlength: 500 },
    revisions: { type: [revisionSchema], default: [] },
    moderationHistory: { type: [eventSchema], default: [] },
    approvedArtistId: { type: String, default: null, lowercase: true, match: ARTIST_ID_PATTERN },
    duplicateOfArtistId: { type: String, default: null, lowercase: true, match: ARTIST_ID_PATTERN },
    approvedAt: { type: Date, default: null },
    approvalReceipt: { type: receiptSchema, default: undefined },
    creationRequestKey: { type: String, default: undefined, immutable: true, lowercase: true, match: UUID_V4 },
    creationPayloadDigest: { type: String, default: undefined, immutable: true, match: /^[0-9a-f]{64}$/ },
  },
  { timestamps: true, strict: "throw" },
);

artistSubmissionSchema.pre("validate", function validateInvariants() {
  if (this.status === "approved" && (!this.approvedArtistId || !this.approvedAt || !this.approvalReceipt)) {
    this.invalidate("approvedArtistId", "Approved artist suggestions record the artist, time, and receipt.");
  }
  if (this.status !== "approved" && (this.approvedArtistId || this.approvalReceipt)) {
    this.invalidate("approvedArtistId", "Only approved artist suggestions name an approved artist.");
  }
  if (this.status === "duplicate" && !this.duplicateOfArtistId) {
    this.invalidate("duplicateOfArtistId", "Duplicate artist suggestions name the existing artist.");
  }
  if (this.status !== "duplicate" && this.duplicateOfArtistId) {
    this.invalidate("duplicateOfArtistId", "Only duplicate artist suggestions name a duplicate target.");
  }
  if (Boolean(this.creationRequestKey) !== Boolean(this.creationPayloadDigest)) {
    this.invalidate("creationRequestKey", "A creation request key and its payload digest are stored together.");
  }
  if (this.revisions.length && this.currentRevision !== this.revisions.length) {
    this.invalidate("currentRevision", "Current revision must match the number of stored revisions.");
  }
});

function invariantError(path, message) {
  const error = new mongoose.Error.ValidationError();
  error.addError(path, new mongoose.Error.ValidatorError({ path, message }));
  return error;
}

artistSubmissionSchema.pre(["findOneAndUpdate", "updateOne", "updateMany"], function validateUpdate() {
  const update = this.getUpdate() || {};
  const set = update.$set || {};
  for (const field of ["revisions", "moderationHistory"]) {
    if (set[field] !== undefined || update[field] !== undefined || update.$unset?.[field] !== undefined || update.$pull?.[field] !== undefined
      || update.$pullAll?.[field] !== undefined || update.$pop?.[field] !== undefined) {
      throw invariantError(field, `${field} are append-only and cannot be replaced or removed.`);
    }
    const push = update.$push?.[field];
    if (push && typeof push === "object" && (push.$position !== undefined || push.$slice !== undefined)) {
      throw invariantError(field, `${field} may only be appended.`);
    }
  }
  if (set.status === "approved" && (!set.approvedArtistId || !set.approvedAt || !set.approvalReceipt)) {
    throw invariantError("approvedArtistId", "Approved artist suggestions record the artist, time, and receipt.");
  }
  if (set.status === "duplicate" && !set.duplicateOfArtistId) {
    throw invariantError("duplicateOfArtistId", "Duplicate artist suggestions name the existing artist.");
  }
  if (set.approvalReceipt !== undefined && set.status !== "approved") {
    throw invariantError("approvalReceipt", "A receipt is written only with the approval itself.");
  }
  if (update.$unset?.approvalReceipt !== undefined) throw invariantError("approvalReceipt", "A receipt cannot be removed.");
});

artistSubmissionSchema.index({ submittedByUserId: 1, createdAt: -1, _id: -1 });
artistSubmissionSchema.index({ status: 1, updatedAt: 1, _id: 1 });
artistSubmissionSchema.index(
  { submittedByUserId: 1, creationRequestKey: 1 },
  { unique: true, partialFilterExpression: { creationRequestKey: { $type: "string" } } },
);

module.exports = mongoose.models.ArtistSubmission || mongoose.model("ArtistSubmission", artistSubmissionSchema);
module.exports.ARTIST_SUBMISSION_STATUSES = STATUSES;
