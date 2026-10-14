const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

const AlbumCatalog = require("../models/AlbumCatalog");
const Follow = require("../models/Follow");
const TrackRanking = require("../models/TrackRanking");
const UserProfile = require("../models/UserProfile");
const {
  SETTLED_RANKING_COUNT,
  albumRankings,
  albumTopTrack,
  compareWithCommunity,
  communityPositions,
  getRankingActivity,
  listUserRankings,
  parseScope,
  spearman,
} = require("../routes/utils/trackRankings");

const ALBUM_ID = "33333333-3333-4333-8333-333333333333";

function album(trackIds = ["a", "b", "c", "d"]) {
  return {
    _id: new mongoose.Types.ObjectId(),
    albumId: ALBUM_ID,
    title: "Ranked Album",
    artistDisplayName: "Artist",
    artistCredits: [],
    tracks: trackIds.map((trackId, index) => ({ trackId, discNumber: 1, trackNumber: index + 1, title: `Track ${trackId}` })),
  };
}

// Shapes the $facet output communityStandings reads: per-ranking tie shares are
// zero when every ranking lists every track, so scoreGain carries the full score.
function facet(count, gains) {
  return [{
    rankings: count ? [{ count, tieScore: 0 }] : [],
    tracks: Object.entries(gains).map(([trackId, scoreGain]) => ({ _id: trackId, rankedBy: count, positionSum: count, scoreGain })),
  }];
}

function lean(value) {
  const query = { select() { return query; }, lean: async () => value };
  return query;
}

test("community positions share ties and skip ahead", () => {
  const positions = communityPositions([
    { trackId: "a", score: 0.9 }, { trackId: "b", score: 0.9 }, { trackId: "c", score: 0.5 }, { trackId: "d", score: 0.1 },
  ]);
  assert.deepEqual([...positions], [["a", 1], ["b", 1], ["c", 3], ["d", 4]]);
});

test("spearman handles ties and returns null without variation", () => {
  assert.equal(spearman([1, 2, 3, 4], [1, 2, 3, 4]), 1);
  assert.equal(spearman([1, 2, 3], [3, 2, 1]), -1);
  assert.equal(spearman([1, 2, 3], [2, 2, 2]), null);
  assert.ok(Math.abs(spearman([1, 2, 3], [1, 1, 3]) - 0.866) < 0.001);
});

test("comparison reports deltas, agreement, and the hottest take", () => {
  const standings = {
    rankingCount: 4,
    confidence: "settled",
    tracks: [{ trackId: "a", score: 0.9 }, { trackId: "b", score: 0.6 }, { trackId: "c", score: 0.3 }, { trackId: "d", score: 0.1 }],
  };
  const comparison = compareWithCommunity(["d", "a", "b", "c"], standings);
  assert.deepEqual(comparison.tracks.map((track) => [track.trackId, track.viewerPosition, track.communityPosition, track.delta]), [
    ["d", 1, 4, 3], ["a", 2, 1, -1], ["b", 3, 2, -1], ["c", 4, 3, -1],
  ]);
  assert.equal(comparison.hottestTake.trackId, "d");
  assert.equal(comparison.agreement, 40, "rho = 1 - 6·12/(4·15) = -0.2");
  assert.equal(comparison.rankingCount, 4);

  const agreeing = compareWithCommunity(["a", "b", "c"], standings);
  assert.equal(agreeing.agreement, 100);
  assert.equal(agreeing.hottestTake, null, "no take is hot when every position matches");

  assert.equal(compareWithCommunity(["a", "b"], standings).agreement, null, "fewer than three tracks gives no agreement");
  assert.equal(compareWithCommunity(["a"], { rankingCount: 0, tracks: [] }), null);
});

test("scope accepts community or circle only", () => {
  assert.equal(parseScope(undefined), "community");
  assert.equal(parseScope("circle"), "circle");
  for (const scope of ["friends", ["circle"], ""]) {
    assert.throws(() => parseScope(scope), (error) => error.status === 400 && error.code === "INVALID_TRACK_RANKING_REQUEST");
  }
});

test("standings are early below the settled threshold and compare against everyone but the viewer", async (t) => {
  const target = album();
  const matches = [];
  t.mock.method(TrackRanking, "aggregate", async (pipeline) => {
    matches.push(pipeline[0].$match);
    return pipeline[0].$match.userId ? facet(SETTLED_RANKING_COUNT - 1, { a: 2, b: 1 }) : facet(SETTLED_RANKING_COUNT - 1, { a: 2, b: 1 });
  });
  t.mock.method(TrackRanking, "findOne", () => ({ lean: async () => ({ rankedTrackIds: ["b", "a", "c"], updatedAt: new Date() }) }));

  const result = await albumRankings(target, "viewer");
  assert.equal(result.scope, "community");
  assert.equal(result.confidence, "early");
  assert.equal(result.viewerComparison.confidence, "early");
  assert.deepEqual(matches[0], { albumCatalogId: target._id });
  assert.deepEqual(matches[1], { userId: { $ne: "viewer" }, albumCatalogId: target._id });

  const anonymous = await albumRankings(target, "");
  assert.equal(anonymous.viewerComparison, null);
});

test("circle standings need a viewer and leave out private followed profiles", async (t) => {
  const target = album();
  let match;
  t.mock.method(Follow, "find", () => lean([{ followingId: "friend" }, { followingId: "hidden" }, { followingId: "viewer" }]));
  t.mock.method(UserProfile, "find", () => lean([{ userId: "hidden" }]));
  t.mock.method(TrackRanking, "aggregate", async (pipeline) => { match = pipeline[0].$match; return facet(2, { a: 2 }); });
  t.mock.method(TrackRanking, "findOne", () => ({ lean: async () => null }));

  await assert.rejects(albumRankings(target, "", "circle"), (error) => error.status === 401);
  const result = await albumRankings(target, "viewer", "circle");
  assert.deepEqual(match, { userId: { $in: ["viewer", "friend"] }, albumCatalogId: target._id });
  assert.equal(result.scope, "circle");
  assert.equal(result.viewerComparison, null, "comparison is a community-scope feature");
});

test("a fan favorite needs settled standings and a clear #1", async (t) => {
  const target = album();
  let output = facet(SETTLED_RANKING_COUNT, { a: 3, b: 1.5 });
  t.mock.method(TrackRanking, "aggregate", async () => output);
  assert.deepEqual(await albumTopTrack(target), { trackId: "a", title: "Track a", score: 1, rankingCount: SETTLED_RANKING_COUNT });

  output = facet(SETTLED_RANKING_COUNT - 1, { a: 2 });
  assert.equal(await albumTopTrack(target), null, "early standings name no favorite");
  output = facet(SETTLED_RANKING_COUNT, { a: 2, b: 2 });
  assert.equal(await albumTopTrack(target), null, "a tie at the top names no favorite");
  assert.equal(await albumTopTrack(album([])), null);
});

test("profile ranking lists validate input before querying and page by public album IDs", async (t) => {
  const target = album();
  const updatedAt = new Date("2026-10-01T00:00:00.000Z");
  const aggregate = t.mock.method(TrackRanking, "aggregate", async () => [
    { userId: "owner", albumCatalogId: target._id, rankedTrackIds: ["c", "gone", "a"], updatedAt, album: target },
    { userId: "owner", albumCatalogId: new mongoose.Types.ObjectId(), rankedTrackIds: ["gone"], updatedAt, album: album() },
  ]);
  for (const query of [{ sort: "old" }, { limit: "0" }, { limit: "5x" }, { cursor: "not-json" }, { cursor: Buffer.from(JSON.stringify({ u: "x", a: ALBUM_ID })).toString("base64url") }]) {
    await assert.rejects(listUserRankings("owner", query), (error) => error.status === 400);
  }
  assert.equal(aggregate.mock.callCount(), 0);

  const page = await listUserRankings("owner", { limit: "1" });
  assert.equal(page.rankings.length, 1);
  assert.deepEqual(page.rankings[0].topTracks, [{ trackId: "c", position: 1, title: "Track c" }, { trackId: "a", position: 2, title: "Track a" }]);
  assert.equal(page.rankings[0].album.albumId, ALBUM_ID);
  assert.equal(Object.hasOwn(page.rankings[0].album, "tracks"), false);
  assert.deepEqual(JSON.parse(Buffer.from(page.nextCursor, "base64url").toString()), { u: updatedAt.toISOString(), a: ALBUM_ID });
  assert.equal(JSON.stringify(page).includes(String(target._id)), false);

  t.mock.method(AlbumCatalog, "findOne", () => ({ select: () => ({ lean: async () => ({ _id: target._id }) }) }));
  await listUserRankings("owner", { cursor: page.nextCursor });
  assert.deepEqual(aggregate.mock.calls.at(-1).arguments[0][0].$match.$or, [
    { updatedAt: { $lt: updatedAt } },
    { updatedAt, albumCatalogId: { $lt: target._id } },
  ]);
});

test("ranking activity skips rankings with no current tracks and exposes no Mongo IDs", async (t) => {
  const target = album();
  t.mock.method(TrackRanking, "aggregate", async () => [
    { userId: "owner", albumCatalogId: target._id, rankedTrackIds: ["b", "a", "d", "c"], updatedAt: new Date(), album: target },
    { userId: "owner", albumCatalogId: target._id, rankedTrackIds: ["removed"], updatedAt: new Date(), album: target },
  ]);
  const items = await getRankingActivity(["owner"], 20);
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "ranked_album");
  assert.equal(items[0].id, `ranking:owner:${ALBUM_ID}`);
  assert.deepEqual(items[0].topTracks.map((track) => track.trackId), ["b", "a", "d"]);
  assert.equal(items[0].rankedCount, 4);
  assert.equal(JSON.stringify(items).includes(String(target._id)), false);
});
