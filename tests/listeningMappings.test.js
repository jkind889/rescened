const assert = require("node:assert/strict");
const test = require("node:test");

const moderation = require("../lib/listening/moderation");

test("moderator serialization keeps mapping evidence aggregate and excludes listener identity", () => {
  const result = moderation.serializeCase({
    caseId: "8f64f9df-d4cf-4b55-91dc-d0af36bf95ce",
    provider: "lastfm",
    artist: "Artist",
    album: "Album (Deluxe)",
    artistKey: "artist",
    albumKey: "album (deluxe)",
    status: "pending",
    revision: 2,
    encounterCount: 4,
    candidates: [{ albumId: "7f3aa2f7-b252-4b6a-91aa-4a0e2f7a2bf7", title: "Album", artistDisplayName: "Artist", catalogRevision: 3, evidence: [{ sharedTracks: 8, userId: "private", playedAt: "private" }] }],
    evidence: [{ provider: "lastfm", url: "https://last.fm/music/Artist/Album", username: "private", playedAt: "private", sharedTracks: 8 }],
  });
  assert.equal(result.encounterCount, 4);
  assert.equal(result.candidates[0].albumId, "7f3aa2f7-b252-4b6a-91aa-4a0e2f7a2bf7");
  assert.equal("userId" in result.evidence[0], false);
  assert.equal("username" in result.evidence[0], false);
  assert.equal("playedAt" in result.evidence[0], false);
});

test("public candidate rejects internal or malformed album identifiers", () => {
  assert.equal(moderation.publicCandidate({ _id: "private", title: "Album" }), null);
  assert.equal(moderation.publicCandidate({ albumId: "7f3aa2f7-b252-4b6a-91aa-4a0e2f7a2bf7", title: "Album", artistDisplayName: "Artist", catalogRevision: 2 }).albumId, "7f3aa2f7-b252-4b6a-91aa-4a0e2f7a2bf7");
});

test("catalog search uses local catalog fields and returns only public IDs", async () => {
  const AlbumCatalog = require("../models/AlbumCatalog");
  const original = AlbumCatalog.find;
  try {
    AlbumCatalog.find = () => ({ sort() { return this; }, limit() { return this; }, exec: async () => [{ _id: "private", albumId: "7f3aa2f7-b252-4b6a-91aa-4a0e2f7a2bf7", title: "Album", artistDisplayName: "Artist", catalogRevision: 4 }] });
    const result = await moderation.catalogSearch("Album");
    assert.deepEqual(result.items, [{ albumId: "7f3aa2f7-b252-4b6a-91aa-4a0e2f7a2bf7", title: "Album", artistDisplayName: "Artist", catalogRevision: 4 }]);
  } finally { AlbumCatalog.find = original; }
});

test("typed discovery evidence and priority filtering remain moderator-safe", async () => {
  const Listening = require("../models/Listening");
  const original = Listening.MappingCase.find;
  try {
    let querySeen;
    Listening.MappingCase.find = (query) => {
      querySeen = query;
      return { sort() { return this; }, limit() { return this; }, exec: async () => [] };
    };
    const result = moderation.serializeCase({
      caseId: "8f64f9df-d4cf-4b55-91dc-d0af36bf95ce",
      artist: "Artist",
      album: "Album",
      status: "pending",
      revision: 1,
      encounterCount: 3,
      evidence: [{ sourceUrl: "https://example.com/evidence", sharedTracks: 8, missingTracks: ["Bonus"], identifierConflicts: ["mbid"], playedAt: "private" }],
    });
    assert.equal(result.evidence[0].sourceLink, "https://example.com/evidence");
    assert.equal(result.evidence[0].sharedTrackCount, 8);
    assert.deepEqual(result.evidence[0].missingTracks, ["Bonus"]);
    assert.deepEqual(result.evidence[0].identifierConflicts, ["mbid"]);
    assert.equal("playedAt" in result.evidence[0], false);
    await moderation.listCases({ priority: "high" });
    assert.deepEqual(querySeen.encounterCount, { $gte: 2 });
  } finally { Listening.MappingCase.find = original; }
});

test("moderator queue ranks distinct listeners before encounters and pages stably", async () => {
  const Listening = require("../models/Listening");
  const original = Listening.MappingCase.find;
  const originalMappings = Listening.AlbumMapping.find;
  try {
    Listening.AlbumMapping.find = () => ({ select() { return this; }, limit() { return this; }, lean: async () => [] });
    const seen = [];
    const row = { _id: "65f1a2b3c4d5e6f708192a3b", caseId: "8f64f9df-d4cf-4b55-91dc-d0af36bf95ce", artist: "Artist", album: "Album", status: "pending", revision: 1, listenerCount: 3, encounterCount: 4, updatedAt: new Date("2026-09-30T12:00:00Z") };
    Listening.MappingCase.find = (query) => {
      const entry = { query };
      seen.push(entry);
      return { sort(order) { entry.sort = order; return this; }, limit() { return this; }, exec: async () => [row, { ...row, _id: "65f1a2b3c4d5e6f708192a3c" }] };
    };
    const first = await moderation.listCases({ status: "pending", limit: 1 });
    assert.deepEqual(seen[0].sort, { listenerCount: -1, encounterCount: -1, updatedAt: 1, _id: 1 });
    assert.equal(first.items[0].listenerCount, 3);
    assert.ok(first.nextCursor);
    await moderation.listCases({ status: "pending", limit: 1, cursor: first.nextCursor });
    const [after] = seen[1].query.$and;
    assert.deepEqual(after.$or[0], { listenerCount: { $lt: 3 } });
    assert.deepEqual(after.$or[1], { listenerCount: 3, encounterCount: { $lt: 4 } });
    const legacy = Buffer.from(JSON.stringify({ encounterCount: 4, updatedAt: row.updatedAt.toISOString(), id: row._id })).toString("base64url");
    await assert.rejects(moderation.listCases({ cursor: legacy }), (error) => error.code === "INVALID_CURSOR");
  } finally {
    Listening.MappingCase.find = original;
    Listening.AlbumMapping.find = originalMappings;
  }
});

test("evidence links reject javascript and credential-bearing URLs", () => {
  const result = moderation.serializeCase({
    caseId: "8f64f9df-d4cf-4b55-91dc-d0af36bf95ce",
    artist: "Artist",
    album: "Album",
    status: "pending",
    revision: 1,
    evidence: [
      { sourceUrl: "javascript:alert(1)", provider: "lastfm" },
      { sourceUrl: "https://example.com/source?token=secret", provider: "lastfm" },
      { sourceUrl: "https://musicbrainz.org/release-group/abc", provider: "musicbrainz" },
    ],
  });
  assert.equal("sourceLink" in result.evidence[0], false);
  assert.equal("sourceLink" in result.evidence[1], false);
  assert.equal(result.evidence[2].sourceLink, "https://musicbrainz.org/release-group/abc");
});

test("stale queue filtering accepts only a boolean", async () => {
  await assert.rejects(moderation.listCases({ stale: "yes" }), (error) => error.code === "INVALID_STALE");
});
