const crypto = require("node:crypto");
const mongoose = require("mongoose");

const RELEASE_TYPES = [
  "album",
  "ep",
  "single",
  "mixtape",
  "soundtrack",
  "compilation",
  "live",
  "remix",
  "other",
];
const SUBMISSION_STATUSES = [
  "pending",
  "needs_changes",
  "approved",
  "rejected",
  "duplicate",
  "withdrawn",
];
const MODERATION_ACTIONS = [
  "submitted",
  "revised",
  "withdrawn",
  "request_changes",
  "approved",
  "rejected",
  "marked_duplicate",
];
const SUBMISSION_TYPES = ["new_album", "catalog_correction", "genre_suggestion"];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CORRECTION_FIELDS = ["title", "artists", "releaseType", "releaseDate", "label", "cover", "tracks", "externalReferences"];

function isHttpsUrl(value) {
  if (!value) return true;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

const artistCreditSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    role: { type: String, default: "main", trim: true, maxlength: 80 },
  },
  { _id: false, strict: "throw" },
);

const proposedTrackSchema = new mongoose.Schema(
  {
    discNumber: { type: Number, required: true, min: 1, max: 999 },
    trackNumber: { type: Number, required: true, min: 1, max: 999 },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    durationMs: { type: Number, default: 0, min: 0, max: 86400000 },
    artistDisplayName: { type: String, default: "", trim: true, maxlength: 300 },
  },
  { _id: false, strict: "throw" },
);

const proposedMetadataSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    artistDisplayName: { type: String, required: true, trim: true, maxlength: 300 },
    artistCredits: {
      type: [artistCreditSchema],
      required: true,
      validate: [
        { validator: (value) => value.length >= 1, message: "At least one artist credit is required." },
        { validator: (value) => value.length <= 20, message: "At most twenty artist credits are allowed." },
      ],
    },
    releaseType: { type: String, enum: RELEASE_TYPES, required: true },
    releaseDate: {
      type: String,
      required: true,
      match: /^\d{4}(?:-\d{2})?(?:-\d{2})?$/,
    },
    releaseDatePrecision: { type: String, enum: ["year", "month", "day"], required: true },
    releaseYear: { type: Number, required: true, min: 1, max: 9999 },
    label: { type: String, default: "", trim: true, maxlength: 200 },
    country: { type: String, default: "", trim: true, maxlength: 100 },
    catalogNumber: { type: String, default: "", trim: true, maxlength: 100 },
    barcode: { type: String, default: "", trim: true, match: /^(?:\d{8,14})?$/ },
    tracks: {
      type: [proposedTrackSchema],
      default: [],
      validate: { validator: (value) => value.length <= 200, message: "At most two hundred tracks are allowed." },
    },
    coverSourceUrl: {
      type: String,
      default: "",
      trim: true,
      maxlength: 2048,
      validate: { validator: isHttpsUrl, message: "Cover source URL must use https." },
    },
  },
  { _id: false, strict: "throw" },
);

const supportingSourceSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["musicbrainz", "official_artist", "official_label", "distributor", "store", "spotify", "other"],
      required: true,
    },
    url: {
      type: String,
      required: true,
      trim: true,
      maxlength: 2048,
      validate: { validator: isHttpsUrl, message: "Supporting source URL must use https." },
    },
    description: { type: String, default: "", trim: true, maxlength: 200 },
  },
  { _id: false, strict: "throw" },
);

const externalReferenceSchema = new mongoose.Schema(
  {
    provider: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 50,
      validate: { validator: (value) => value !== "spotify", message: "Spotify references belong in supporting evidence." },
    },
    entityType: { type: String, required: true, trim: true, lowercase: true, maxlength: 50 },
    externalId: { type: String, required: true, trim: true, maxlength: 200 },
    url: {
      type: String,
      default: "",
      trim: true,
      maxlength: 2048,
      validate: { validator: isHttpsUrl, message: "External reference URL must use https." },
    },
  },
  { _id: false, strict: "throw" },
);

const correctionArtistSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    role: { type: String, default: "main", trim: true, maxlength: 80 },
  },
  { _id: false, strict: "throw" },
);

const correctionDateSchema = new mongoose.Schema(
  {
    releaseDate: { type: String, required: true, match: /^\d{4}(?:-\d{2})?(?:-\d{2})?$/ },
    releaseDatePrecision: { type: String, enum: ["year", "month", "day"], required: true },
    releaseYear: { type: Number, required: true, min: 1, max: 9999 },
  },
  { _id: false, strict: "throw" },
);

const correctionTrackSchema = new mongoose.Schema(
  {
    trackId: { type: String, trim: true, match: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i },
    discNumber: { type: Number, required: true, min: 1, max: 999 },
    trackNumber: { type: Number, required: true, min: 1, max: 999 },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    durationMs: { type: Number, default: 0, min: 0, max: 86400000 },
    artistDisplayName: { type: String, default: "", trim: true, maxlength: 300 },
  },
  { _id: false, strict: "throw" },
);

const correctionChangesSchema = new mongoose.Schema(
  {
    title: { type: String, trim: true, maxlength: 200 },
    artists: {
      type: new mongoose.Schema({
        artistDisplayName: { type: String, required: true, trim: true, maxlength: 300 },
        artistCredits: {
          type: [correctionArtistSchema],
          required: true,
          validate: { validator: (value) => value.length >= 1 && value.length <= 20, message: "One to twenty artist credits are required." },
        },
      }, { _id: false, strict: "throw" }),
    },
    releaseType: { type: String, enum: RELEASE_TYPES },
    releaseDate: { type: correctionDateSchema },
    label: { type: String, trim: true, maxlength: 200 },
    cover: { type: String, trim: true, maxlength: 2048, validate: { validator: isHttpsUrl, message: "Cover URL must use https." } },
    tracks: {
      type: [correctionTrackSchema],
      default: undefined,
      validate: { validator: (value) => value.length <= 200, message: "At most two hundred tracks are allowed." },
    },
    externalReferences: {
      type: new mongoose.Schema({
        add: {
          type: [externalReferenceSchema],
          required: true,
          validate: { validator: (value) => value.length >= 1 && value.length <= 20, message: "One to twenty external references may be added." },
        },
      }, { _id: false, strict: "throw" }),
    },
  },
  { _id: false, strict: "throw" },
);

const correctionApplicationSchema = new mongoose.Schema(
  {
    targetAlbumId: { type: String, required: true },
    proposedFields: { type: [String], required: true },
    appliedFields: { type: [String], required: true },
    unappliedFields: { type: [String], required: true },
    baseCatalogRevision: { type: Number, required: true, min: 1 },
    resultCatalogRevision: { type: Number, required: true, min: 1 },
  },
  { _id: false, strict: "throw" },
);

// Genre suggestions store public genre snapshots (genreId, slug, name at
// submission time) so the record reads the same after a later rename.
const genreRefSchema = new mongoose.Schema(
  {
    genreId: { type: String, required: true, lowercase: true, match: UUID_V4 },
    slug: { type: String, required: true, maxlength: 80 },
    name: { type: String, required: true, maxlength: 40 },
  },
  { _id: false, strict: "throw" },
);

const proposedGenreSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 40 },
    normalizedName: { type: String, required: true, maxlength: 40 },
    slug: { type: String, required: true, maxlength: 80 },
    parent: { type: genreRefSchema, default: null },
  },
  { _id: false, strict: "throw" },
);

const genreAdditionSchema = new mongoose.Schema(
  {
    genre: { type: genreRefSchema, default: null },
    newGenre: { type: proposedGenreSchema, default: null },
  },
  { _id: false, strict: "throw" },
);

const genreChangesSchema = new mongoose.Schema(
  {
    additions: {
      type: [genreAdditionSchema],
      default: [],
      validate: { validator: (value) => value.length <= 5, message: "At most five genres may be added." },
    },
    removals: {
      type: [genreRefSchema],
      default: [],
      validate: { validator: (value) => value.length <= 5, message: "At most five genres may be removed." },
    },
    // Either an existing genre or the index of an addition (which may be new).
    primary: {
      type: new mongoose.Schema({
        genre: { type: genreRefSchema, default: null },
        addIndex: { type: Number, min: 0, max: 4, default: null },
      }, { _id: false, strict: "throw" }),
      default: null,
    },
    note: { type: String, default: "", trim: true, maxlength: 500 },
  },
  { _id: false, strict: "throw" },
);

const genreBaselineSchema = new mongoose.Schema(
  {
    genres: { type: [genreRefSchema], default: [] },
    genresRevision: { type: Number, required: true, min: 0 },
  },
  { _id: false, strict: "throw" },
);

const duplicateSignalSchema = new mongoose.Schema(
  {
    matchType: { type: String, enum: ["external_reference", "barcode", "catalog_number", "fingerprint"], required: true },
    targetType: { type: String, enum: ["catalog", "submission"], required: true },
    key: { type: String, required: true, trim: true, maxlength: 300 },
    albumCatalogId: { type: mongoose.Schema.Types.ObjectId, ref: "AlbumCatalog", default: null },
    submissionId: { type: mongoose.Schema.Types.ObjectId, ref: "AlbumSubmission", default: null },
  },
  { _id: false, strict: "throw" },
);

const revisionSchema = new mongoose.Schema(
  {
    revision: { type: Number, required: true, min: 1 },
    submittedAt: { type: Date, required: true },
    submissionType: { type: String, enum: SUBMISSION_TYPES, default: "new_album" },
    proposedMetadata: { type: proposedMetadataSchema },
    supportingSources: {
      type: [supportingSourceSchema],
      required: true,
      validate: { validator: (value) => value.length <= 10, message: "At most ten sources are allowed." },
    },
    externalReferences: { type: [externalReferenceSchema], default: [] },
    normalizedFingerprint: { type: String, required: true, maxlength: 64 },
    candidateAlbumCatalogId: { type: mongoose.Schema.Types.ObjectId, ref: "AlbumCatalog", default: null },
    candidateSubmissionIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "AlbumSubmission" }],
      default: [],
      validate: { validator: (value) => value.length <= 10, message: "At most ten candidate submissions are retained." },
    },
    duplicateSignals: { type: [duplicateSignalSchema], default: [] },
    targetAlbumCatalogId: { type: mongoose.Schema.Types.ObjectId, ref: "AlbumCatalog", default: null },
    baseCatalogRevision: { type: Number, min: 1, default: null },
    baseValues: { type: mongoose.Schema.Types.Mixed, default: null },
    baseProvenance: { type: mongoose.Schema.Types.Mixed, default: null },
    proposedChanges: { type: correctionChangesSchema, default: null },
    genreBaseline: { type: genreBaselineSchema, default: null },
    genreChanges: { type: genreChangesSchema, default: null },
  },
  { _id: false, strict: "throw" },
);

const moderationEventSchema = new mongoose.Schema(
  {
    actorUserId: { type: String, required: true, trim: true, maxlength: 128 },
    action: { type: String, enum: MODERATION_ACTIONS, required: true },
    reason: { type: String, default: "", trim: true, maxlength: 1000 },
    createdAt: { type: Date, default: Date.now },
    application: { type: correctionApplicationSchema, default: null },
  },
  { _id: false, strict: "throw" },
);

const albumSubmissionSchema = new mongoose.Schema(
  {
    submissionId: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      lowercase: true,
      default: () => crypto.randomUUID(),
      match: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    },
    submissionType: { type: String, enum: SUBMISSION_TYPES, default: "new_album", required: true },
    submittedByUserId: { type: String, required: true, trim: true, maxlength: 128 },
    proposedMetadata: { type: proposedMetadataSchema },
    supportingSources: {
      type: [supportingSourceSchema],
      required: true,
      validate: { validator: (value) => value.length <= 10, message: "At most ten sources are allowed." },
    },
    externalReferences: { type: [externalReferenceSchema], default: [] },
    candidateAlbumCatalogId: { type: mongoose.Schema.Types.ObjectId, ref: "AlbumCatalog", default: null },
    candidateSubmissionIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "AlbumSubmission" }],
      default: [],
      validate: { validator: (value) => value.length <= 10, message: "At most ten candidate submissions are retained." },
    },
    duplicateSignals: { type: [duplicateSignalSchema], default: [] },
    normalizedFingerprint: { type: String, required: true, maxlength: 64 },
    targetAlbumCatalogId: { type: mongoose.Schema.Types.ObjectId, ref: "AlbumCatalog", default: null },
    baseCatalogRevision: { type: Number, min: 1, default: null },
    baseValues: { type: mongoose.Schema.Types.Mixed, default: null },
    baseProvenance: { type: mongoose.Schema.Types.Mixed, default: null },
    proposedChanges: { type: correctionChangesSchema, default: null },
    genreBaseline: { type: genreBaselineSchema, default: null },
    genreChanges: { type: genreChangesSchema, default: null },
    // "<submittedByUserId>:<target album _id>" while a genre suggestion is
    // pending or needs changes; unset when it closes. The unique sparse index
    // allows one open genre suggestion per user per album.
    openGenreSuggestionKey: { type: String, default: undefined, maxlength: 200 },
    status: { type: String, enum: SUBMISSION_STATUSES, default: "pending", required: true },
    approvedAlbumCatalogId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AlbumCatalog",
      default: null,
      validate: {
        validator(value) { return this.status !== "approved" || Boolean(value); },
        message: "Approved submissions must reference a catalog album.",
      },
    },
    duplicateOfSubmissionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AlbumSubmission",
      default: null,
      validate: {
        validator(value) { return this.status !== "duplicate" || Boolean(value); },
        message: "Duplicate submissions must reference another submission.",
      },
    },
    approvedAt: { type: Date, default: null },
    approvalPublicationType: { type: String, enum: ["catalog_created", "catalog_linked", "catalog_corrected"], default: null },
    currentRevision: { type: Number, required: true, min: 1, default: 1 },
    revisions: { type: [revisionSchema], default: [] },
    moderationHistory: { type: [moderationEventSchema], default: [] },
  },
  { timestamps: true, strict: "throw" },
);

albumSubmissionSchema.pre("validate", function validateSubmissionInvariants() {
  if (this.submissionType === "new_album" && !this.proposedMetadata) {
    this.invalidate("proposedMetadata", "New album submissions must include proposed metadata.");
  }
  if (this.submissionType !== "genre_suggestion" && !(this.supportingSources?.length >= 1)) {
    this.invalidate("supportingSources", "One to ten sources are required.");
  }
  if (this.submissionType === "genre_suggestion") {
    if (!this.targetAlbumCatalogId) this.invalidate("targetAlbumCatalogId", "Genre suggestions must target an album.");
    if (!this.genreChanges) this.invalidate("genreChanges", "Genre suggestions must include genre changes.");
    if (!this.genreBaseline) this.invalidate("genreBaseline", "Genre suggestions must include a genre baseline.");
  }
  if (this.submissionType === "catalog_correction") {
    if (!this.targetAlbumCatalogId) this.invalidate("targetAlbumCatalogId", "Catalog corrections must target an album.");
    if (!this.proposedChanges) this.invalidate("proposedChanges", "Catalog corrections must include proposed changes.");
    if (!this.baseCatalogRevision) this.invalidate("baseCatalogRevision", "Catalog corrections must include a catalog revision baseline.");
  }
  if (this.status === "approved" && !this.approvedAlbumCatalogId) {
    this.invalidate("approvedAlbumCatalogId", "Approved submissions must reference a catalog album.");
  }
  if (this.status === "approved" && !this.approvedAt) {
    this.invalidate("approvedAt", "Approved submissions must include an approval timestamp.");
  }
  if (this.status === "approved" && !this.approvalPublicationType) {
    this.invalidate("approvalPublicationType", "Approved submissions must include a publication type.");
  }
  if (this.status === "duplicate" && !this.duplicateOfSubmissionId) {
    this.invalidate("duplicateOfSubmissionId", "Duplicate submissions must reference another submission.");
  }
  if (Array.isArray(this.revisions) && this.revisions.length > 0 && this.currentRevision !== this.revisions.length) {
    this.invalidate("currentRevision", "Current revision must match the number of stored revisions.");
  }
});

function invariantValidationError(path, message) {
  const error = new mongoose.Error.ValidationError();
  error.addError(path, new mongoose.Error.ValidatorError({ path, message }));
  return error;
}

albumSubmissionSchema.pre(["findOneAndUpdate", "updateOne"], function validateSubmissionUpdate() {
  const update = this.getUpdate() || {};
  const set = update.$set || update;
  ["revisions", "moderationHistory"].forEach((field) => {
    if (set[field] !== undefined
      || update.$unset?.[field] !== undefined
      || update.$pull?.[field] !== undefined
      || update.$pullAll?.[field] !== undefined
      || update.$pop?.[field] !== undefined) {
      throw invariantValidationError(field, `${field} are append-only and cannot be replaced or removed.`);
    }
    const push = update.$push?.[field];
    if (push && typeof push === "object" && (push.$position !== undefined || push.$slice !== undefined)) {
      throw invariantValidationError(field, `${field} may only be appended.`);
    }
  });
  const status = set.status;
  if (status === "approved" && !set.approvedAlbumCatalogId) {
    throw invariantValidationError("approvedAlbumCatalogId", "Approved submissions must reference a catalog album.");
  }
  if (status === "approved" && !set.approvedAt) {
    throw invariantValidationError("approvedAt", "Approved submissions must include an approval timestamp.");
  }
  if (status === "approved" && !set.approvalPublicationType) {
    throw invariantValidationError("approvalPublicationType", "Approved submissions must include a publication type.");
  }
  if (status === "duplicate" && !set.duplicateOfSubmissionId) {
    throw invariantValidationError("duplicateOfSubmissionId", "Duplicate submissions must reference another submission.");
  }
  if (status === "approved" && set.duplicateOfSubmissionId && set.duplicateOfSubmissionId !== null) {
    throw invariantValidationError("duplicateOfSubmissionId", "Approved submissions cannot reference a duplicate submission.");
  }
  if (status === "duplicate" && set.approvedAlbumCatalogId && set.approvedAlbumCatalogId !== null) {
    throw invariantValidationError("approvedAlbumCatalogId", "Duplicate submissions cannot reference an approved album.");
  }
});

albumSubmissionSchema.index({ submittedByUserId: 1, createdAt: -1, _id: -1 });
albumSubmissionSchema.index({ openGenreSuggestionKey: 1 }, { unique: true, sparse: true });
albumSubmissionSchema.index({ status: 1, updatedAt: -1, _id: -1 });
albumSubmissionSchema.index({ status: 1, approvedAt: -1, _id: -1 });
albumSubmissionSchema.index({ normalizedFingerprint: 1, status: 1 });
albumSubmissionSchema.index({ "externalReferences.provider": 1, "externalReferences.entityType": 1, "externalReferences.externalId": 1 });
albumSubmissionSchema.index({ "proposedMetadata.barcode": 1 }, { sparse: true });
albumSubmissionSchema.index({ "proposedMetadata.catalogNumber": 1 }, { sparse: true });

module.exports = mongoose.model("AlbumSubmission", albumSubmissionSchema);
