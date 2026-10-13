const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

const TrackRanking = require("../models/TrackRanking");

function rankingOf(rankedTrackIds) {
  return new TrackRanking({
    userId: "ranker",
    albumCatalogId: new mongoose.Types.ObjectId(),
    rankedTrackIds,
  });
}

test("track rankings accept full and partial orderings", () => {
  const full = rankingOf(["t3", "t1", "t2"]);
  const partial = rankingOf(["t2"]);
  const atLimit = rankingOf(Array.from({ length: TrackRanking.MAX_RANKED_TRACKS }, (_, index) => `t${index}`));

  assert.equal(full.validateSync(), undefined);
  assert.equal(partial.validateSync(), undefined);
  assert.equal(atLimit.validateSync(), undefined);
  assert.deepEqual([...full.rankedTrackIds], ["t3", "t1", "t2"]);
});

test("track rankings reject empty, duplicate, and oversized orderings", () => {
  const empty = rankingOf([]).validateSync();
  const duplicate = rankingOf(["t1", "t2", "t1"]).validateSync();
  const oversized = rankingOf(Array.from({ length: TrackRanking.MAX_RANKED_TRACKS + 1 }, (_, index) => `t${index}`)).validateSync();

  assert.ok(empty?.errors.rankedTrackIds);
  assert.match(duplicate?.errors.rankedTrackIds.message, /same track twice/);
  assert.match(oversized?.errors.rankedTrackIds.message, /at most/);
});

test("track rankings require an owner and an album", () => {
  const validation = new TrackRanking({ rankedTrackIds: ["t1"] }).validateSync();

  assert.ok(validation?.errors.userId);
  assert.ok(validation?.errors.albumCatalogId);
});

test("track rankings allow one ranking per user per album", () => {
  const unique = TrackRanking.schema.indexes().find(([, options]) => options.unique);

  assert.deepEqual(unique?.[0], { userId: 1, albumCatalogId: 1 });
});

test("reconciling a ranking drops removed tracks and lists unranked ones in tracklist order", () => {
  const tracks = [{ trackId: "t1" }, { trackId: "t2" }, { trackId: "t4" }, { trackId: "t5" }];

  assert.deepEqual(TrackRanking.reconcileWithTracklist(["t4", "t3", "t1"], tracks), {
    ranked: ["t4", "t1"],
    unranked: ["t2", "t5"],
  });
  assert.deepEqual(TrackRanking.reconcileWithTracklist([], []), { ranked: [], unranked: [] });
});
