const crypto = require("node:crypto");
const mongoose = require("mongoose");

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPORT_REASONS = ["spam", "harassment", "off_topic", "other"];
const REPORT_STATUSES = ["open", "dismissed", "actioned"];
const MAX_REPORT_NOTE_LENGTH = 300;

const commentReportSchema = new mongoose.Schema({
  reportId: {
    type: String,
    required: true,
    unique: true,
    immutable: true,
    lowercase: true,
    default: function defaultReportId() { return this.isNew ? crypto.randomUUID() : undefined; },
    match: UUID_V4,
  },
  commentId: { type: mongoose.Schema.Types.ObjectId, ref: "ReviewComment", required: true, immutable: true },
  reporterUserId: { type: String, required: true, immutable: true },
  reason: { type: String, enum: REPORT_REASONS, required: true },
  note: { type: String, default: "", maxlength: MAX_REPORT_NOTE_LENGTH },
  status: { type: String, enum: REPORT_STATUSES, default: "open", required: true },
  createdAt: { type: Date, default: Date.now, immutable: true },
  resolvedAt: { type: Date, default: null },
});

// One report per reporter per comment, so a retried report changes nothing.
commentReportSchema.index({ commentId: 1, reporterUserId: 1 }, { unique: true });
// The moderator queue reads open reports.
commentReportSchema.index({ status: 1, createdAt: 1 }, { partialFilterExpression: { status: "open" } });
// Account deletion removes the reports a user filed.
commentReportSchema.index({ reporterUserId: 1 });

const CommentReport = mongoose.model("CommentReport", commentReportSchema);
CommentReport.REPORT_REASONS = REPORT_REASONS;
CommentReport.REPORT_STATUSES = REPORT_STATUSES;
CommentReport.MAX_REPORT_NOTE_LENGTH = MAX_REPORT_NOTE_LENGTH;

module.exports = CommentReport;
