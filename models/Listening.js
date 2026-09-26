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

const errorSchema = new mongoose.Schema({ code: { type: String, required: true }, at: { type: Date, required: true } }, { _id: false });
const gapSchema = new mongoose.Schema({ from: { type: Date, required: true }, to: { type: Date, required: true } }, { _id: false });
const windowSchema = new mongoose.Schema({ start: { type: Date, required: true }, end: { type: Date, default: null } }, { _id: false });

const connectionSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true, trim: true },
  username: { type: String, required: true, trim: true, maxlength: 200 },
  usernameKey: { type: String, required: true, trim: true, maxlength: 200 },
  state: { type: String, required: true, enum: ["active", "paused", "disconnected"], default: "active" },
  revision: { type: Number, required: true, min: 1, default: 1 },
  connectedAt: { type: Date, required: true },
  windows: { type: [windowSchema], default: [] },
  completedThrough: { type: Date, default: null },
  progress: { type: mongoose.Schema.Types.Mixed, default: {} },
  lastSuccessfulSync: { type: Date, default: null },
  nextSyncAt: { type: Date, default: null },
  error: { type: errorSchema, default: null },
  retentionGap: { type: gapSchema, default: null },
  // Internal optimistic-write fence. Never serialize it from an owner API.
  workerFence: { type: String, default: "", select: false },
}, { timestamps: true });
connectionSchema.index({ usernameKey: 1 }, {
  unique: true,
  partialFilterExpression: { state: { $in: ["active", "paused"] } },
});
connectionSchema.index({ state: 1, nextSyncAt: 1 });

const authAttemptSchema = new mongoose.Schema({
  stateHash: { type: String, required: true, unique: true, immutable: true },
  userId: { type: String, required: true, index: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  consumedAt: { type: Date, default: null },
  callbackUrl: { type: String, required: true, maxlength: 2_000 },
}, { timestamps: true });

const scrobbleSchema = new mongoose.Schema({
  eventId: uuid,
  connectionId: { type: mongoose.Schema.Types.ObjectId, ref: "ListeningConnection", required: true, index: true },
  connectionRevision: { type: Number, required: true, min: 1 },
  identityKey: { type: String, required: true },
  artist: { type: String, default: "", maxlength: 500 },
  album: { type: String, default: "", maxlength: 500 },
  track: { type: String, default: "", maxlength: 500 },
  artistKey: { type: String, default: "", maxlength: 500 },
  albumKey: { type: String, default: "", maxlength: 500 },
  trackKey: { type: String, default: "", maxlength: 500 },
  artistMbid: { type: String, default: "", maxlength: 64 },
  albumMbid: { type: String, default: "", maxlength: 64 },
  trackMbid: { type: String, default: "", maxlength: 64 },
  playedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  resolution: { type: String, required: true, enum: ["matched", "unresolved", "unavailable"] },
  albumId: { type: String, default: "" },
  mappingId: { type: String, default: "" },
  mappingRevision: { type: Number, default: null },
  catalogRevision: { type: Number, default: null },
  baselineAvailable: { type: Boolean, default: false },
}, { timestamps: true });
scrobbleSchema.index({ connectionId: 1, identityKey: 1 }, { unique: true });
scrobbleSchema.index({ artistKey: 1, albumKey: 1, resolution: 1 });

const mappingCaseSchema = new mongoose.Schema({
  caseId: uuid,
  key: { type: String, required: true, unique: true, immutable: true },
  provider: { type: String, required: true, enum: ["lastfm"], default: "lastfm" },
  artist: { type: String, required: true, maxlength: 500 },
  album: { type: String, required: true, maxlength: 500 },
  artistKey: { type: String, required: true, maxlength: 500 },
  albumKey: { type: String, required: true, maxlength: 500 },
  normalizationVersion: { type: Number, required: true, enum: [1], default: 1 },
  status: { type: String, required: true, enum: ["pending", "approved", "rejected", "no_catalog_match"], default: "pending" },
  revision: { type: Number, required: true, min: 1, default: 1 },
  encounterCount: { type: Number, required: true, min: 0, default: 0 },
  candidates: { type: [mongoose.Schema.Types.Mixed], default: [] },
  evidence: { type: [mongoose.Schema.Types.Mixed], default: [] },
  evidenceHash: { type: String, default: "" },
  discoveryError: { type: String, default: "" },
  refreshedAt: { type: Date, default: null },
}, { timestamps: true });
mappingCaseSchema.index({ status: 1, encounterCount: -1, updatedAt: 1 });

const albumMappingSchema = new mongoose.Schema({
  mappingId: uuid,
  key: { type: String, required: true, unique: true, immutable: true },
  provider: { type: String, required: true, enum: ["lastfm"], default: "lastfm" },
  artist: { type: String, required: true, maxlength: 500 },
  album: { type: String, required: true, maxlength: 500 },
  artistKey: { type: String, required: true, maxlength: 500 },
  albumKey: { type: String, required: true, maxlength: 500 },
  normalizationVersion: { type: Number, required: true, enum: [1], default: 1 },
  albumId: { type: String, required: true, lowercase: true },
  catalogRevision: { type: Number, required: true, min: 1 },
  revision: { type: Number, required: true, min: 1, default: 1 },
  status: { type: String, required: true, enum: ["active", "revoked"], default: "active" },
  evidence: { type: [mongoose.Schema.Types.Mixed], default: [] },
  reviewer: { type: String, required: true },
  reason: { type: String, required: true, maxlength: 2_000 },
  // Internal transaction fence; never serialized by owner or moderator APIs.
  workerFence: { type: String, default: "", select: false },
}, { timestamps: true });
albumMappingSchema.index({ artistKey: 1, albumKey: 1, status: 1 });

const mappingAuditSchema = new mongoose.Schema({
  auditId: uuid,
  caseId: { type: String, required: true, index: true },
  mappingId: { type: String, default: "", index: true },
  action: { type: String, required: true },
  reviewer: { type: String, required: true },
  reason: { type: String, required: true, maxlength: 2_000 },
  revision: { type: Number, required: true, min: 1 },
  details: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: { createdAt: true, updatedAt: false } });

const jobSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, immutable: true },
  type: { type: String, required: true, enum: ["sync", "discovery", "reprocess", "cleanup"] },
  payload: { type: mongoose.Schema.Types.Mixed, required: true, default: {} },
  status: { type: String, required: true, enum: ["pending", "running", "done"], default: "pending" },
  runAt: { type: Date, required: true, default: Date.now },
  leaseUntil: { type: Date, default: null },
  leaseToken: { type: String, default: "" },
  attempts: { type: Number, required: true, min: 0, default: 0 },
  progress: { type: mongoose.Schema.Types.Mixed, default: {} },
  error: { type: String, default: "" },
}, { timestamps: true });
jobSchema.index({ status: 1, runAt: 1, leaseUntil: 1 });

const providerBudgetSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, immutable: true },
  windowStartedAt: { type: Date, required: true },
  used: { type: Number, required: true, min: 0, default: 0 },
  cooldownUntil: { type: Date, default: null },
}, { timestamps: true });

const providerCacheSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, immutable: true },
  value: { type: mongoose.Schema.Types.Mixed, required: true },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
}, { timestamps: true });

function model(name, schema) {
  return mongoose.models[name] || mongoose.model(name, schema);
}

module.exports = {
  Connection: model("ListeningConnection", connectionSchema),
  AuthAttempt: model("ListeningAuthAttempt", authAttemptSchema),
  Scrobble: model("ListeningScrobble", scrobbleSchema),
  MappingCase: model("ListeningMappingCase", mappingCaseSchema),
  AlbumMapping: model("ListeningAlbumMapping", albumMappingSchema),
  MappingAudit: model("ListeningMappingAudit", mappingAuditSchema),
  Job: model("ListeningJob", jobSchema),
  ProviderBudget: model("ListeningProviderBudget", providerBudgetSchema),
  ProviderCache: model("ListeningProviderCache", providerCacheSchema),
};
