const assert = require("node:assert/strict");
const test = require("node:test");
const { compareTracklists } = require("../lib/baselines/tracklistComparison");

function tracks(...discs) {
  return discs.flatMap((recordings, discIndex) => recordings.map((recordingMbid, index) => ({ discNumber: discIndex + 1, trackNumber: index + 1, title: recordingMbid.toUpperCase(), recordingMbid })));
}
const ids = (list) => list.map((track) => track.recordingMbid);

test("identical ordered tracklists are equivalent", () => {
  const result = compareTracklists(tracks(["a", "b"], ["c"]), tracks(["a", "b"], ["c"]));
  assert.equal(result.equivalent, true);
  assert.deepEqual([result.added, result.omitted, result.substituted, result.moved], [[], [], [], []]);
});

test("repeated recordings are compared by occurrence, not as a set", () => {
  const result = compareTracklists(tracks(["a", "b", "a"]), tracks(["a", "b", "b"]));
  assert.equal(result.equivalent, false);
  assert.deepEqual(result.substituted.map(({ base, other }) => [base.recordingMbid, base.trackNumber, other.recordingMbid, other.trackNumber]), [["a", 3, "b", 3]]);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.omitted, []);
});

test("reordering is reported as a move", () => {
  const result = compareTracklists(tracks(["a", "b", "c"]), tracks(["a", "c", "b"]));
  assert.equal(result.equivalent, false);
  assert.equal(result.moved.length, 1);
  assert.deepEqual([result.added, result.omitted, result.substituted], [[], [], []]);
});

test("bonus tracks are additions and missing discs are omissions", () => {
  const bonus = compareTracklists(tracks(["a", "b"]), tracks(["a", "b", "x", "y"]));
  assert.deepEqual(ids(bonus.added), ["x", "y"]);
  assert.equal(bonus.discLayoutDiffers, true);
  const abridged = compareTracklists(tracks(["a", "b"], ["c", "d"]), tracks(["a", "b"]));
  assert.deepEqual(ids(abridged.omitted), ["c", "d"]);
  assert.deepEqual(abridged.discs, { base: [2, 2], other: [2] });
});

test("the same sequence split across different discs is not equivalent", () => {
  const result = compareTracklists(tracks(["a", "b"], ["c"]), tracks(["a"], ["b", "c"]));
  assert.equal(result.equivalent, false);
  assert.equal(result.discLayoutDiffers, true);
  assert.deepEqual([result.added, result.omitted, result.substituted, result.moved], [[], [], [], []]);
});

test("input order does not matter and inputs are not mutated", () => {
  const base = tracks(["a", "b"]);
  const shuffled = [base[1], base[0]];
  const result = compareTracklists(base, shuffled);
  assert.equal(result.equivalent, true);
  assert.equal(shuffled[0].recordingMbid, "b");
});
