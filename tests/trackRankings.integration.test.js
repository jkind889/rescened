const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { once } = require("node:events");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const AlbumCatalog = require("../models/AlbumCatalog");
const TrackRanking = require("../models/TrackRanking");
const Follow = require("../models/Follow");
const UserProfile = require("../models/UserProfile");

const enabled = process.env.RUN_MONGO_INTEGRATION === "true";
let replSet;
let server;
let baseUrl;
let album;
let bare;

const integration = (name, fn) => test(name, { skip: !enabled }, fn);
const tracks = ["a", "b", "c", "d"].map((trackId, index) => ({ trackId, trackNumber: index + 1, title: `Track ${trackId}` }));

async function request(method, path, userId = "", body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-test-user": userId },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
const save = (userId, rankedTrackIds, albumId = album.albumId) => request("PUT", `/track-rankings/album/${albumId}`, userId, { rankedTrackIds });

test.before(async () => {
  if (!enabled) return;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: "rescened_track_rankings" });
  await Promise.all([AlbumCatalog.syncIndexes(), TrackRanking.syncIndexes()]);
  const clerkPath = require.resolve("@clerk/express");
  const previous = require.cache[clerkPath];
  require.cache[clerkPath] = {
    id: clerkPath, filename: clerkPath, loaded: true,
    exports: { getAuth: (req) => ({ userId: req.headers["x-test-user"] || null }) },
  };
  const app = express();
  app.use(express.json());
  app.use("/track-rankings", require("../routes/trackRankings"));
  if (previous) require.cache[clerkPath] = previous;
  else delete require.cache[clerkPath];
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(async () => {
  if (!enabled) return;
  await Promise.all([AlbumCatalog.deleteMany({}), TrackRanking.deleteMany({}), Follow.deleteMany({}), UserProfile.deleteMany({})]);
  album = await AlbumCatalog.create({ albumId: crypto.randomUUID(), title: "Ranked", artistDisplayName: "Artist", catalogSource: "manual", tracks });
  bare = await AlbumCatalog.create({ albumId: crypto.randomUUID(), title: "No tracks", artistDisplayName: "Artist", catalogSource: "manual" });
});

test.after(async () => {
  if (!enabled) return;
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
});

integration("saving, replacing, and deleting a ranking keeps one document per user and album", async () => {
  const first = await save("u1", ["c", "a"]);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.viewerRanking.rankedTrackIds, ["c", "a"]);
  assert.deepEqual(first.body.viewerRanking.unrankedTrackIds, ["b", "d"]);

  const replaced = await save("u1", ["d", "c", "b", "a"]);
  assert.deepEqual(replaced.body.viewerRanking.rankedTrackIds, ["d", "c", "b", "a"]);
  assert.equal(await TrackRanking.countDocuments({ userId: "u1" }), 1);
  assert.equal(replaced.body.rankingCount, 1);
  assert.equal("_id" in replaced.body, false);

  const removed = await request("DELETE", `/track-rankings/album/${album.albumId}`, "u1");
  assert.equal(removed.status, 200);
  assert.equal(removed.body.viewerRanking, null);
  assert.equal(removed.body.rankingCount, 0);
});

integration("concurrent first saves by one user resolve to a single ranking", async () => {
  const results = await Promise.all([save("u1", ["a"]), save("u1", ["b"]), save("u1", ["c"])]);
  assert.ok(results.every((result) => result.status === 200));
  assert.equal(await TrackRanking.countDocuments({ userId: "u1", albumCatalogId: album._id }), 1);
});

integration("community standings score every track with a Borda count normalized to the tracklist", async () => {
  await save("u1", ["b", "a", "c"]);
  await save("u2", ["b", "c"]);
  await save("u3", ["a", "b"]);

  const { status, body } = await request("GET", `/track-rankings/album/${album.albumId}`);
  assert.equal(status, 200);
  assert.equal(body.rankingCount, 3);
  assert.equal(body.viewerRanking, null);
  // Four tracks: positions earn 1, 2/3, 1/3, 0; omitted tracks share the leftover positions.
  assert.deepEqual(body.tracks, [
    { trackId: "b", score: 0.8889, rankedBy: 3, averagePosition: 1.33 },
    { trackId: "a", score: 0.6111, rankedBy: 2, averagePosition: 1.5 },
    { trackId: "c", score: 0.3889, rankedBy: 2, averagePosition: 2.5 },
    { trackId: "d", score: 0.1111, rankedBy: 0, averagePosition: null },
  ]);
});

integration("a lone partial ranking cannot outrank the consensus", async () => {
  await save("u1", ["d"]);
  await save("u2", ["b", "a", "c"]);
  await save("u3", ["b", "a", "c"]);

  const { body } = await request("GET", `/track-rankings/album/${album.albumId}`);
  assert.deepEqual(body.tracks.map(({ trackId, score }) => [trackId, score]), [
    ["b", 0.7778], ["a", 0.5556], ["c", 0.3333], ["d", 0.3333],
  ]);
});

integration("albums without rankings or a tracklist return empty standings", async () => {
  const unranked = await request("GET", `/track-rankings/album/${album.albumId}`);
  assert.equal(unranked.status, 200);
  assert.equal(unranked.body.rankingCount, 0);
  assert.deepEqual(unranked.body.tracks.map(({ trackId, score }) => [trackId, score]), [["a", null], ["b", null], ["c", null], ["d", null]]);

  const noTracklist = await request("GET", `/track-rankings/album/${bare.albumId}`);
  assert.equal(noTracklist.status, 200);
  assert.deepEqual(noTracklist.body, { albumId: bare.albumId, scope: "community", rankingCount: 0, confidence: "early", tracks: [], viewerRanking: null, viewerComparison: null });

  const invalidId = await request("GET", `/track-rankings/album/${String(album._id)}`);
  assert.equal(invalidId.status, 400);
});

integration("track IDs match case-insensitively and are stored in the catalog's spelling", async () => {
  const saved = await save("u1", ["C", " a "]);
  assert.equal(saved.status, 200);
  assert.deepEqual((await TrackRanking.findOne({ userId: "u1" }).lean()).rankedTrackIds, ["c", "a"]);
  assert.equal((await save("u1", ["a", "A"])).body.code, "INVALID_TRACK_RANKING");
});

integration("tracks removed from the album drop out of stored rankings when read", async () => {
  await save("u1", ["a", "b", "c"]);
  await AlbumCatalog.updateOne({ _id: album._id }, { $set: { tracks: [...tracks.slice(1), { trackId: "e", trackNumber: 5, title: "Bonus" }] } });

  const { body } = await request("GET", `/track-rankings/album/${album.albumId}`, "u1");
  assert.deepEqual(body.viewerRanking.rankedTrackIds, ["b", "c"]);
  assert.deepEqual(body.viewerRanking.unrankedTrackIds, ["d", "e"]);
  assert.deepEqual(body.tracks, [
    { trackId: "b", score: 1, rankedBy: 1, averagePosition: 1 },
    { trackId: "c", score: 0.6667, rankedBy: 1, averagePosition: 2 },
    { trackId: "d", score: 0.1667, rankedBy: 0, averagePosition: null },
    { trackId: "e", score: 0.1667, rankedBy: 0, averagePosition: null },
  ]);
  assert.deepEqual((await TrackRanking.findOne({ userId: "u1" }).lean()).rankedTrackIds, ["a", "b", "c"]);
});

integration("rankings with no tracks left on the album are not counted", async () => {
  await save("u1", ["a"]);
  await save("u2", ["b", "c"]);
  await AlbumCatalog.updateOne({ _id: album._id }, { $set: { tracks: tracks.slice(1) } });

  const { body } = await request("GET", `/track-rankings/album/${album.albumId}`, "u1");
  assert.equal(body.rankingCount, 1);
  assert.deepEqual(body.viewerRanking.rankedTrackIds, []);
  assert.deepEqual(body.tracks.map(({ trackId, score }) => [trackId, score]), [["b", 1], ["c", 0.5], ["d", 0]]);
});

integration("invalid rankings are rejected before any write", async () => {
  const cases = [
    [{ rankedTrackIds: [] }, "INVALID_TRACK_RANKING"],
    [{ rankedTrackIds: ["a", "a"] }, "INVALID_TRACK_RANKING"],
    [{ rankedTrackIds: ["a", "zzz"] }, "INVALID_TRACK_RANKING"],
    [{ rankedTrackIds: ["a", 5] }, "INVALID_TRACK_RANKING"],
    [{ rankedTrackIds: ["a"], userId: "someone-else" }, "INVALID_TRACK_RANKING"],
    [{ ranking: ["a"] }, "INVALID_TRACK_RANKING"],
  ];
  for (const [body, code] of cases) {
    const result = await request("PUT", `/track-rankings/album/${album.albumId}`, "u1", body);
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.equal(result.body.code, code, JSON.stringify(body));
  }

  const noTracklist = await save("u1", ["a"], bare.albumId);
  assert.equal(noTracklist.status, 409);
  assert.equal(noTracklist.body.code, "TRACKLIST_UNAVAILABLE");

  assert.equal((await save("", ["a"])).status, 401);
  assert.equal((await save("u1", ["a"], crypto.randomUUID())).status, 404);
  assert.equal((await save("u1", ["a"], String(album._id))).status, 400);
  assert.equal(await TrackRanking.countDocuments({}), 0);
});

integration("circle standings count the viewer and public followed profiles only, and comparison excludes the viewer", async () => {
  await save("viewer", ["a", "b", "c", "d"]);
  await save("friend", ["a", "b", "c", "d"]);
  await save("private-friend", ["d", "c", "b", "a"]);
  await save("stranger", ["d", "c", "b", "a"]);
  await Follow.create([{ followerId: "viewer", followingId: "friend" }, { followerId: "viewer", followingId: "private-friend" }]);
  await UserProfile.create({ userId: "private-friend", isPrivate: true });

  const circle = await request("GET", `/track-rankings/album/${album.albumId}?scope=circle`, "viewer");
  assert.equal(circle.status, 200);
  assert.equal(circle.body.scope, "circle");
  assert.equal(circle.body.rankingCount, 2, "the private follow is left out");
  assert.equal(circle.body.confidence, "early");
  assert.deepEqual(circle.body.tracks.map((track) => track.trackId), ["a", "b", "c", "d"]);
  assert.equal(circle.body.viewerComparison, null);

  const community = await request("GET", `/track-rankings/album/${album.albumId}`, "viewer");
  assert.equal(community.body.rankingCount, 4);
  assert.equal(community.body.confidence, "settled");
  assert.equal(community.body.viewerComparison.rankingCount, 3, "the viewer's own ranking is not compared with itself");
  assert.equal(community.body.viewerComparison.agreement, 0, "two of three others reversed the order, so it is fully reversed");
  assert.equal(community.body.viewerComparison.hottestTake.trackId, "a");

  assert.equal((await request("GET", `/track-rankings/album/${album.albumId}?scope=circle`)).status, 401);
  assert.equal((await request("GET", `/track-rankings/album/${album.albumId}?scope=everyone`, "viewer")).status, 400);
});
