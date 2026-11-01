const test = require("node:test");
const assert = require("node:assert/strict");
const { rediscoveryMatches } = require("../lib/listening/worker");
const { normalize } = require("../lib/listening/common");

const created = new Date("2026-11-01T12:00:00Z");
const later = new Date("2026-11-01T13:00:00Z");
const row = (caseId, album, fields = {}) => ({ caseId, artistKey: normalize("ARTMS"), album, albumKey: normalize(album), listenerCount: 1, ...fields });
const album = (title, fields = {}) => ({ title, artists: ["ARTMS"], createdAt: created, ...fields });
const ids = (matches) => matches.map((match) => match.row.caseId).sort();

test("new albums match cases by artist and exact or edition-label title", () => {
  const cases = [row("exact", "Hyper-Ego"), row("deluxe", "Hyper-Ego (Deluxe Edition)"), row("live", "Hyper-Ego (Live)"), row("other", "Something Else"), row("artist", "Hyper-Ego", { artistKey: "someone else" })];
  assert.deepEqual(ids(rediscoveryMatches(cases, [album("HYPER-EGO")])), ["deluxe", "exact"]);
});

test("any credited artist name matches", () => {
  const cases = [row("credit", "Album", { artistKey: normalize("아르테미스") })];
  assert.deepEqual(ids(rediscoveryMatches(cases, [album("Album", { artists: ["ARTMS", "아르테미스"] })])), ["credit"]);
});

test("each case keeps its newest matching album", () => {
  const [match] = rediscoveryMatches([row("a", "Album")], [album("Album", { createdAt: later }), album("Album")]);
  assert.equal(match.albumCreatedAt, later);
});

test("matches are capped per album, most-heard first", () => {
  const cases = [row("a", "Album", { listenerCount: 1 }), row("b", "Album", { listenerCount: 5 }), row("c", "Album", { listenerCount: 3 })];
  assert.deepEqual(rediscoveryMatches(cases, [album("Album")], 2).map((match) => match.row.caseId), ["b", "c"]);
});
