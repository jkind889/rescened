const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeAlbum, normalizeRecent, evaluateSessions, compareAlbum } = require("../lib/listeningStudy/core");
const { album, recent, editions, tracks } = require("./fixtures/listeningStudy/synthetic");
const evaluate = (payload, defs = editions(), mode) => evaluateSessions(normalizeRecent(payload).events, defs, mode);
for (const [count, status] of [[7, "below_threshold"], [8, "would_log"], [9, "would_log"]]) {
  test(`standard threshold: ${count} distinct tracks`, () => {
    assert.equal(evaluate(recent("Study Album", Array.from({ length: count }, (_, i) => i + 1))).sessions[0].status, status);
  });
}
test("deluxe denominator is 18, requiring 15", () => {
  const result = evaluate(recent("Study Album (Deluxe)", Array.from({ length: 14 }, (_, i) => i + 1))).sessions[0];
  assert.equal(result.required, 15); assert.equal(result.status, "below_threshold");
});
test("repeats never substitute for distinct tracks; shuffle counts", () => {
  assert.equal(evaluate(recent("Study Album", [1, 1, 1, 1, 1, 1, 1, 1])).sessions[0].distinctTracks, 1);
  assert.equal(evaluate(recent("Study Album", [8, 2, 1, 7, 4, 3, 6, 5])).sessions[0].status, "would_log");
});
test("ambiguous shared title and sequence cannot select shortest edition", () => {
  const defs = editions(); defs[1].aliases.push("Study Album");
  const result = evaluate(recent("Study Album", [1, 2, 3, 4, 5, 6, 7, 8]), defs).sessions[0];
  assert.equal(result.status, "unresolved"); assert.equal(result.reason, "ambiguous_edition");
});
test("a later deluxe-only track can resolve an otherwise shared title", () => {
  const defs = editions(); defs[1].aliases.push("Study Album");
  const result = evaluate(recent("Study Album", [1, 2, 3, 11]), defs).sessions[0];
  assert.equal(result.editionId, "test:deluxe"); assert.equal(result.totalTracks, 18);
});
test("mixed-edition session remains unresolved", () => {
  const result = evaluate([recent("Study Album", [1, 2]), recent("Study Album (Deluxe)", [3, 4], 1600000400)]).sessions[0];
  assert.equal(result.reason, "mixed_editions");
});
test("shared-standard counting accepts deluxe core tracks but not bonus replacements", () => {
  const defs = editions();
  assert.equal(evaluate(recent("Study Album (Deluxe)", [1, 2, 3, 4, 5, 6, 7, 8]), defs, "standard").sessions[0].status, "would_log");
  const bonus = evaluate(recent("Study Album (Deluxe)", [11, 12, 13, 14, 15, 16, 17, 18]), defs, "standard").sessions[0];
  assert.equal(bonus.distinctTracks, 0); assert.equal(bonus.status, "below_threshold");
});
test("missing album and spelling mismatches stay unmatched; case/spacing normalize", () => {
  assert.equal(evaluate(recent("", [1])).unresolved.length, 1);
  assert.equal(evaluate(recent("Stdy Album", [1])).unresolved.length, 1);
  assert.equal(evaluate(recent("  STUDY  ALBUM ", [1])).sessions[0].distinctTracks, 1);
});
test("conflicting observed album identifiers do not fall back to names", () => {
  const defs = editions(); defs[0].mbid = "11111111-1111-1111-1111-111111111111";
  const data = recent("Study Album", [1]); data.recenttracks.track[0].album.mbid = "22222222-2222-2222-2222-222222222222";
  assert.equal(evaluate(data, defs).unresolved.length, 1);
});
test("duplicate titles on an edition cannot count multiple positions", () => {
  const defs = editions(); defs[0].tracks[1] = { ...defs[0].tracks[0] };
  assert.equal(evaluate(recent("Study Album", [1]), defs).unresolved.length, 1);
});
test("now playing and invalid timestamps never count", () => {
  const data = recent("Study Album", [1, 2, 3]);
  data.recenttracks.track[0]["@attr"] = { nowplaying: "true" };
  data.recenttracks.track[1].date.uts = "NaN";
  const parsed = normalizeRecent(data);
  assert.equal(parsed.events.length, 1); assert.equal(parsed.rejected.length, 1);
});
test("overlap, retries and reordered delayed rows reproduce the same session", () => {
  const data = recent("Study Album", [1, 2, 3, 4, 5, 6, 7, 8]);
  const reverse = structuredClone(data); reverse.recenttracks.track.reverse();
  assert.deepEqual(evaluate([data, reverse, data]), evaluate(data));
});
test("two-hour gap splits sessions; repeats inside it remain one", () => {
  assert.equal(evaluate([recent("Study Album", [1]), recent("Study Album", [2], 1600007200)]).sessions.length, 1);
  assert.equal(evaluate([recent("Study Album", [1]), recent("Study Album", [2], 1600007201)]).sessions.length, 2);
});
test("24-hour cap splits a continuously extended session", () => {
  const data = recent("Study Album", Array(14).fill(1));
  data.recenttracks.track.forEach((row, i) => { row.date.uts = String(1600000000 + i * 7200); });
  assert.equal(evaluate(data).sessions.length, 2);
});
test("album comparison detects wrong count, order, membership and identity separately", () => {
  const reference = { verified: true, artist: "Study Artist", title: "Study Album", tracks: tracks(10) };
  assert.equal(compareAlbum(reference, { payload: album("Study Album", 10) }).correct, true);
  const wrong = album("Study Album", 10); wrong.album.tracks.track.reverse();
  const scored = compareAlbum(reference, { payload: wrong });
  assert.equal(scored.membership, true); assert.equal(scored.order, false);
  assert.equal(compareAlbum(reference, { payload: album("Other", 10) }).identity, false);
  assert.equal(compareAlbum(reference, { payload: album("Study Album", 9) }).count, false);
});
test("missing metadata, provider errors and malformed tracklists are not correct", () => {
  assert.equal(normalizeAlbum({ album: { name: "X", artist: "Y" } }).status, "missing_tracklist");
  assert.equal(normalizeAlbum({ error: 6 }).status, "provider_error");
  const data = album("X", 2); delete data.album.tracks.track[0].name;
  assert.equal(normalizeAlbum(data).status, "malformed");
});
