const crypto = require("node:crypto");
const mongoose = require("mongoose");

const uuid = {
  type: String,
  required: true,
  unique: true,
  immutable: true,
  default: () => crypto.randomUUID(),
  match: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
};
const mbid = { type: String, required: true, lowercase: true, match: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu };

const trackSchema = new mongoose.Schema({
  trackId: { type: String, required: true, default: () => crypto.randomUUID(), match: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu },
  discNumber: { type: Number, required: true, min: 1, max: 999 },
  trackNumber: { type: Number, required: true, min: 1, max: 999 },
  title: { type: String, required: true, trim: true, maxlength: 500 },
  durationMs: { type: Number, default: 0, min: 0, max: 86400000 },
  artistDisplayName: { type: String, default: "", trim: true, maxlength: 500 },
  releaseTrackMbid: mbid,
  recordingMbid: mbid,
}, { _id: false, strict: "throw" });

const candidateSchema = new mongoose.Schema({
  releaseMbid: mbid,
  releaseGroupMbid: mbid,
  title: { type: String, required: true, trim: true, maxlength: 500 },
  artistDisplayName: { type: String, required: true, trim: true, maxlength: 500 },
  date: { type: String, default: "", maxlength: 10 },
  country: { type: String, default: "", maxlength: 10 },
  formats: { type: [String], default: [] },
  disambiguation: { type: String, default: "", maxlength: 500 },
  status: { type: String, default: "", maxlength: 100 },
  tracks: { type: [trackSchema], required: true },
  retrievedAt: { type: Date, required: true },
  sourceUrl: { type: String, required: true, maxlength: 2048 },
  license: { type: String, required: true, enum: ["CC0"] },
  tracklistHash: { type: String, required: true, match: /^[0-9a-f]{64}$/iu },
}, { _id: false, strict: "throw" });

const baselineSchema = new mongoose.Schema({
  baselineId: uuid,
  albumId: { type: String, required: true, lowercase: true, index: true },
  version: { type: Number, required: true, min: 1 },
  catalogRevision: { type: Number, required: true, min: 1 },
  candidate: { type: candidateSchema, required: true },
  reviewedByUserId: { type: String, required: true, maxlength: 128 },
  reviewedAt: { type: Date, required: true },
  reason: { type: String, required: true, maxlength: 1000 },
}, { timestamps: { createdAt: true, updatedAt: false }, strict: "throw" });
baselineSchema.index({ albumId: 1, version: 1 }, { unique: true });
baselineSchema.index({ albumId: 1, "candidate.tracklistHash": 1 });

const snapshotSchema = new mongoose.Schema({
  snapshotId: uuid,
  targetKind: { type: String, required: true, enum: ["albums", "submissions"] },
  targetId: { type: String, required: true, lowercase: true },
  targetRevision: { type: Number, required: true, min: 1 },
  candidate: { type: candidateSchema, required: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
}, { timestamps: true, strict: "throw" });
snapshotSchema.index({ targetKind: 1, targetId: 1, targetRevision: 1, "candidate.releaseMbid": 1, "candidate.tracklistHash": 1 }, { unique: true });

const headSchema = new mongoose.Schema({
  targetKind: { type: String, required: true, enum: ["albums", "submissions"] },
  targetId: { type: String, required: true, lowercase: true },
  revision: { type: Number, required: true, min: 1, default: 1 },
  status: { type: String, required: true, enum: ["pending", "reviewed", "stale", "deferred", "revoked"], default: "pending" },
  targetRevision: { type: Number, required: true, min: 1 },
  activeBaselineId: { type: mongoose.Schema.Types.ObjectId, ref: "AlbumBaseline", default: null },
  selectedSnapshotId: { type: mongoose.Schema.Types.ObjectId, ref: "AlbumBaselineCandidate", default: null },
  reason: { type: String, default: "", maxlength: 1000 },
  workerFence: { type: String, default: "", select: false },
}, { timestamps: true, strict: "throw" });
headSchema.index({ targetKind: 1, targetId: 1 }, { unique: true });
headSchema.index({ status: 1, updatedAt: 1, _id: 1 });

const auditSchema = new mongoose.Schema({
  auditId: uuid,
  targetKind: { type: String, required: true, enum: ["albums", "submissions"] },
  targetId: { type: String, required: true, lowercase: true },
  requestId: { type: String, required: true, lowercase: true },
  action: { type: String, required: true, enum: ["confirm", "replace", "defer", "revoke", "publish", "invalidate", "queue"] },
  revision: { type: Number, required: true, min: 1 },
  actorUserId: { type: String, required: true, maxlength: 128 },
  reason: { type: String, required: true, maxlength: 1000 },
  baselineId: { type: String, default: "" },
  details: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: { createdAt: true, updatedAt: false }, strict: "throw" });
auditSchema.index({ targetKind: 1, targetId: 1, requestId: 1 }, { unique: true });
auditSchema.index({ targetKind: 1, targetId: 1, revision: 1 });

function model(name, schema) {
  return mongoose.models[name] || mongoose.model(name, schema);
}

module.exports = {
  Baseline: model("AlbumBaseline", baselineSchema),
  Candidate: model("AlbumBaselineCandidate", snapshotSchema),
  Head: model("AlbumBaselineHead", headSchema),
  Audit: model("AlbumBaselineAudit", auditSchema),
};
