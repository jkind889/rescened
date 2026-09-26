const test = require("node:test");
const assert = require("node:assert/strict");
const { createListeningMusicBrainz } = require("../lib/listening/musicBrainz");
const release = "11111111-2222-3333-4444-555555555555";
const group = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
function dependencies(raw) {
  let requests = 0; const stored = [];
  return {
    stored, get requests() { return requests; },
    options: {
      gate: async () => {}, search: { searchReleaseGroups: async () => [] },
      cache: { findOne: () => ({ lean: async () => null }), updateOne: async (key, update) => stored.push(update.$set.value) },
      fetchImpl: async () => { requests++; return { ok: true, status: 200, headers: { get: () => null }, json: async () => raw }; },
    },
  };
}
test("verified release lookup validates typed relationship and caches only normalized reusable metadata", async () => {
  const deps = dependencies({ id: release, title: "Album (Deluxe)", "release-group": { id: group }, "artist-credit": [{ name: "Artist" }], privateUnexpected: "not retained" });
  const adapter = createListeningMusicBrainz(deps.options);
  const result = await adapter.releaseRelationship(release);
  assert.equal(result.releaseMbid, release);
  assert.equal(result.releaseGroupMbid, group);
  assert.equal(result.artist, "Artist");
  assert.equal(JSON.stringify(deps.stored).includes("not retained"), false);
  assert.equal(await adapter.releaseRelationship("not-an-id"), null);
  assert.equal(deps.requests, 1);
});
test("mismatched release identities never become verified relations", async () => {
  const deps = dependencies({ id: group, title: "Album", "release-group": { id: group }, "artist-credit": [{ name: "Artist" }] });
  await assert.rejects(createListeningMusicBrainz(deps.options).releaseRelationship(release), /MUSICBRAINZ_INVALID_RESPONSE/);
  assert.equal(deps.stored.length, 0);
});
