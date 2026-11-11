const mongoose = require("mongoose");
const { ARTIST_ID_PATTERN, ARTIST_SOURCES, MAX_ARTIST_NAME_LENGTH } = require("../lib/artists/identity");

const externalReferenceSchema = new mongoose.Schema(
  {
    provider: { type: String, required: true, trim: true, lowercase: true },
    entityType: { type: String, required: true, trim: true, lowercase: true },
    externalId: { type: String, required: true, trim: true, lowercase: true },
    url: { type: String, default: "", trim: true },
  },
  { _id: false },
);

// Artist identity registry. Phase 1 is identity only: it maps stable public
// Rescened artist IDs to MusicBrainz artist MBIDs so album credits can carry
// both. It has no public route, page, or biography yet. `name` is a verified
// MusicBrainz artist name when available, otherwise a provisional credited
// name; fieldProvenance.name.nameSource distinguishes them. Album credits
// keep their own wording regardless of the registry name.
const artistSchema = new mongoose.Schema(
  {
    artistId: {
      type: String,
      required: true,
      unique: true,
      immutable: true,
      lowercase: true,
      match: ARTIST_ID_PATTERN,
    },
    name: { type: String, required: true, trim: true, maxlength: MAX_ARTIST_NAME_LENGTH },
    externalReferences: {
      type: [externalReferenceSchema],
      default: [],
      validate: {
        validator: (references) => references.filter((reference) => (
          reference.provider === "musicbrainz" && reference.entityType === "artist"
        )).length <= 1,
        message: "An artist can have at most one MusicBrainz artist reference",
      },
    },
    fieldProvenance: { type: mongoose.Schema.Types.Mixed, default: {} },
    artistSource: { type: String, enum: ARTIST_SOURCES, required: true },
  },
  { timestamps: true },
);

// One registry artist per external identity. The partial filter keeps future
// artists without any external reference out of the unique index.
artistSchema.index(
  { "externalReferences.provider": 1, "externalReferences.entityType": 1, "externalReferences.externalId": 1 },
  { unique: true, partialFilterExpression: { "externalReferences.externalId": { $exists: true } } },
);

module.exports = mongoose.models.Artist || mongoose.model("Artist", artistSchema);
