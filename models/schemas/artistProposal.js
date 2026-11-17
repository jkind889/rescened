const mongoose = require("mongoose");
const { ARTIST_ID_PATTERN, MBID_PATTERN } = require("../../lib/artists/identity");
const {
  MAX_ARTIST_PROPOSALS,
  MAX_ARTIST_SELECTIONS,
  MAX_PROPOSAL_EVIDENCE,
  PROPOSAL_KEY_PATTERN,
  PROPOSAL_KINDS,
  SELECTION_KINDS,
} = require("../../lib/artists/proposals");

// Stored, private artist proposals that belong to one suggestion revision.
// Shapes mirror lib/artists/proposals.js; the server prepares them (including
// the MusicBrainz observation) and the approval resolver re-validates them.

function isHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

const evidenceSchema = new mongoose.Schema(
  {
    url: { type: String, required: true, maxlength: 2048, validate: { validator: isHttpsUrl, message: "Evidence links must use https." } },
    description: { type: String, default: "", maxlength: 200 },
  },
  { _id: false, strict: "throw" },
);

const observationSchema = new mongoose.Schema(
  {
    artistMbid: { type: String, required: true, lowercase: true, match: MBID_PATTERN },
    name: { type: String, required: true, maxlength: 500 },
    sortName: { type: String, default: "", maxlength: 500 },
    disambiguation: { type: String, default: "", maxlength: 500 },
    type: { type: String, default: "", maxlength: 50 },
    observedAt: { type: Date, required: true },
  },
  { _id: false, strict: "throw" },
);

const artistProposalSchema = new mongoose.Schema(
  {
    proposalKey: { type: String, required: true, match: PROPOSAL_KEY_PATTERN },
    kind: { type: String, enum: PROPOSAL_KINDS, required: true },
    artistMbid: { type: String, lowercase: true, match: MBID_PATTERN },
    observation: { type: observationSchema, default: undefined },
    canonicalName: { type: String, maxlength: 200 },
    evidence: { type: [evidenceSchema], default: undefined },
  },
  { _id: false, strict: "throw" },
);

artistProposalSchema.pre("validate", function validateProposalShape() {
  if (this.kind === "musicbrainz") {
    if (!this.artistMbid || !this.observation || this.observation.artistMbid !== this.artistMbid) {
      this.invalidate("observation", "MusicBrainz proposals need a server observation of the same MBID.");
    }
    if (this.canonicalName || this.evidence?.length) this.invalidate("kind", "MusicBrainz proposals carry no community fields.");
  } else if (this.kind === "community") {
    if (!String(this.canonicalName || "").trim()) this.invalidate("canonicalName", "Community proposals need a canonical name.");
    if (!this.evidence?.length || this.evidence.length > MAX_PROPOSAL_EVIDENCE) this.invalidate("evidence", "Community proposals need one to five links.");
    if (this.artistMbid || this.observation) this.invalidate("kind", "Community proposals carry no MusicBrainz identity.");
  }
});

const artistSelectionSchema = new mongoose.Schema(
  {
    position: { type: Number, required: true, min: 0, max: 199, validate: { validator: Number.isInteger, message: "position must be an integer." } },
    kind: { type: String, enum: SELECTION_KINDS, required: true },
    artistId: { type: String, lowercase: true, match: ARTIST_ID_PATTERN },
    proposalKey: { type: String, match: PROPOSAL_KEY_PATTERN },
  },
  { _id: false, strict: "throw" },
);

artistSelectionSchema.pre("validate", function validateSelectionShape() {
  if (this.kind === "existing" && (!this.artistId || this.proposalKey)) this.invalidate("artistId", "Existing selections name only an artistId.");
  if (this.kind === "proposal" && (!this.proposalKey || this.artistId)) this.invalidate("proposalKey", "Proposal selections name only a proposalKey.");
});

const artistProposalsField = {
  type: [artistProposalSchema],
  default: undefined,
  validate: { validator: (value) => !value || value.length <= MAX_ARTIST_PROPOSALS, message: "At most twenty artist proposals are allowed." },
};

const artistSelectionsField = {
  type: [artistSelectionSchema],
  default: undefined,
  validate: { validator: (value) => !value || value.length <= MAX_ARTIST_SELECTIONS, message: "At most twenty artist links are allowed." },
};

module.exports = { artistProposalSchema, artistSelectionSchema, artistProposalsField, artistSelectionsField };
