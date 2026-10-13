const TrackRanking = require("../../models/TrackRanking");

const DUPLICATE_KEY = 11000;

function rankingError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function invalid(message) { return rankingError(400, "INVALID_TRACK_RANKING", message); }

function albumTrackIds(album) {
  return (album.tracks || []).map((track) => track.trackId);
}

function requireTracklist(album) {
  if (albumTrackIds(album).length === 0) {
    throw rankingError(409, "TRACKLIST_UNAVAILABLE", "This album does not have a tracklist to rank yet");
  }
}

// Accepts only { rankedTrackIds: string[] }, every entry a distinct trackId on
// the album's current tracklist. Ranking a subset (a top N) is allowed. IDs are
// matched case-insensitively and stored in the catalog's spelling.
function normalizeRankingInput(body, album) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("Request body must be an object");
  const unknown = Object.keys(body).filter((key) => key !== "rankedTrackIds");
  if (unknown.length) throw invalid(`Unsupported fields: ${unknown.join(", ")}`);
  const { rankedTrackIds } = body;
  if (!Array.isArray(rankedTrackIds) || rankedTrackIds.length === 0) throw invalid("rankedTrackIds must be a non-empty array");
  if (rankedTrackIds.length > TrackRanking.MAX_RANKED_TRACKS) {
    throw invalid(`A ranking may include at most ${TrackRanking.MAX_RANKED_TRACKS} tracks`);
  }
  if (!rankedTrackIds.every((trackId) => typeof trackId === "string" && trackId.trim())) {
    throw invalid("rankedTrackIds must contain track IDs");
  }
  const catalogIds = new Map(albumTrackIds(album).map((trackId) => [trackId.toLowerCase(), trackId]));
  const normalized = rankedTrackIds.map((trackId) => catalogIds.get(trackId.trim().toLowerCase()));
  if (normalized.includes(undefined)) throw invalid("Every ranked track must be on this album's tracklist");
  if (new Set(normalized).size !== normalized.length) throw invalid("A ranking cannot list the same track twice");
  return normalized;
}

function serializeViewerRanking(ranking, album) {
  if (!ranking) return null;
  const { ranked, unranked } = TrackRanking.reconcileWithTracklist(ranking.rankedTrackIds, album.tracks);
  return { rankedTrackIds: ranked, unrankedTrackIds: unranked, updatedAt: ranking.updatedAt };
}

const round = (value, places) => Math.round(value * 10 ** places) / 10 ** places;

// Community standings use a Borda count normalized to the current tracklist of
// N tracks. In each ranking, position p earns (N - p) / (N - 1) points: 1 for
// first, 0 for last. Tracks a ranking leaves out tie for the remaining
// positions and share their average, so a partial ranking cannot lift an
// obscure track by omitting the rest. A track's score is its mean over every
// ranking, in [0, 1]. Positions are taken after dropping tracks that are no
// longer on the album, matching what each ranker sees; rankings with no
// current tracks left are ignored. rankedBy and averagePosition describe only
// the rankings that list the track explicitly.
async function communityStandings(album) {
  const trackIds = albumTrackIds(album);
  const span = trackIds.length - 1;
  // With a single track there is nothing to order: it earns full points and
  // there are no remaining positions to share.
  const tieScore = span > 0 ? { $divide: [{ $subtract: [span, { $size: "$rankedTrackIds" }] }, 2 * span] } : 0;
  const positionScore = span > 0 ? { $divide: [{ $subtract: [span, "$position"] }, span] } : 1;
  const [totals] = await TrackRanking.aggregate([
    { $match: { albumCatalogId: album._id } },
    { $project: { rankedTrackIds: { $filter: { input: "$rankedTrackIds", cond: { $in: ["$$this", trackIds] } } } } },
    { $match: { "rankedTrackIds.0": { $exists: true } } },
    { $addFields: { tieScore } },
    {
      $facet: {
        rankings: [{ $group: { _id: null, count: { $sum: 1 }, tieScore: { $sum: "$tieScore" } } }],
        tracks: [
          { $unwind: { path: "$rankedTrackIds", includeArrayIndex: "position" } },
          {
            $group: {
              _id: "$rankedTrackIds",
              rankedBy: { $sum: 1 },
              positionSum: { $sum: { $add: ["$position", 1] } },
              // What this ranking adds beyond the tie share every ranking already gave it.
              scoreGain: { $sum: { $subtract: [positionScore, "$tieScore"] } },
            },
          },
        ],
      },
    },
  ]);
  const { count = 0, tieScore: tieTotal = 0 } = totals?.rankings[0] || {};
  const stats = new Map((totals?.tracks || []).map((entry) => [entry._id, entry]));
  const order = new Map(trackIds.map((trackId, index) => [trackId, index]));
  const tracks = trackIds
    .map((trackId) => {
      const entry = stats.get(trackId);
      return {
        trackId,
        score: count ? round((tieTotal + (entry?.scoreGain || 0)) / count, 4) : null,
        rankedBy: entry?.rankedBy || 0,
        averagePosition: entry ? round(entry.positionSum / entry.rankedBy, 2) : null,
      };
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.rankedBy - a.rankedBy || order.get(a.trackId) - order.get(b.trackId));
  return { rankingCount: count, tracks };
}

async function albumRankings(album, viewerId) {
  const [community, ranking] = await Promise.all([
    communityStandings(album),
    viewerId ? TrackRanking.findOne({ userId: viewerId, albumCatalogId: album._id }).lean() : null,
  ]);
  return { albumId: album.albumId, ...community, viewerRanking: serializeViewerRanking(ranking, album) };
}

async function saveRanking(userId, album, rankedTrackIds) {
  const filter = { userId, albumCatalogId: album._id };
  const update = { $set: { rankedTrackIds }, $setOnInsert: filter };
  const options = { upsert: true, runValidators: true };
  try {
    await TrackRanking.updateOne(filter, update, options);
  } catch (error) {
    // Two first saves can race on the unique index; the loser updates the winner's document.
    if (error?.code !== DUPLICATE_KEY) throw error;
    await TrackRanking.updateOne(filter, update, options);
  }
}

async function deleteRanking(userId, album) {
  await TrackRanking.deleteOne({ userId, albumCatalogId: album._id });
}

module.exports = { albumRankings, deleteRanking, normalizeRankingInput, requireTracklist, saveRanking };
