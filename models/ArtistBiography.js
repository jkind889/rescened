const mongoose = require("mongoose");
const { ARTIST_ID_PATTERN } = require("../lib/artists/identity");

// One cached biography per registry artist and language (English only for
// now). Separate parts, each written only by its owner:
//   identity   - the resolver's MusicBrainz -> Wikidata -> Wikipedia verdict
//   accepted   - the published excerpt and its exact source revision
//   candidate  - an excerpt waiting for moderator review
//   fetch      - operational state for the last provider attempt
//   manual     - a moderator's corrected text (never touched by refresh)
//   moderation - suppression and match verdicts (never touched by refresh)
// `revision` advances on every write; all writes are conditional on it, so a
// refresh that raced a moderator command is discarded instead of applied.
const articleSchema = new mongoose.Schema({
  language: { type: String, required: true },
  title: { type: String, required: true },
  pageId: { type: Number, required: true },
  revisionId: { type: Number, required: true },
  revisionTimestamp: { type: String, default: undefined },
  url: { type: String, required: true },
  revisionUrl: { type: String, required: true },
}, { _id: false });

const excerptSchema = new mongoose.Schema({
  text: { type: String, required: true },
  textHash: { type: String, required: true },
  extractionVersion: { type: String, required: true },
  shortened: { type: Boolean, required: true },
  cut: { type: String, enum: ["sentence", "word"], required: true },
  qid: { type: String, required: true },
  article: { type: articleSchema, required: true },
  license: { name: String, url: String },
  retrievedAt: { type: Date, required: true },
  acceptedAt: { type: Date },
  acceptedBy: { type: String },
}, { _id: false });

const artistBiographySchema = new mongoose.Schema({
  artistId: { type: String, required: true, immutable: true, lowercase: true, match: ARTIST_ID_PATTERN },
  language: { type: String, required: true, immutable: true, enum: ["en"] },
  revision: { type: Number, required: true, min: 1 },
  identity: {
    state: { type: String, enum: ["verified", "needs_review", "conflict", "not_linked", "no_article", "unsuitable", "unchecked"], required: true },
    reasons: { type: [String], default: [] },
    qid: { type: String, default: null },
    // Why a verified record is published: the resolver's checks
    // ("automatic") or a moderator confirmation ("moderator").
    basis: { type: String, enum: [null, "automatic", "moderator"], default: null },
    evidence: { type: mongoose.Schema.Types.Mixed, default: {} },
    checkedAt: { type: Date, default: null },
    nextCheckAt: { type: Date, default: null },
  },
  accepted: { type: excerptSchema, default: null },
  candidate: { type: excerptSchema, default: null },
  contentCheckedAt: { type: Date, default: null },
  nextContentCheckAt: { type: Date, default: null },
  fetch: {
    lastAttemptAt: { type: Date, default: null },
    lastSuccessAt: { type: Date, default: null },
    lastErrorCode: { type: String, default: null },
    lastErrorProvider: { type: String, default: null },
    consecutiveFailures: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: null },
  },
  manual: {
    type: new mongoose.Schema({
      text: { type: String, required: true },
      textHash: { type: String, required: true },
      basedOn: { type: articleSchema, required: true },
      qid: { type: String, required: true },
      note: { type: String, default: "" },
      editedBy: { type: String, required: true },
      editedAt: { type: Date, required: true },
    }, { _id: false }),
    default: null,
  },
  moderation: {
    suppressed: { type: Boolean, default: false },
    suppressedReason: { type: String, default: "" },
    verdict: { type: String, enum: [null, "match_rejected", "match_confirmed"], default: null },
    verdictQid: { type: String, default: null },
    verdictReason: { type: String, default: "" },
    updatedBy: { type: String, default: null },
    updatedAt: { type: Date, default: null },
  },
  // Append-only audit trail of system and moderator changes.
  history: {
    type: [new mongoose.Schema({
      at: { type: Date, required: true },
      actorType: { type: String, enum: ["system", "moderator"], required: true },
      actorId: { type: String, default: null },
      action: { type: String, required: true },
      details: { type: mongoose.Schema.Types.Mixed, default: {} },
    }, { _id: false })],
    default: [],
  },
}, { timestamps: true });

artistBiographySchema.index({ artistId: 1, language: 1 }, { unique: true });
artistBiographySchema.index({ "identity.state": 1, updatedAt: -1 });
artistBiographySchema.index({ nextContentCheckAt: 1 }, { sparse: true });
artistBiographySchema.index({ "identity.nextCheckAt": 1 }, { sparse: true });

module.exports = mongoose.models.ArtistBiography || mongoose.model("ArtistBiography", artistBiographySchema);
