const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { once } = require("node:events");
const test = require("node:test");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const enabled = String(process.env.RUN_MONGO_INTEGRATION || "").toLowerCase() === "true";
const Listening = require("../models/Listening");
const AlbumCatalog = require("../models/AlbumCatalog");
const Listen = require("../models/Listen");
const { startAuthorization, completeAuthorization, mutateConnection } = require("../lib/listening/connections");
const { moderate } = require("../lib/listening/moderation");
const { mappingKey, normalize } = require("../lib/listening/common");

let replSet;

test.before(async () => {
  if (!enabled) return;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: "rescened_lastfm_api" });
  await Promise.all([
    Listening.Connection.syncIndexes(), Listening.AuthAttempt.syncIndexes(), Listening.Scrobble.syncIndexes(),
    Listening.MappingCase.syncIndexes(), Listening.AlbumMapping.syncIndexes(), Listening.MappingAudit.syncIndexes(),
    Listening.Job.syncIndexes(), AlbumCatalog.syncIndexes(),
  ]);
  process.env.LASTFM_CONNECTION_ENABLED = "true";
  process.env.LASTFM_PILOT_USER_IDS = "integration-user";
  process.env.ALBUM_MAPPING_MODERATION_ENABLED = "true";
  process.env.MODERATOR_USER_IDS = "integration-moderator";
});

test("the moderator queue searches across all cases before paginating", { skip: !enabled }, async (t) => {
  const clerkPath = require.resolve("@clerk/express");
  const previousClerk = require.cache[clerkPath];
  const app = express();
  try {
    require.cache[clerkPath] = {
      id: clerkPath, filename: clerkPath, loaded: true,
      exports: { getAuth: (req) => ({ userId: req.headers["x-test-user"] || null }) },
    };
    app.use("/moderation/album-mappings", require("../routes/albumMappings"));
  } finally {
    if (previousClerk) require.cache[clerkPath] = previousClerk;
    else delete require.cache[clerkPath];
  }
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const endpoint = "http://127.0.0.1:" + server.address().port + "/moderation/album-mappings";
  const moderator = "integration-moderator";
  async function request(params, userId = moderator) {
    const response = await fetch(endpoint + "?" + new URLSearchParams(params), {
      headers: userId ? { "x-test-user": userId } : {},
    });
    return { status: response.status, body: await response.json() };
  }
  async function page(params) {
    const { status, body } = await request(params);
    assert.equal(status, 200, JSON.stringify(body));
    return body;
  }
  async function seed(cases) {
    await Promise.all([Listening.MappingCase.deleteMany({}), Listening.AlbumMapping.deleteMany({})]);
    return Listening.MappingCase.insertMany(cases.map(({ album, artist = "Fixture artist", ...fields }) => ({
      caseId: crypto.randomUUID(), artist, album, key: mappingKey(artist, album), artistKey: normalize(artist), albumKey: normalize(album),
      ...fields,
    })));
  }
  const ids = (result) => result.items.map((item) => item.caseId);

  await t.test("search requires a moderator and remains readable with commands disabled", async () => {
    const flag = process.env.ALBUM_MAPPING_MODERATION_ENABLED;
    process.env.ALBUM_MAPPING_MODERATION_ENABLED = "false";
    try {
      const anonymous = await request({ q: "album" }, "");
      assert.equal(anonymous.status, 401);
      assert.equal(anonymous.body.code, "UNAUTHORIZED");
      const nonModerator = await request({ q: "album" }, "integration-user");
      assert.equal(nonModerator.status, 403);
      assert.equal(nonModerator.body.code, "MODERATOR_REQUIRED");
      assert.ok(Array.isArray((await page({ q: "album" })).items));
    } finally { process.env.ALBUM_MAPPING_MODERATION_ENABLED = flag; }
  });

  await t.test("an album at rank 24 appears on the first search page", async () => {
    const seeded = await seed(Array.from({ length: 25 }, (_, index) => ({
      album: index === 23 ? "Buried pressing" : "Popular album " + index,
      listenerCount: 25 - index, encounterCount: 25 - index,
    })));
    const unfiltered = await page({ status: "pending" });
    assert.equal(unfiltered.items.length, 20);
    assert.ok(unfiltered.nextCursor);
    assert.ok(!ids(unfiltered).includes(seeded[23].caseId));
    const found = await page({ status: "pending", q: "pressing" });
    assert.deepEqual(ids(found), [seeded[23].caseId]);
    assert.equal(found.nextCursor, null);
    assert.deepEqual(await page({ status: "pending", q: " \t\u2009 " }), unfiltered);
  });

  await t.test("search preserves listener, encounter, date, and internal ID tie-breaks", async () => {
    const earlier = new Date("2026-10-01T00:00:00Z");
    const later = new Date("2026-10-02T00:00:00Z");
    const [lowListeners, laterTie, lowEncounters, highListeners, earlierId] = await seed([
      { album: "Ranked Set extra", listenerCount: 2, encounterCount: 99, updatedAt: earlier },
      { album: "Ranked Set second ID", listenerCount: 3, encounterCount: 9, updatedAt: earlier, _id: new mongoose.Types.ObjectId("000000000000000000000002") },
      { album: "Ranked Set fourth", listenerCount: 3, encounterCount: 8, updatedAt: later },
      { album: "Ranked Set third", listenerCount: 3, encounterCount: 9, updatedAt: later },
      { album: "Ranked Set first ID", listenerCount: 3, encounterCount: 9, updatedAt: earlier, _id: new mongoose.Types.ObjectId("000000000000000000000001") },
      { album: "Unrelated top album", listenerCount: 50, encounterCount: 50 },
    ]);
    const first = await page({ q: "Ranked Set", limit: 2 });
    assert.deepEqual(ids(first), [earlierId.caseId, laterTie.caseId]);
    assert.ok(first.nextCursor);
    const second = await page({ q: "  Ｒanked\u2009Set ", limit: 2, cursor: first.nextCursor });
    assert.deepEqual(ids(second), [highListeners.caseId, lowEncounters.caseId]);
    assert.ok(second.nextCursor);
    const third = await page({ q: "Ranked Set", limit: 2, cursor: second.nextCursor });
    assert.deepEqual(ids(third), [lowListeners.caseId]);
    assert.equal(third.nextCursor, null);
    await Listening.MappingCase.deleteOne({ caseId: lowListeners.caseId });
    const exactBoundary = await page({ q: "Ranked Set", limit: 2, cursor: first.nextCursor });
    assert.deepEqual(ids(exactBoundary), ids(second));
    assert.equal(exactBoundary.nextCursor, null);
  });

  await t.test("search intersects status, encounter priority, and stale mappings", async () => {
    const [target, low, current, otherStatus, unrelated] = await seed([
      { album: "Signal remaster", status: "approved", encounterCount: 3 },
      { album: "Signal single", status: "approved", encounterCount: 1 },
      { album: "Signal original", status: "approved", encounterCount: 4 },
      { album: "Signal pending", status: "pending", encounterCount: 3 },
      { album: "Different name", status: "approved", encounterCount: 3 },
    ]);
    const albumId = crypto.randomUUID();
    await AlbumCatalog.create({ albumId, title: "Fixture album", artistDisplayName: "Fixture artist", catalogRevision: 3 });
    await Listening.AlbumMapping.insertMany([target, low, current, otherStatus, unrelated].map((row) => ({
      key: row.key, artist: row.artist, album: row.album, artistKey: row.artistKey, albumKey: row.albumKey,
      albumId, catalogRevision: row === current ? 3 : 2, reviewer: moderator, reason: "Queue filter fixture",
    })));
    const result = await page({ q: "signal", status: "approved", priority: "high", stale: "true" });
    assert.deepEqual(ids(result), [target.caseId]);
    assert.equal(result.items[0].mappingStale, true);
    assert.equal(result.nextCursor, null);
  });

  await t.test("album matching normalizes titles, preserves punctuation, and supports long Unicode cursors", async () => {
    const longQuery = "盤".repeat(200);
    const [accented, fullwidth, single, longFirst, longSecond, rawSpacing] = await seed([
      { album: "Björk’s\u2009Café (Deluxe).* [12:00]" },
      { album: "Ｆｕｌｌｗｉｄｔｈ [12:00]" },
      { album: "4" },
      { album: longQuery + " first", listenerCount: 2 },
      { album: longQuery + " second", listenerCount: 1 },
      { album: "Raw\u2028Spacing", albumKey: "legacy-spacing-key" },
      { album: "Bjo\u0308rk's Cafe (Deluxe) extra words [12:00]", artist: "Artist-only needle" },
    ]);
    for (const [q, expected] of [
      ["  BJORK's\u00a0ＣＡＦＥ (deluxe).* [12:00] ", accented],
      ["Björk’s Café (Deluxe).*", accented],
      ["fullwidth [12:00]", fullwidth],
      ["4", single],
      ["raw spacing", rawSpacing],
    ]) assert.deepEqual(ids(await page({ q })), [expected.caseId], JSON.stringify(q));
    assert.deepEqual(ids(await page({ q: "Artist-only needle" })), []);
    assert.deepEqual(ids(await page({ q: ".*[12:00]" })), []);
    const first = await page({ q: longQuery, limit: 1 });
    assert.deepEqual(ids(first), [longFirst.caseId]);
    assert.ok(first.nextCursor && first.nextCursor.length <= 512);
    const second = await page({ q: longQuery, limit: 1, cursor: first.nextCursor });
    assert.deepEqual(ids(second), [longSecond.caseId]);
    assert.equal(second.nextCursor, null);
  });

  await t.test("MongoDB matches Unicode album names and binds cursors to the normalized query", async () => {
    // Isolate the display-name regex from the normalized-key fallback.
    const [vietnamese, vietnameseDecomposed, cyrillicFirst, cyrillicSecond, iotaPlain, iotaDotted, greekFirst] = await seed([
      { album: "Việt", albumKey: "legacy-1", listenerCount: 2 },
      { album: "Vie\u0323\u0302t", artist: "Second fixture artist", albumKey: "legacy-2", listenerCount: 1 },
      { album: "Альбом один", albumKey: "legacy-3", listenerCount: 2 },
      { album: "альбом два", albumKey: "legacy-4", listenerCount: 1 },
      { album: "Iota plain", listenerCount: 2 },
      { album: "i\u0307ota dotted", listenerCount: 1 },
      { album: "Σ first", listenerCount: 2 },
      { album: "Σ second", listenerCount: 1 },
    ]);
    for (const q of ["Việt", "VIỆT", "Viet"]) {
      assert.deepEqual(ids(await page({ q })), [vietnamese.caseId, vietnameseDecomposed.caseId], q);
    }
    for (const q of ["Альбом", "альбом"]) {
      assert.deepEqual(ids(await page({ q })), [cyrillicFirst.caseId, cyrillicSecond.caseId], q);
    }
    const first = await page({ q: "Альбом", limit: 1 });
    assert.deepEqual(ids(first), [cyrillicFirst.caseId]);
    assert.ok(first.nextCursor);
    const second = await page({ q: "  Альбом ", limit: 1, cursor: first.nextCursor });
    assert.deepEqual(ids(second), [cyrillicSecond.caseId]);
    assert.equal(second.nextCursor, null);

    const greek = await page({ q: "Σ", limit: 1 });
    assert.deepEqual(ids(greek), [greekFirst.caseId]);
    const iota = await page({ q: "İota", limit: 1 });
    assert.deepEqual(ids(iota), [iotaPlain.caseId]);
    assert.deepEqual(ids(await page({ q: "i\u0307ota" })), [iotaDotted.caseId]);
    for (const [q, cursor] of [["альбом", first.nextCursor], ["ς", greek.nextCursor], ["i\u0307ota", iota.nextCursor]]) {
      assert.ok(cursor, q);
      const mismatch = await request({ q, cursor });
      assert.equal(mismatch.status, 400, q);
      assert.equal(mismatch.body.code, "INVALID_CURSOR", q);
    }
  });

  await t.test("long valid Latin queries compile and match within MongoDB's regex budget", async () => {
    const queries = ["a".repeat(200), "o".repeat(200), "u".repeat(200), "ệ".repeat(200), "ﬃ".repeat(66)];
    const fixtures = await seed(queries.map((album) => ({ album })));
    for (const [index, q] of queries.entries()) {
      assert.deepEqual(ids(await page({ q })), [fixtures[index].caseId]);
    }
  });

  await t.test("invalid search inputs and cursors return stable 400 codes", async () => {
    await seed([{ album: "Edition one" }, { album: "Edition two" }]);
    const { nextCursor } = await page({ q: "edition", limit: 1 });
    assert.ok(nextCursor);
    for (const [params, code] of [
      [[["q", "a"], ["q", "b"]], "INVALID_QUERY"],
      [{ q: "a".repeat(201) }, "INVALID_QUERY"],
      [{ q: "Ⅷ".repeat(200) }, "INVALID_QUERY"],
      [{ q: "ﬃ".repeat(67) }, "INVALID_QUERY"],
      [{ q: "nul\0byte" }, "INVALID_QUERY"],
      [{ cursor: nextCursor, q: "one" }, "INVALID_CURSOR"],
      [{ cursor: nextCursor, q: "" }, "INVALID_CURSOR"],
      [{ unknown: "1" }, "INVALID_REQUEST"],
    ]) {
      const result = await request(params);
      assert.equal(result.status, 400);
      assert.equal(result.body.code, code);
    }
  });
});

test.after(async () => {
  if (!enabled) return;
  await mongoose.disconnect();
  await replSet?.stop();
  ["LASTFM_CONNECTION_ENABLED", "LASTFM_PILOT_USER_IDS", "ALBUM_MAPPING_MODERATION_ENABLED", "MODERATOR_USER_IDS"].forEach((key) => delete process.env[key]);
});

test("connection lifecycle is revisioned and moderator mapping approval is transactional", { skip: !enabled }, async () => {
  await Promise.all([
    Listening.Connection.deleteMany({}), Listening.AuthAttempt.deleteMany({}), Listening.Scrobble.deleteMany({}),
    Listening.MappingCase.deleteMany({}), Listening.AlbumMapping.deleteMany({}), Listening.MappingAudit.deleteMany({}),
    Listening.Job.deleteMany({}), AlbumCatalog.deleteMany({}),
  ]);
  let authorizationState = "";
  const provider = {
    authorizationUrl: ({ state }) => { authorizationState = state; return "https://www.last.fm/api/auth?token=provider"; },
    getSession: async (token) => { assert.equal(token, "one-time-token"); return { username: "integration-listener" }; },
  };
  await startAuthorization({ userId: "integration-user", provider, env: { LASTFM_CONNECTION_ENABLED: "true", LASTFM_PILOT_USER_IDS: "integration-user", LASTFM_CALLBACK_URL: "https://rescened.example/account/lastfm/callback" } });
  const connected = await completeAuthorization({ userId: "integration-user", state: authorizationState, token: "one-time-token", provider, ownerExists: async () => true, env: { LASTFM_CONNECTION_ENABLED: "true", LASTFM_PILOT_USER_IDS: "integration-user" } });
  assert.equal(connected.connection.state, "active");
  const paused = await mutateConnection({ userId: "integration-user", action: "pause" });
  assert.equal(paused.connection.state, "paused");
  const resumed = await mutateConnection({ userId: "integration-user", action: "resume" });
  assert.equal(resumed.connection.state, "active");

  const albumId = "7f3aa2f7-b252-4b6a-91aa-4a0e2f7a2bf7";
  await AlbumCatalog.create({ albumId, title: "Integration Album", artistDisplayName: "Integration Artist", catalogRevision: 3 });
  const caseId = crypto.randomUUID();
  await Listening.MappingCase.create({ caseId, key: JSON.stringify(["lastfm", "integration artist", "integration album (deluxe)"]), provider: "lastfm", artist: "Integration Artist", album: "Integration Album (Deluxe)", artistKey: "integration artist", albumKey: "integration album (deluxe)", status: "pending", revision: 1, encounterCount: 2, evidence: [{ provider: "lastfm", sharedTracks: 10 }] });
  const approved = await moderate(caseId, "approve", { expectedRevision: 1, albumId, reason: "Verified against local catalog" }, "integration-moderator");
  assert.equal(approved.case.status, "approved");
  assert.equal(approved.mapping.albumId, albumId);
  assert.equal(await Listening.MappingAudit.countDocuments({ caseId }), 1);
  assert.equal(await Listening.Job.countDocuments({ type: "reprocess" }), 1);
  assert.equal(await Listen.countDocuments({}), 0);
});
