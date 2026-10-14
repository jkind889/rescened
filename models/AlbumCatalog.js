const mongoose = require("mongoose");
const { MAX_ALBUM_GENRES } = require("../lib/genres/vocabulary");

const artistCreditSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    role: { type: String, default: "main", trim: true },
  },
  { _id: false },
);

const trackSchema = new mongoose.Schema(
  {
    trackId: { type: String, required: true, trim: true },
    discNumber: { type: Number, default: 1, min: 1 },
    trackNumber: { type: Number, default: 1, min: 1 },
    title: { type: String, required: true, trim: true },
    durationMs: { type: Number, default: 0, min: 0 },
    artistDisplayName: { type: String, default: "", trim: true },
  },
  { _id: false },
);

const externalReferenceSchema = new mongoose.Schema(
  {
    provider: { type: String, required: true, trim: true, lowercase: true },
    entityType: { type: String, required: true, trim: true, lowercase: true },
    externalId: { type: String, required: true, trim: true },
    url: { type: String, default: "", trim: true },
  },
  { _id: false },
);

const catalogRevisionSchema = {
  type: Number,
  required: true,
  min: 1,
  default: 1,
};

const albumCatalogSchema = new mongoose.Schema(
  {
    // Public, provider-neutral identity. Mongo's _id remains an internal relation key.
    albumId: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      lowercase: true,
      match: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    },
    title: { type: String, required: true, trim: true },
    artistDisplayName: { type: String, required: true, trim: true },
    artistCredits: { type: [artistCreditSchema], default: [] },
    releaseType: {
      type: String,
      enum: ["album", "ep", "single", "mixtape", "soundtrack", "compilation", "live", "remix", "other"],
      default: "album",
    },
    releaseDate: { type: String, default: "", trim: true },
    releaseDatePrecision: { type: String, enum: ["year", "month", "day", ""], default: "" },
    releaseYear: { type: Number, min: 0, max: 9999, default: null },
    tracks: { type: [trackSchema], default: [] },
    label: { type: String, default: "", trim: true },
    cover: { type: String, default: "", trim: true },
    externalReferences: { type: [externalReferenceSchema], default: [] },
    fieldProvenance: { type: mongoose.Schema.Types.Mixed, default: {} },
    catalogSource: { type: String, enum: ["community", "import", "manual"], default: "community" },
    // Internal optimistic-concurrency token. It is deliberately omitted from
    // public album representations and advances on every maintained catalog
    // mutation.
    catalogRevision: catalogRevisionSchema,
    // Community genres, ordered with the primary genre first. Only the genre
    // service writes these. They advance genresRevision rather than
    // catalogRevision, because no other catalog writer touches them.
    genres: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Genre" }],
      default: undefined,
      validate: {
        validator: (value) => !value || (value.length <= MAX_ALBUM_GENRES && new Set(value.map(String)).size === value.length),
        message: `An album can have at most ${MAX_ALBUM_GENRES} distinct genres`,
      },
    },
    // Internal genre concurrency token; a missing field counts as 0.
    genresRevision: { type: Number, min: 0, default: undefined },
  },
  { timestamps: true },
);

albumCatalogSchema.index({ title: "text", artistDisplayName: "text", "artistCredits.name": "text" });
albumCatalogSchema.index({ artistDisplayName: 1, title: 1 });
albumCatalogSchema.index({ genres: 1 }, { sparse: true });
albumCatalogSchema.index(
  { "externalReferences.provider": 1, "externalReferences.entityType": 1, "externalReferences.externalId": 1 },
  { unique: true, sparse: true },
);

module.exports = mongoose.model("AlbumCatalog", albumCatalogSchema);
