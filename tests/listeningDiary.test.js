const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const Listen = require("../models/Listen");
const BoardListen = require("../models/BoardListen");
const ListenCreation = require("../models/ListenCreation");
const { listeningDate, creationInput, isCalendarDate, fields } = require("../routes/utils/diaryValidation");
const { transaction } = require("../routes/utils/boardMutations");
const { listListens, listenCalendar } = require("../routes/utils/listeningDiary");

test("calendar dates validate leap years without converting local days to UTC", () => {
  assert.equal(isCalendarDate("2024-02-29"), true);
  for (const date of ["2025-02-29", "2024-04-31", "2024-13-01", "0000-01-01", "2024-2-02", "2024-01-01T00:00:00Z", 20240101]) {
    assert.equal(isCalendarDate(date), false);
  }
  const now = new Date("2026-01-01T10:30:00Z");
  assert.equal(listeningDate({ listenedOn: "2026-01-02", timeZone: "Pacific/Kiritimati" }, now).listenedOn, "2026-01-02");
  assert.equal(listeningDate({ listenedOn: "2025-12-31", timeZone: "Pacific/Pago_Pago" }, now).listenedOn, "2025-12-31");
  assert.throws(() => listeningDate({ listenedOn: "2026-01-01", timeZone: "Pacific/Pago_Pago" }, now), { code: "INVALID_LISTEN_DATE" });
  for (const timeZone of [undefined, "", "Moon/Base", "+02:00", {}, []]) {
    assert.throws(() => listeningDate({ listenedOn: "2020-01-01", timeZone }), { code: "INVALID_TIME_ZONE" });
  }
});

test("creation canonicalizes IDs and board sets and rejects client-owned fields", () => {
  const albumId = crypto.randomUUID();
  const boardIds = [crypto.randomUUID(), crypto.randomUUID()];
  const key = crypto.randomUUID();
  const body = { albumId, listenedOn: "2020-01-01", timeZone: "UTC", boardIds };
  const first = creationInput(body, key);
  const retry = creationInput({ ...body, albumId: albumId.toUpperCase(), boardIds: [boardIds[1], boardIds[0], boardIds[0]] }, key.toUpperCase());
  assert.equal(first.fingerprint, retry.fingerprint);
  assert.equal(first.key, retry.key);
  for (const field of ["listenId", "userId", "albumCatalogId", "_id", "rating", "reviewText", "createdAt"]) {
    assert.throws(() => creationInput({ ...body, [field]: "injected" }, key), { code: "INVALID_DIARY_REQUEST" });
  }
  assert.throws(() => creationInput(body), { code: "INVALID_IDEMPOTENCY_KEY" });
  assert.throws(() => creationInput({ ...body, boardIds: "default" }, key), { code: "INVALID_DIARY_REQUEST" });
  assert.throws(() => creationInput({ ...body, albumId: new mongoose.Types.ObjectId().toString() }, key), { code: "INVALID_ALBUM_ID" });
  for (const body of [null, [], "", 1]) assert.throws(() => fields(body, []), { code: "INVALID_DIARY_REQUEST" });
});

test("listen identities are immutable and internal relations have supporting indexes", () => {
  const listen = new Listen({ userId: "owner", albumCatalogId: new mongoose.Types.ObjectId(), listenedOn: "2020-01-01" });
  assert.equal(listen.validateSync(), undefined);
  const id = listen.listenId;
  const album = String(listen.albumCatalogId);
  listen.$isNew = false;
  listen.listenId = crypto.randomUUID();
  listen.albumCatalogId = new mongoose.Types.ObjectId();
  assert.equal(listen.listenId, id);
  assert.equal(String(listen.albumCatalogId), album);
  assert.equal(Listen.hydrate({ userId: "old" }).listenId, undefined);
  assert.ok(BoardListen.schema.indexes().some(([keys, options]) => keys.boardId === 1 && keys.listenId === 1 && options.unique));
  assert.ok(ListenCreation.schema.indexes().some(([keys, options]) => keys.userId === 1 && keys.key === 1 && options.unique));
});

test("transaction-unavailable errors cannot execute partial writes", async (t) => {
  let calls = 0;
  let ended = 0;
  t.mock.method(mongoose, "startSession", async () => ({
    async withTransaction() { throw Object.assign(new Error("Transaction numbers are only allowed on a replica set member"), { code: 20 }); },
    async endSession() { ended += 1; },
  }));
  for (const domain of ["DIARY", "BOARD"]) {
    await assert.rejects(transaction(domain, async () => { calls += 1; }), { status: 503, code: `${domain}_WRITE_UNAVAILABLE` });
  }
  assert.equal(calls, 0);
  assert.equal(ended, 2);
});

test("diary list rejects invalid filters and forged cursors before querying listens", async (t) => {
  t.mock.method(Listen, "aggregate", () => assert.fail("must validate before querying"));
  for (const query of [{ cursor: "forged" }, { cursor: [] }, { limit: "0" }, { limit: "20x" }, { from: "2025-02-29" }, { from: "2020-01-02", to: "2020-01-01" }, { userId: "someone-else" }]) {
    await assert.rejects(listListens("owner", query), (error) => error.status === 400);
  }
});

test("diary calendar validates the month before querying and groups listens by day", async (t) => {
  const aggregate = t.mock.method(Listen, "aggregate", async () => [
    { _id: new mongoose.Types.ObjectId(), listenId: "a", listenedOn: "2026-02-03", source: "manual", album: { albumId: "11111111-1111-4111-8111-111111111111", title: "One", artistDisplayName: "Artist", cover: "" } },
    { _id: new mongoose.Types.ObjectId(), listenId: "b", listenedOn: "2026-02-03", source: "automatic", album: { albumId: "22222222-2222-4222-8222-222222222222", title: "Two", artistDisplayName: "Artist", cover: "https://example.test/two.jpg" } },
    { _id: new mongoose.Types.ObjectId(), listenId: "c", listenedOn: "2026-02-17", album: { albumId: "11111111-1111-4111-8111-111111111111", title: "One", artistDisplayName: "Artist", cover: "" } },
  ]);
  for (const query of [{}, { month: "2026-13" }, { month: "2026-2" }, { month: "0000-01" }, { month: ["2026-02"] }, { month: "2026-02", userId: "other" }]) {
    await assert.rejects(listenCalendar("owner", query), (error) => error.status === 400);
  }
  assert.equal(aggregate.mock.callCount(), 0);

  const calendar = await listenCalendar("owner", { month: "2026-02" });
  assert.deepEqual(aggregate.mock.calls[0].arguments[0][0], { $match: { userId: "owner", listenedOn: { $gte: "2026-02-01", $lte: "2026-02-31" } } });
  assert.equal(calendar.total, 3);
  assert.equal(calendar.truncated, false);
  assert.equal(calendar.limit, 400);
  // Unresolvable albums are filtered out before the limit, so they cannot use up the month's quota.
  const stages = aggregate.mock.calls[0].arguments[0].map((stage) => Object.keys(stage)[0]);
  assert.ok(stages.indexOf("$unwind") < stages.indexOf("$limit"));
  assert.deepEqual(aggregate.mock.calls[0].arguments[0][stages.lastIndexOf("$match")], { $match: { "album.albumId": { $type: "string" } } });
  assert.deepEqual(calendar.days.map((day) => [day.date, day.listens.map((listen) => listen.listenId)]), [["2026-02-03", ["a", "b"]], ["2026-02-17", ["c"]]]);
  assert.deepEqual(Object.keys(calendar.days[0].listens[1].album).sort(), ["albumId", "artistDisplayName", "cover", "title"]);
  assert.equal(calendar.days[0].listens[1].source, "automatic");
  assert.equal(JSON.stringify(calendar).includes("_id"), false);
});
