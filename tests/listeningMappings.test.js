const assert = require("node:assert/strict");
const crypto = require("node:crypto");
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
    assert.deepEqual(seen[0].query, { status: "pending" });
    assert.equal(first.items[0].listenerCount, 3);
    assert.ok(first.nextCursor);
    assert.equal("qHash" in JSON.parse(Buffer.from(first.nextCursor, "base64url")), false);
    await moderation.listCases({ status: "pending", limit: 1, cursor: first.nextCursor, q: " \u00a0 " });
    const [after] = seen[1].query.$and;
    assert.deepEqual(after.$or[0], { listenerCount: { $lt: 3 } });
    assert.deepEqual(after.$or[1], { listenerCount: 3, encounterCount: { $lt: 4 } });
    const searched = await moderation.listCases({ status: "pending", limit: 1, q: "Ａlbum  Name" });
    const bound = JSON.parse(Buffer.from(searched.nextCursor, "base64url"));
    assert.equal(bound.qHash, crypto.createHash("sha256").update("Album Name").digest("hex").slice(0, 32));
    const continued = await moderation.listCases({ status: "pending", limit: 1, cursor: searched.nextCursor, q: "  Album\u2009Name " });
    assert.equal(seen[3].query.$and.length, 2);
    assert.deepEqual(seen[3].query.$and[0], after);
    assert.deepEqual(seen[3].query.$and[1], seen[2].query.$and[0]);
    assert.equal(continued.nextCursor, searched.nextCursor);
    for (const [q, cursor] of [
      ["album name", searched.nextCursor],
      ["other album", searched.nextCursor],
      [" ", searched.nextCursor],
      ["Album Name", first.nextCursor],
      ["Album Name", Buffer.from(JSON.stringify({ ...bound, qHash: 7 })).toString("base64url")],
    ]) {
      await assert.rejects(moderation.listCases({ q, cursor }), { code: "INVALID_CURSOR", status: 400 });
    }
    for (const [q, variant] of [["Σ", "ς"], ["Альбом", "альбом"], ["Việt", "VIỆT"], ["İota", "i\u0307ota"]]) {
      const initial = await moderation.listCases({ limit: 1, q });
      assert.ok(initial.nextCursor);
      await assert.rejects(moderation.listCases({ q: variant, cursor: initial.nextCursor }), { code: "INVALID_CURSOR", status: 400 });
    }
    const longSearch = "盤".repeat(200);
    const longPage = await moderation.listCases({ limit: 1, q: longSearch });
    assert.ok(longPage.nextCursor.length <= 512);
    await moderation.listCases({ limit: 1, q: longSearch, cursor: longPage.nextCursor });
    const legacy = Buffer.from(JSON.stringify({ encounterCount: 4, updatedAt: row.updatedAt.toISOString(), id: row._id })).toString("base64url");
    await assert.rejects(moderation.listCases({ cursor: legacy }), (error) => error.code === "INVALID_CURSOR");
  } finally {
    Listening.MappingCase.find = original;
    Listening.AlbumMapping.find = originalMappings;
  }
});

test("queue search validates raw and normalized input before any stale mapping lookup", async (t) => {
  const { AlbumMapping, MappingCase } = require("../models/Listening");
  const staleLookup = t.mock.method(AlbumMapping, "find", () => assert.fail("unexpected stale lookup"));
  t.mock.method(MappingCase, "find", () => assert.fail("unexpected queue lookup"));
  assert.equal(moderation.normalizeQueueSearch(undefined), "");
  assert.equal(moderation.normalizeQueueSearch("\u3000 \ufeff"), "");
  assert.equal(moderation.normalizeQueueSearch(" Ｂｊｏ\u0308ｒｋ\u2009  X "), "Björk X");
  assert.equal(moderation.normalizeQueueSearch("4"), "4");
  assert.equal(moderation.normalizeQueueSearch("ﬃ".repeat(66)), "ffi".repeat(66));
  assert.equal(moderation.normalizeQueueSearch("a".repeat(200)), "a".repeat(200));
  for (const q of [null, 1, ["abc"], "x".repeat(201), "al\0bum", "Ⅷ".repeat(200), "ﬃ".repeat(67)]) {
    await assert.rejects(moderation.listCases({ q, stale: true }), { code: "INVALID_QUERY", status: 400 });
  }
  await assert.rejects(moderation.listCases({ stale: true, cursor: "bad" }), { code: "INVALID_CURSOR", status: 400 });
  assert.equal(staleLookup.mock.callCount(), 0);
});

test("queue search uses literal case-insensitive patterns on the album and normalized album key only", async (t) => {
  const { MappingCase } = require("../models/Listening");
  const find = t.mock.method(MappingCase, "find", async () => []);
  await moderation.listCases({ q: " Ｂｊｏｒｋ's Cafe (Deluxe).* [12:00] " });
  const [query] = find.mock.calls[0].arguments;
  assert.deepEqual(Object.keys(query), ["$and"]);
  assert.equal(query.$and.length, 1);
  const [display, key] = query.$and[0].$or;
  assert.deepEqual(Object.keys(display), ["album"]);
  assert.deepEqual(Object.keys(key), ["albumKey"]);
  const displayRegex = new RegExp(display.album.$regex, display.album.$options);
  const keyRegex = new RegExp(key.albumKey.$regex, key.albumKey.$options);
  assert.match("Björk’s\u2009Café\u00a0(Deluxe).*\ufeff[12:00]", displayRegex);
  assert.match("BJO\u0308RK'S CAFE (deluxe).* [12:00]", keyRegex);
  assert.doesNotMatch("Björk’s Café (Deluxe) unrelated text [12:00]", displayRegex);
  assert.doesNotMatch("Björk’s\u2009Café (Deluxe).* [12:00]", keyRegex);

  for (const q of ["Viet", "Việt"]) {
    await moderation.listCases({ q });
    const [{ album }] = find.mock.calls.at(-1).arguments[0].$and[0].$or;
    const vietnamese = new RegExp(album.$regex, album.$options);
    assert.match("Việt", vietnamese, q);
    assert.match("VIỆT", vietnamese, q);
    assert.match("Vie\u0323\u0302t", vietnamese, q);
    assert.match("Viet", vietnamese, q);
    assert.doesNotMatch("Viat", vietnamese, q);
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

test("moderator serialization passes discovery candidate coverage through", () => {
  const result = moderation.serializeCase({
    caseId: "8f64f9df-d4cf-4b55-91dc-d0af36bf95ce", provider: "lastfm", artist: "Artist", album: "Album", artistKey: "artist", albumKey: "album", status: "pending", revision: 1, encounterCount: 1,
    evidence: [{ source: "candidate_discovery", candidatesFound: 9, candidatesShown: 5, candidateLimitReached: true, candidateQueryLimitReached: false }],
  });
  assert.deepEqual(
    [result.evidence[0].candidatesFound, result.evidence[0].candidatesShown, result.evidence[0].candidateLimitReached, result.evidence[0].candidateQueryLimitReached],
    [9, 5, true, false],
  );
});
