const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { normalizeGenreDecisions } = require("../lib/genres/approval");
const { candidatesFor, editDistance } = require("../lib/genres/review");
const { validateGenreName } = require("../lib/genres/vocabulary");

function ref(name) {
  const { slug } = validateGenreName(name);
  return { genreId: crypto.randomUUID(), slug, name };
}

const hipHop = ref("Hip hop");
const jazz = ref("Jazz");
const soul = ref("Soul");
const changes = {
  additions: [
    { genre: jazz, newGenre: null },
    { genre: null, newGenre: { name: "Lo-fi hip hop", ...validateGenreName("Lo-fi hip hop"), parent: hipHop } },
  ],
  removals: [soul],
  primary: { genre: null, addIndex: 1 },
  note: "",
};

const create = { action: "create" };
const allApplied = { add: [{ decision: "apply" }, { decision: "apply", resolution: create }], remove: [{ decision: "apply" }], primary: "apply" };

test("decisions cover every proposed operation exactly once", () => {
  assert.throws(() => normalizeGenreDecisions({ ...allApplied, add: [{ decision: "apply" }] }, changes), /one decision for each of the 2 proposed additions/);
  assert.throws(() => normalizeGenreDecisions({ ...allApplied, remove: [] }, changes), /one decision for each of the 1 proposed removals/);
  assert.throws(() => normalizeGenreDecisions({ add: allApplied.add, remove: allApplied.remove }, changes), /primary must be "apply" or "skip"/);
  assert.throws(() => normalizeGenreDecisions({ ...allApplied, extra: true }, changes), /genreDecisions.extra is not allowed/);
  assert.throws(() => normalizeGenreDecisions({ ...allApplied, add: [{ decision: "maybe" }, allApplied.add[1]] }, changes), /must be "apply" or "skip"/);
  assert.throws(() => normalizeGenreDecisions({ add: [], remove: [], primary: "apply" }, { ...changes, additions: [], removals: [], primary: null }), /only used when the suggestion sets a primary/);
});

test("new names need a create or map resolution; existing genres take none", () => {
  assert.throws(() => normalizeGenreDecisions({ ...allApplied, add: [{ decision: "apply" }, { decision: "apply" }] }, changes), /resolution is required/);
  assert.throws(() => normalizeGenreDecisions({ ...allApplied, add: [{ decision: "apply", resolution: create }, allApplied.add[1]] }, changes), /only used to apply a new genre name/);
  assert.throws(() => normalizeGenreDecisions({ ...allApplied, add: [allApplied.add[0], { decision: "apply", resolution: { action: "merge" } }] }, changes), /"create" or "map"/);
  assert.throws(() => normalizeGenreDecisions({ ...allApplied, add: [allApplied.add[0], { decision: "apply", resolution: { action: "create", name: "<x>" } }] }, changes), /may contain/);
  assert.throws(() => normalizeGenreDecisions({ ...allApplied, add: [allApplied.add[0], { decision: "apply", resolution: { action: "map" } }] }, changes), /genreId must be a genre UUID/);

  const created = normalizeGenreDecisions(allApplied, changes);
  // A create keeps the proposed spelling and parent unless the moderator overrides them.
  assert.deepEqual(created.add[1].resolution, { action: "create", name: "Lo-fi hip hop", normalizedName: "lo fi hip hop", slug: "lo-fi-hip-hop", parentGenreId: hipHop.genreId });
  const renamed = normalizeGenreDecisions({ ...allApplied, add: [allApplied.add[0], { decision: "apply", resolution: { action: "create", name: "Lofi hip hop", parentGenreId: null } }] }, changes);
  assert.deepEqual(renamed.add[1].resolution, { action: "create", name: "Lofi hip hop", normalizedName: "lofi hip hop", slug: "lofi-hip-hop", parentGenreId: null });
  const mapped = normalizeGenreDecisions({ ...allApplied, add: [allApplied.add[0], { decision: "apply", resolution: { action: "map", genreId: hipHop.genreId.toUpperCase(), addAlias: true } }] }, changes);
  assert.deepEqual(mapped.add[1].resolution, { action: "map", genreId: hipHop.genreId, addAlias: true });
});

test("an approval must accept something, and a primary can't outlive its addition", () => {
  const skipAll = { add: [{ decision: "skip" }, { decision: "skip" }], remove: [{ decision: "skip" }], primary: "skip" };
  assert.throws(() => normalizeGenreDecisions(skipAll, changes), /at least one operation/);
  assert.throws(() => normalizeGenreDecisions({ ...skipAll, add: [{ decision: "apply" }, { decision: "skip" }], primary: "apply" }, changes), /its addition is skipped/);
  const partial = normalizeGenreDecisions({ ...skipAll, remove: [{ decision: "apply" }] }, changes);
  assert.deepEqual(partial, { add: [{ decision: "skip", resolution: null }, { decision: "skip", resolution: null }], remove: [{ decision: "apply" }], primary: "skip" });
});

test("moderator candidates rank exact, close-spelling, and shared-word matches", () => {
  assert.equal(editDistance("lofi", "lo fi", 2), 1);
  assert.ok(editDistance("techno", "trance", 2) > 2);
  const vocabulary = [
    { genreId: "a", slug: "hip-hop", name: "Hip hop", normalizedName: "hip hop", aliases: [{ normalizedName: "rap" }] },
    { genreId: "b", slug: "jazz-rap", name: "Jazz rap", normalizedName: "jazz rap", aliases: [] },
    { genreId: "c", slug: "shoegaze", name: "Shoegaze", normalizedName: "shoegaze", aliases: [] },
  ];
  assert.deepEqual(candidatesFor("hiphop", vocabulary).map((row) => [row.slug, row.match]), [["hip-hop", "spelling"]]);
  assert.deepEqual(candidatesFor("rap", vocabulary).map((row) => [row.slug, row.match]), [["hip-hop", "exact"], ["jazz-rap", "word"]]);
  assert.deepEqual(candidatesFor("shoegazer", vocabulary).map((row) => row.slug), ["shoegaze"]);
  assert.deepEqual(candidatesFor("lofi hiphop", vocabulary).map((row) => [row.slug, row.match]), [["hip-hop", "contains"]]);
  assert.deepEqual(candidatesFor("polka", vocabulary), []);
});
