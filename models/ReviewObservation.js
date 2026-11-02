// Private measurement records for moderator review (docs/DETERMINISTIC_MAPPING_METRICS_PLAN.md).
// Every collection here expires and can be cleared without touching the moderation audit history.
const crypto = require("node:crypto");
const mongoose = require("mongoose");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH = /^[0-9a-f]{64}$/iu;
const uuid = { type: String, required: true, unique: true, immutable: true, default: () => crypto.randomUUID(), match: UUID };
const hash = { type: String, required: true, match: HASH };
const expiresAt = { type: Date, required: true, index: { expires: 0 } };

// One evidence item as displayed: a catalog album (mapping) or a MusicBrainz release (baseline).
const refSchema = new mongoose.Schema({
  id: { type: String, required: true, maxlength: 64 },
  revision: { type: Number, min: 1 },
  tracklistHash: { type: String, match: HASH },
}, { _id: false, strict: "throw" });

// Coverage facts shown with the evidence. Mapping and baseline use different fields; absent means not applicable.
const coverageSchema = new mongoose.Schema({
  discoveryError: { type: String, maxlength: 100 },
  providerIncomplete: Boolean,
  queryCapReached: Boolean,
  candidateCapReached: Boolean,
  candidatesFound: { type: Number, min: 0 },
  candidatesShown: { type: Number, min: 0 },
  retainedAfterFailedRefresh: Boolean,
  staleCandidateRevision: Boolean,
  browseComplete: Boolean,
  browseListed: { type: Number, min: 0 },
  browseTotal: { type: Number, min: 0 },
  hydrationComplete: Boolean,
  hydrationFailed: { type: Number, min: 0 },
  uninspectedCompeting: { type: Number, min: 0 },
  competing: { type: Number, min: 0 },
  ambiguous: Boolean,
  incomplete: Boolean,
}, { _id: false, strict: "throw" });

const evidenceSchema = new mongoose.Schema({
  capturedAt: { type: Date, required: true },
  // Case revision (mapping), or catalog/submission revision (baseline), when the evidence was read.
  targetRevision: { type: Number, required: true, min: 1 },
  // The revision the moderator's command expected; differs from targetRevision only after a race.
  expectedRevision: { type: Number, required: true, min: 0 },
  headRevision: { type: Number, min: 0 },
  candidates: { type: [refSchema], default: [] },
  candidatesTruncated: { type: Boolean, default: false },
  coverage: { type: coverageSchema, default: null },
  recommendationRunId: { type: String, default: "", match: /^(?:[0-9a-f-]{36})?$/iu },
  recommended: { type: refSchema, default: null },
  selected: { type: refSchema, default: null },
  // Index of the selection in candidates; -1 when it came from outside the displayed list.
  selectedRank: { type: Number, default: null, min: -1 },
  evidenceHash: hash,
}, { _id: false, strict: "throw" });

// One final moderator decision, written after its transaction commits and keyed by the audit entry.
// A failed write leaves a marker with its reason when the marker itself can be written.
const episodeSchema = new mongoose.Schema({
  auditId: { type: String, required: true, unique: true, immutable: true, match: UUID },
  evidenceVersion: { type: Number, required: true, enum: [1] },
  kind: { type: String, required: true, enum: ["mapping", "baseline"] },
  targetKind: { type: String, required: true, enum: ["cases", "albums", "submissions"] },
  targetId: { type: String, required: true, match: UUID },
  action: { type: String, required: true, enum: ["approved", "rejected", "no_catalog_match", "confirm", "replace", "defer", "revoke"] },
  decidedRevision: { type: Number, required: true, min: 1 },
  moderatorHash: hash,
  outcome: { type: String, required: true, enum: ["recorded", "failed"] },
  failureReason: { type: String, default: "", enum: ["", "capture_failed", "capture_invalid", "write_failed", "write_timeout"] },
  evidence: { type: evidenceSchema, default: null },
  decidedAt: { type: Date, required: true },
  recordedAt: { type: Date, required: true },
  expiresAt,
}, { timestamps: false, strict: "throw" });
episodeSchema.index({ decidedAt: 1 });

const runRefSchema = new mongoose.Schema({
  releaseMbid: { type: String, required: true, maxlength: 36 },
  tracklistHash: { type: String, match: HASH },
}, { _id: false, strict: "throw" });
const comparisonSchema = new mongoose.Schema({
  releaseMbid: { type: String, required: true, maxlength: 36 },
  competing: { type: Boolean, required: true },
  equivalent: { type: Boolean, default: null },
}, { _id: false, strict: "throw" });

// One baseline recommender execution (offset 0), best effort, independent of any decision.
const recommendationRunSchema = new mongoose.Schema({
  runId: uuid,
  evidenceVersion: { type: Number, required: true, enum: [1] },
  recommenderVersion: { type: Number, required: true, min: 1 },
  targetKind: { type: String, required: true, enum: ["albums", "submissions"] },
  targetId: { type: String, required: true, match: UUID },
  targetRevision: { type: Number, required: true, min: 1 },
  outcome: { type: String, required: true, enum: ["recommended", "no_candidate", "failed"] },
  errorCode: { type: String, default: "", maxlength: 100 },
  coverage: { type: coverageSchema, default: null },
  ranked: { type: [runRefSchema], default: [] },
  rankedTruncated: { type: Boolean, default: false },
  recommended: { type: runRefSchema, default: null },
  comparisons: { type: [comparisonSchema], default: [] },
  startedAt: { type: Date, required: true },
  completedAt: { type: Date, required: true },
  expiresAt,
}, { timestamps: false, strict: "throw" });
recommendationRunSchema.index({ targetKind: 1, targetId: 1, targetRevision: 1, completedAt: -1 });
recommendationRunSchema.index({ startedAt: 1 });

// Per-moderator consent for the active-effort timer. Only the pseudonymous hash is stored.
const effortOptInSchema = new mongoose.Schema({
  moderatorHash: { ...hash, unique: true },
  optedIn: { type: Boolean, required: true },
}, { timestamps: true, strict: "throw" });

const intervalSchema = new mongoose.Schema({
  startedAt: { type: Date, required: true },
  endedAt: { type: Date, required: true },
}, { _id: false, strict: "throw" });

// Active intervals a moderator timed for one review, linked to the decision's audit entry when found.
const effortSchema = new mongoose.Schema({
  effortId: uuid,
  moderatorHash: hash,
  kind: { type: String, required: true, enum: ["mapping", "baseline"] },
  targetKind: { type: String, required: true, enum: ["cases", "albums", "submissions"] },
  targetId: { type: String, required: true, match: UUID },
  targetRevision: { type: Number, required: true, min: 0 },
  outcome: { type: String, required: true, enum: ["decided", "abandoned"] },
  intervals: { type: [intervalSchema], required: true },
  activeMs: { type: Number, required: true, min: 0 },
  auditId: { type: String, default: "", match: /^(?:[0-9a-f-]{36})?$/iu },
  recordedAt: { type: Date, required: true },
  expiresAt,
}, { timestamps: false, strict: "throw" });
effortSchema.index({ recordedAt: 1 });
// Each decision is linked to at most one timing.
effortSchema.index({ auditId: 1 }, { partialFilterExpression: { auditId: { $gt: "" } } });

module.exports = {
  Episode: mongoose.model("ReviewEpisode", episodeSchema),
  RecommendationRun: mongoose.model("BaselineRecommendationRun", recommendationRunSchema),
  EffortOptIn: mongoose.model("ReviewEffortOptIn", effortOptInSchema),
  Effort: mongoose.model("ReviewEffort", effortSchema),
};
