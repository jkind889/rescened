const mongoose = require("mongoose");
const { GENRE_ID_PATTERN, SLUG_PATTERN } = require("../lib/genres/vocabulary");

const aliasSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    normalizedName: { type: String, required: true },
    slug: { type: String, required: true, match: SLUG_PATTERN },
  },
  { _id: false },
);

const genreSchema = new mongoose.Schema(
  {
    // Public identity. Mongo's _id stays internal, as for albums.
    genreId: { type: String, required: true, unique: true, immutable: true, lowercase: true, match: GENRE_ID_PATTERN },
    slug: { type: String, required: true, unique: true, match: SLUG_PATTERN },
    name: { type: String, required: true, trim: true },
    normalizedName: { type: String, required: true, unique: true },
    // Alternative spellings and retired slugs; used for matching and redirects.
    aliases: { type: [aliasSchema], default: [] },
    parent: { type: mongoose.Schema.Types.ObjectId, ref: "Genre", default: null },
    status: { type: String, enum: ["active", "retired"], default: "active", required: true },
    // Reserved so descriptors can share the pipeline later; version 1 has genres only.
    kind: { type: String, enum: ["genre"], default: "genre", required: true },
    // Optimistic-concurrency token for vocabulary commands; a missing field
    // counts as 0. Album genre writes don't touch it.
    revision: { type: Number, min: 0, default: 0 },
    origin: {
      source: { type: String, enum: ["seed", "community"], required: true },
      datasetId: { type: String, default: null },
      submissionId: { type: String, default: null },
    },
  },
  { timestamps: true },
);

genreSchema.index({ "aliases.normalizedName": 1 });
genreSchema.index({ "aliases.slug": 1 });
genreSchema.index({ parent: 1, status: 1 });
genreSchema.index({ status: 1, name: 1 });

// Append-only audit of vocabulary changes. Nothing updates or deletes these.
const genreEventSchema = new mongoose.Schema(
  {
    genre: { type: mongoose.Schema.Types.ObjectId, ref: "Genre", required: true, immutable: true },
    genreId: { type: String, required: true, immutable: true },
    action: { type: String, enum: ["create", "rename", "alias_add", "reparent", "retire", "restore", "merge"], required: true, immutable: true },
    actorUserId: { type: String, required: true, immutable: true },
    reason: { type: String, default: "", immutable: true },
    before: { type: mongoose.Schema.Types.Mixed, default: null, immutable: true },
    after: { type: mongoose.Schema.Types.Mixed, default: null, immutable: true },
    datasetId: { type: String, default: null, immutable: true },
    datasetSha256: { type: String, default: null, immutable: true },
    submissionId: { type: String, default: null, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

genreEventSchema.index({ genre: 1, createdAt: -1 });

const Genre = mongoose.model("Genre", genreSchema);
const GenreEvent = mongoose.model("GenreEvent", genreEventSchema);

module.exports = { Genre, GenreEvent };
