const AlbumCatalog = require("../../models/AlbumCatalog");
const TrackRanking = require("../../models/TrackRanking");
const { normalizeCatalogAlbum } = require("./albumCatalog");
const { visibleCircleUserIds } = require("./circle");

const DUPLICATE_KEY = 11000;
// Standings from fewer distinct rankers than this are labeled "early" and never
// name a fan favorite.
const SETTLED_RANKING_COUNT = 3;
const TOP_TRACK_PREVIEW = 3;
const DEFAULT_RANKING_PAGE = 12;
const MAX_RANKING_PAGE = 24;
const ALBUM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCOPES = new Set(["community", "circle"]);

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
//
// extraMatch narrows which rankings count, e.g. to a viewer's circle or to
// everyone but the viewer.
async function communityStandings(album, extraMatch = {}) {
  const trackIds = albumTrackIds(album);
  const span = trackIds.length - 1;
  // With a single track there is nothing to order: it earns full points and
  // there are no remaining positions to share.
  const tieScore = span > 0 ? { $divide: [{ $subtract: [span, { $size: "$rankedTrackIds" }] }, 2 * span] } : 0;
  const positionScore = span > 0 ? { $divide: [{ $subtract: [span, "$position"] }, span] } : 1;
  const [totals] = await TrackRanking.aggregate([
    { $match: { ...extraMatch, albumCatalogId: album._id } },
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
  return { rankingCount: count, confidence: confidenceFor(count), tracks };
}

function confidenceFor(rankingCount) {
  return rankingCount >= SETTLED_RANKING_COUNT ? "settled" : "early";
}

// Standard competition positions over sorted standings: tracks with the same
// score share a position and the next distinct score skips ahead (1, 1, 3).
function communityPositions(tracks) {
  const positions = new Map();
  tracks.forEach((entry, index) => {
    const previous = tracks[index - 1];
    positions.set(entry.trackId, previous && previous.score === entry.score ? positions.get(previous.trackId) : index + 1);
  });
  return positions;
}

// Ranks 1..n with tied values sharing their average rank.
function averageRanks(values) {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = new Array(values.length);
  for (let start = 0; start < order.length;) {
    let end = start;
    while (end + 1 < order.length && order[end + 1].value === order[start].value) end += 1;
    const rank = (start + end) / 2 + 1;
    for (let k = start; k <= end; k += 1) ranks[order[k].index] = rank;
    start = end + 1;
  }
  return ranks;
}

// Spearman's rho as the Pearson correlation of ranks, which handles ties.
// Returns null when either side has no variation.
function spearman(first, second) {
  const a = averageRanks(first);
  const b = averageRanks(second);
  const mean = (a.length + 1) / 2;
  let covariance = 0; let varianceA = 0; let varianceB = 0;
  for (let index = 0; index < a.length; index += 1) {
    covariance += (a[index] - mean) * (b[index] - mean);
    varianceA += (a[index] - mean) ** 2;
    varianceB += (b[index] - mean) ** 2;
  }
  return varianceA && varianceB ? covariance / Math.sqrt(varianceA * varianceB) : null;
}

// Compares the viewer's ranked tracks with standings from everyone else.
// delta is communityPosition − viewerPosition: positive when the viewer puts a
// track higher than other listeners do. agreement maps Spearman's rho over the
// viewer's ranked tracks to 0–100 and needs at least three of them.
function compareWithCommunity(rankedTrackIds, standings) {
  if (!standings.rankingCount || !rankedTrackIds.length) return null;
  const positions = communityPositions(standings.tracks);
  const tracks = rankedTrackIds
    .filter((trackId) => positions.has(trackId))
    .map((trackId, index) => {
      const communityPosition = positions.get(trackId);
      return { trackId, viewerPosition: index + 1, communityPosition, delta: communityPosition - (index + 1) };
    });
  const rho = tracks.length >= 3 ? spearman(tracks.map((track) => track.viewerPosition), tracks.map((track) => track.communityPosition)) : null;
  const hottest = tracks.reduce((best, track) => (Math.abs(track.delta) > Math.abs(best?.delta || 0) ? track : best), null);
  return {
    rankingCount: standings.rankingCount,
    confidence: standings.confidence,
    agreement: rho === null ? null : Math.round(((rho + 1) / 2) * 100),
    hottestTake: hottest,
    tracks,
  };
}

function parseScope(value) {
  if (value === undefined) return "community";
  if (typeof value !== "string" || !SCOPES.has(value)) {
    throw rankingError(400, "INVALID_TRACK_RANKING_REQUEST", "scope must be community or circle");
  }
  return value;
}

// Standings for an album plus the viewer's own ranking. The community scope also
// compares the viewer's ranking against everyone else's; the circle scope counts
// only the viewer and the public profiles they follow.
async function albumRankings(album, viewerId, scope = "community") {
  if (scope === "circle" && !viewerId) throw rankingError(401, "UNAUTHORIZED", "Sign in to see rankings from people you follow");
  const [standings, ranking] = await Promise.all([
    scope === "circle"
      ? visibleCircleUserIds(viewerId).then((userIds) => communityStandings(album, { userId: { $in: userIds } }))
      : communityStandings(album),
    viewerId ? TrackRanking.findOne({ userId: viewerId, albumCatalogId: album._id }).lean() : null,
  ]);
  const viewerRanking = serializeViewerRanking(ranking, album);
  let viewerComparison = null;
  if (scope === "community" && viewerRanking?.rankedTrackIds.length) {
    viewerComparison = compareWithCommunity(viewerRanking.rankedTrackIds, await communityStandings(album, { userId: { $ne: viewerId } }));
  }
  return { albumId: album.albumId, scope, ...standings, viewerRanking, viewerComparison };
}

// The community's clear #1, or null while standings are early or the top is tied.
async function albumTopTrack(album) {
  if (!albumTrackIds(album).length) return null;
  const { rankingCount, confidence, tracks } = await communityStandings(album);
  const [first, second] = tracks;
  if (confidence !== "settled" || !first || (second && second.score === first.score)) return null;
  const track = album.tracks.find((entry) => entry.trackId === first.trackId);
  return { trackId: first.trackId, title: track?.title || "", score: first.score, rankingCount };
}

function albumSummary(album) {
  const normalized = normalizeCatalogAlbum(album);
  if (!normalized?.albumId) return null;
  const { albumId, title, artistDisplayName, releaseYear, cover } = normalized;
  return { albumId, title, artistDisplayName, releaseYear, cover };
}

// A stored ranking read against the album's current tracklist, as a profile or
// activity entry. Rankings with no current tracks left are skipped.
function rankingEntry(row) {
  const album = albumSummary(row.album);
  if (!album) return null;
  const { ranked } = TrackRanking.reconcileWithTracklist(row.rankedTrackIds, row.album.tracks);
  if (!ranked.length) return null;
  const titles = new Map((row.album.tracks || []).map((track) => [track.trackId, track.title]));
  return {
    album,
    topTracks: ranked.slice(0, TOP_TRACK_PREVIEW).map((trackId, index) => ({ trackId, position: index + 1, title: titles.get(trackId) || "" })),
    rankedCount: ranked.length,
    trackCount: (row.album.tracks || []).length,
    updatedAt: row.updatedAt,
  };
}

function rankingRowsPipeline(match, limit) {
  return [
    { $match: match },
    { $sort: { updatedAt: -1, albumCatalogId: -1 } },
    { $lookup: { from: AlbumCatalog.collection.name, localField: "albumCatalogId", foreignField: "_id", as: "album" } },
    // Deleted catalog albums must neither produce broken links nor consume slots.
    { $unwind: "$album" },
    { $limit: limit },
    { $project: { _id: 0, userId: 1, albumCatalogId: 1, rankedTrackIds: 1, updatedAt: 1, album: 1 } },
  ];
}

function encodeRankingCursor(row) {
  return Buffer.from(JSON.stringify({ u: new Date(row.updatedAt).toISOString(), a: row.album.albumId })).toString("base64url");
}

// The cursor names the last album by its public albumId; Mongo IDs never leave
// the server.
async function decodeRankingCursor(value) {
  const invalidCursor = () => rankingError(400, "INVALID_TRACK_RANKING_CURSOR", "Ranking cursor is invalid");
  let payload;
  try {
    if (typeof value !== "string" || value.length > 512) throw new Error("cursor");
    payload = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch { throw invalidCursor(); }
  const updatedAt = new Date(payload?.u);
  if (typeof payload?.u !== "string" || !Number.isFinite(updatedAt.getTime()) || typeof payload.a !== "string" || !ALBUM_ID.test(payload.a)) {
    throw invalidCursor();
  }
  const album = await AlbumCatalog.findOne({ albumId: payload.a.toLowerCase() }).select("_id").lean();
  if (!album) throw invalidCursor();
  return { updatedAt, albumCatalogId: album._id };
}

// One user's rankings, most recently changed first, each with its top tracks.
async function listUserRankings(userId, query = {}) {
  const unknown = Object.keys(query || {}).filter((key) => !["limit", "cursor"].includes(key));
  if (unknown.length) throw rankingError(400, "INVALID_TRACK_RANKING_REQUEST", `Unsupported fields: ${unknown.join(", ")}`);
  if (query.limit !== undefined && (typeof query.limit !== "string" || !/^[1-9]\d*$/.test(query.limit))) {
    throw rankingError(400, "INVALID_TRACK_RANKING_REQUEST", "limit must be a positive integer");
  }
  const limit = Math.min(Number(query.limit || DEFAULT_RANKING_PAGE), MAX_RANKING_PAGE);
  const match = { userId };
  if (query.cursor !== undefined) {
    const cursor = await decodeRankingCursor(query.cursor);
    match.$or = [
      { updatedAt: { $lt: cursor.updatedAt } },
      { updatedAt: cursor.updatedAt, albumCatalogId: { $lt: cursor.albumCatalogId } },
    ];
  }
  const rows = await TrackRanking.aggregate(rankingRowsPipeline(match, limit + 1));
  const page = rows.slice(0, limit);
  return {
    rankings: page.map(rankingEntry).filter(Boolean),
    nextCursor: rows.length > limit ? encodeRankingCursor(page.at(-1)) : null,
  };
}

// Recent rankings by these users as activity items, newest change first.
async function getRankingActivity(userIds, limit) {
  const rows = await TrackRanking.aggregate(rankingRowsPipeline({ userId: { $in: userIds } }, limit));
  return rows.map((row) => {
    const entry = rankingEntry(row);
    if (!entry) return null;
    return {
      id: `ranking:${row.userId}:${entry.album.albumId}`,
      type: "ranked_album",
      userId: row.userId,
      createdAt: row.updatedAt,
      album: entry.album,
      topTracks: entry.topTracks,
      rankedCount: entry.rankedCount,
      trackCount: entry.trackCount,
    };
  }).filter(Boolean);
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

module.exports = {
  SETTLED_RANKING_COUNT,
  albumRankings,
  albumTopTrack,
  compareWithCommunity,
  communityPositions,
  deleteRanking,
  getRankingActivity,
  listUserRankings,
  normalizeRankingInput,
  parseScope,
  requireTracklist,
  saveRanking,
  spearman,
};
