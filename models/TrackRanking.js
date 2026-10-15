const mongoose = require("mongoose");

// Upper bound on one ranking. Generous enough for deluxe editions and
// compilations while keeping a single document small.
const MAX_RANKED_TRACKS = 100;

function hasDistinctTrackIds(trackIds) {
  return new Set(trackIds).size === trackIds.length;
}

// A user's personal ordering of the tracks on one catalog album, best first.
// There is at most one ranking per user per album, so it is addressed publicly
// by (user, albumId) and needs no public identifier of its own; Mongo's _id
// stays internal. Rankings may be partial (e.g. a top five).
const trackRankingSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    albumCatalogId: { type: mongoose.Schema.Types.ObjectId, ref: "AlbumCatalog", required: true },
    // Catalog trackIds, not positions: tracklist enrichment preserves trackIds
    // but may reorder or correct track numbers.
    rankedTrackIds: {
      type: [{ type: String, trim: true, minlength: 1 }],
      validate: [
        { validator: (trackIds) => trackIds.length > 0, message: "A ranking needs at least one track" },
        {
          validator: (trackIds) => trackIds.length <= MAX_RANKED_TRACKS,
          message: `A ranking may include at most ${MAX_RANKED_TRACKS} tracks`,
        },
        { validator: hasDistinctTrackIds, message: "A ranking cannot list the same track twice" },
      ],
    },
  },
  { timestamps: true },
);

// Membership in the album's current tracklist cannot be checked by the schema;
// routes must verify every submitted trackId against AlbumCatalog.tracks
// before writing.
trackRankingSchema.index({ userId: 1, albumCatalogId: 1 }, { unique: true });
// Community aggregates for one album.
trackRankingSchema.index({ albumCatalogId: 1 });
// A user's recent rankings (profile pages and activity feeds), matching their
// sort and cursor tiebreak; also serves account deletion.
trackRankingSchema.index({ userId: 1, updatedAt: -1, albumCatalogId: -1 });

trackRankingSchema.statics.MAX_RANKED_TRACKS = MAX_RANKED_TRACKS;

// Reads a stored ranking against the album's current tracklist without
// rewriting it: tracks removed from the album are dropped, and tracks the user
// has not ranked (including ones added after the ranking was saved) are
// returned in tracklist order as unranked.
trackRankingSchema.statics.reconcileWithTracklist = function reconcileWithTracklist(rankedTrackIds, tracks) {
  const current = new Set((tracks || []).map((track) => track.trackId));
  const ranked = (rankedTrackIds || []).filter((trackId) => current.has(trackId));
  const rankedSet = new Set(ranked);
  const unranked = (tracks || []).map((track) => track.trackId).filter((trackId) => !rankedSet.has(trackId));
  return { ranked, unranked };
};

module.exports = mongoose.model("TrackRanking", trackRankingSchema);
