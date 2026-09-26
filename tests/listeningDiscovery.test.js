const test = require("node:test");
const assert = require("node:assert/strict");
const { createDiscoveryService, trackEvidence, stableEvidenceHash, simplifiedTitle } = require("../lib/listening/discovery");
const id = "aab1557c-cc11-478b-832e-60fc8046d949";
const group = "11223344-5566-7788-99aa-bbccddeeff00";
function catalog(rows) {
  return { find(filter) {
    const selected = rows.filter((row) => {
      if (filter.albumId) return filter.albumId.$in.includes(row.albumId);
      if (filter.title) return filter.title.test(row.title) && filter.artistDisplayName.test(row.artistDisplayName);
      return row.externalReferences.some((ref) => filter.externalReferences.$elemMatch.externalId.$in.includes(ref.externalId));
    });
    return { select() { return this; }, sort() { return this; }, limit() { return this; }, lean: async () => selected };
  } };
}
const row = { albumId: id, title: "Album", artistDisplayName: "Artist", catalogRevision: 2, tracks: [{ title: "One" }, { title: "Two" }], externalReferences: [{ provider: "musicbrainz", entityType: "release-group", externalId: group }] };

test("track evidence shows missing, extras, duplicate ambiguity without treating duplicates as matches", () => {
  const result = trackEvidence(["One", "One", "Bonus"], row.tracks);
  assert.deepEqual(result.duplicateTitles, ["one"]);
  assert.deepEqual(result.sharedTracks, []);
  assert.deepEqual(result.missingTracks, ["two"]);
  assert.deepEqual(result.extraTracks, ["bonus"]);
  assert.equal(result.countDifference, 1);
});

test("evidence freshness does not reopen identical reviewed metadata", () => {
  assert.equal(stableEvidenceHash({ retrievedAt: "yesterday", data: "same" }), stableEvidenceHash({ retrievedAt: "today", data: "same" }));
  assert.notEqual(stableEvidenceHash({ data: "changed" }), stableEvidenceHash({ data: "same" }));
  assert.equal(simplifiedTitle("Album (Live) (Deluxe Edition)"), "Album (Live)");
});

test("discovery distinguishes verified release links and search candidates while preserving artist identity", async () => {
  const service = createDiscoveryService({
    AlbumCatalog: catalog([row, { ...row, albumId: "ffb1557c-cc11-478b-832e-60fc8046d949", artistDisplayName: "Guest" }]),
    provider: { albumInfo: async () => ({ artist: "Artist", album: "Album (Deluxe Version)", tracks: ["One", "Two", "Bonus"], mbid: group, url: "https://www.last.fm/music/Artist/Album" }) },
    musicBrainz: { releaseRelationship: async () => ({ artist: "Artist", album: "Album (Deluxe Version)", releaseMbid: group, releaseGroupMbid: group }), searchReleaseGroups: async () => [{ externalId: group, title: "Album", artistDisplayName: "Artist" }] },
  });
  const result = await service.discover({ artist: "Artist", album: "Album (Deluxe Version)" });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].albumId, id);
  assert.equal(result.candidates[0].evidence.some((evidence) => evidence.type === "verified_release_group"), true);
  assert.equal(result.candidates[0].evidence.some((evidence) => evidence.type === "musicbrainz_search_candidate"), true);
  assert.equal(result.incomplete, false);
  assert.equal("approved" in result, false);
});

test("provider failures preserve local suggestions and signal incomplete discovery", async () => {
  const service = createDiscoveryService({ AlbumCatalog: catalog([row]), provider: { albumInfo: async () => { throw new Error("secret"); } }, musicBrainz: { searchReleaseGroups: async () => { throw new Error("secret"); } } });
  const result = await service.discover({ artist: "Artist", album: "Album" });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.incomplete, true);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});
