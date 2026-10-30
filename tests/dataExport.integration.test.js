const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { once } = require("node:events");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const AlbumCatalog = require("../models/AlbumCatalog");
const Board = require("../models/Board");
const BoardItem = require("../models/BoardItem");
const BoardListen = require("../models/BoardListen");
const Listen = require("../models/Listen");
const Review = require("../models/Reviews");
const UserProfile = require("../models/UserProfile");
const { formatBoards } = require("../routes/utils/boardLibrary");

const enabled = process.env.RUN_MONGO_INTEGRATION === "true";
const models = [AlbumCatalog, Board, BoardItem, BoardListen, Listen, Review, UserProfile];
let replSet;
let server;
let baseUrl;
let owner;
let albums;
let previousFlag;

async function request(path, userId = owner) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { "x-test-user": userId } });
  const text = Buffer.from(await response.arrayBuffer()).toString("utf8");
  return { status: response.status, text, body: response.headers.get("content-type")?.startsWith("application/json") ? JSON.parse(text) : null };
}
function ids(list) { return list.map((album) => album.albumId); }
function at(minute) { return new Date(Date.UTC(2026, 0, 1, 0, minute)); }
function noInternalIds(text, docs) {
  assert.equal(text.includes("\"_id\""), false);
  assert.equal(text.includes("albumCatalogId"), false);
  for (const doc of docs) assert.equal(text.includes(String(doc._id)), false, `exposes ${doc._id}`);
}

test.before(async () => {
  if (!enabled) return;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: "rescened_data_export" });
  await Promise.all(models.map((model) => model.syncIndexes()));
  previousFlag = process.env.DATA_EXPORT_ENABLED;
  process.env.DATA_EXPORT_ENABLED = "true";
  const clerkPath = require.resolve("@clerk/express");
  const previous = require.cache[clerkPath];
  require.cache[clerkPath] = {
    id: clerkPath, filename: clerkPath, loaded: true,
    exports: {
      getAuth: (req) => ({ userId: req.headers["x-test-user"] || null }),
      clerkClient: { users: { getUserList: async () => ({ data: [] }) } },
    },
  };
  const app = express();
  app.use(express.json());
  app.use("/profile/me/export", require("../routes/dataExport"));
  app.use("/profile", require("../routes/profile"));
  app.use("/boards", require("../routes/boards"));
  if (previous) require.cache[clerkPath] = previous;
  else delete require.cache[clerkPath];
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(async () => {
  if (!enabled) return;
  await Promise.all(models.map((model) => model.deleteMany({})));
  owner = `data-export-${crypto.randomUUID()}`;
  await UserProfile.create({ userId: owner });
  albums = await AlbumCatalog.create(Array.from({ length: 4 }, (_, index) => ({
    albumId: crypto.randomUUID(), title: `Export album ${index + 1}`, artistDisplayName: index === 0 ? "=Artist" : "An artist", catalogSource: "manual",
  })));
});

test.after(async () => {
  if (!enabled) return;
  if (previousFlag === undefined) delete process.env.DATA_EXPORT_ENABLED;
  else process.env.DATA_EXPORT_ENABLED = previousFlag;
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
});

const integration = (name, fn) => test(name, { skip: !enabled }, fn);

integration("board exports follow each board's displayed order and cover the saved shelf", async () => {
  const [first, second, third, fourth] = albums;
  const shelf = await Board.create({ userId: owner, title: "Saved albums", isDefault: true });
  const ranked = await Board.create({ userId: owner, title: "Ranked", orderMode: "manual", displayStyle: "ranked", albumOrder: [third._id, first._id] });
  const empty = await Board.create({ userId: owner, title: "Empty", description: "Later" });
  await BoardItem.insertMany([
    { userId: owner, boardId: shelf._id, albumCatalogId: first._id, savedAt: at(1) },
    { userId: owner, boardId: shelf._id, albumCatalogId: second._id, savedAt: at(2) },
    { userId: owner, boardId: ranked._id, albumCatalogId: first._id, savedAt: at(3) },
    { userId: owner, boardId: ranked._id, albumCatalogId: third._id, savedAt: at(4) },
    { userId: owner, boardId: ranked._id, albumCatalogId: second._id, savedAt: at(5) },
  ]);
  // A diary listen linked to the shelf saves its album without an explicit save.
  const linked = await Listen.create({ userId: owner, albumCatalogId: fourth._id, listenedOn: "2026-01-02" });
  await BoardListen.create({ userId: owner, boardId: shelf._id, listenId: linked._id, albumCatalogId: fourth._id, addedAt: at(6) });
  // Another user's board never appears.
  await Board.create({ userId: "someone-else", title: "Not mine" });

  const json = await request("/profile/me/export/boards.json");
  assert.equal(json.status, 200, json.text);
  noInternalIds(json.text, [shelf, ranked, empty, linked, ...albums]);
  const exported = new Map(json.body.items.map((board) => [board.boardId, board]));
  assert.deepEqual([...exported.keys()].sort(), [shelf.boardId, ranked.boardId, empty.boardId].sort());

  for (const board of [shelf, ranked, empty]) {
    const shown = await request(`/profile/${owner}/boards/${board.boardId}`);
    assert.deepEqual(ids(exported.get(board.boardId).albums), ids(shown.body.albums), `${board.title} keeps its displayed order`);
  }
  assert.deepEqual(ids(exported.get(ranked.boardId).albums), [third.albumId, first.albumId, second.albumId]);
  assert.deepEqual(exported.get(ranked.boardId).albums.map((album) => album.position), [1, 2, 3]);
  assert.deepEqual(exported.get(shelf.boardId).albums.map((album) => [album.albumId, album.explicitlySaved]), [
    [fourth.albumId, false], [second.albumId, true], [first.albumId, true],
  ]);

  const saved = await request("/profile/me/saved");
  const exportedShelf = new Set(json.body.items.flatMap((board) => ids(board.albums)));
  assert.deepEqual([...exportedShelf].sort(), ids(saved.body).sort(), "the export covers exactly the saved shelf");

  // Removing an album from one board leaves it saved, and exported, through another.
  await BoardItem.deleteOne({ boardId: shelf._id, albumCatalogId: first._id });
  const after = await request("/profile/me/export/boards.json");
  const stillSaved = new Set(after.body.items.flatMap((board) => ids(board.albums)));
  assert.ok(stillSaved.has(first.albumId));
  assert.ok(ids((await request("/profile/me/saved")).body).includes(first.albumId));

  const csv = await request("/profile/me/export/boards.csv");
  assert.equal(csv.status, 200);
  const lines = csv.text.slice(1).split("\r\n").filter(Boolean);
  assert.equal(lines.length, 1 + 2 + 3 + 1, "header, shelf memberships, ranked memberships, and the empty board");
  assert.ok(lines.some((line) => line.startsWith(`"${empty.boardId}","Empty","Later","false","added","grid","",""`)));
  assert.ok(csv.text.includes("\"'=Artist\""));
});

integration("a listen whose album was deleted is omitted and counted, while reviews keep their text", async () => {
  const [kept, deleted] = albums;
  await Listen.create([
    { userId: owner, albumCatalogId: kept._id, listenedOn: "2026-03-01", source: "automatic" },
    { userId: owner, albumCatalogId: deleted._id, listenedOn: "2026-03-02" },
    { userId: "someone-else", albumCatalogId: kept._id, listenedOn: "2026-03-03" },
  ]);
  await Review.create([
    { userId: owner, albumCatalogId: kept._id, rating: 4, reviewText: "Kept", date: at(1) },
    { userId: owner, albumCatalogId: deleted._id, rating: 2.5, reviewText: "Orphaned", date: at(2), editedAt: at(3) },
  ]);
  await AlbumCatalog.deleteOne({ _id: deleted._id });

  const listens = await request("/profile/me/export/listens.json");
  assert.equal(listens.status, 200, listens.text);
  assert.equal(listens.body.omitted, 1);
  assert.deepEqual(listens.body.items.map((item) => [item.albumId, item.listenedOn, item.source]), [[kept.albumId, "2026-03-01", "automatic"]]);
  const diary = await request("/profile/me/export/listens.csv");
  assert.equal(diary.text.slice(1).split("\r\n").filter(Boolean).length, 2);

  const reviews = await request("/profile/me/export/reviews.json");
  assert.deepEqual(reviews.body.items.map((item) => [item.reviewText, item.albumId, item.editedAt]), [
    ["Orphaned", null, at(3).toISOString()],
    ["Kept", kept.albumId, null],
  ]);
  noInternalIds(reviews.text + listens.text, albums);
});

integration("bounded board reads count the live deduplicated union and empty boards", async () => {
  const [first, second, deleted, unrelated] = albums;
  const board = await Board.create({ userId: owner, title: "Bounded", orderMode: "manual", albumOrder: [second._id, first._id] });
  const empty = await Board.create({ userId: owner, title: "Empty" });
  await BoardItem.create([
    { userId: owner, boardId: board._id, albumCatalogId: first._id, savedAt: at(5) },
    { userId: owner, boardId: board._id, albumCatalogId: deleted._id },
  ]);
  const listens = await Listen.create([
    { userId: owner, albumCatalogId: first._id, listenedOn: "2026-01-01" },
    { userId: owner, albumCatalogId: second._id, listenedOn: "2026-01-01" },
    { userId: owner, albumCatalogId: second._id, listenedOn: "2026-01-02" },
    { userId: owner, albumCatalogId: deleted._id, listenedOn: "2026-01-01" },
    { userId: "someone-else", albumCatalogId: unrelated._id, listenedOn: "2026-01-01" },
    { userId: owner, albumCatalogId: unrelated._id, listenedOn: "2026-01-01" },
  ]);
  await BoardListen.create(listens.map((listen, index) => ({
    userId: owner, boardId: board._id, listenId: listen._id, albumCatalogId: listen.albumCatalogId, addedAt: at(index),
  })));
  await Listen.deleteOne({ _id: listens[5]._id });
  await AlbumCatalog.deleteOne({ _id: deleted._id });

  const options = { albums: true, maxRows: 3, albumFields: "albumId title artistDisplayName", batchSize: 1 };
  const bounded = await formatBoards([board, empty], options);
  const displayed = await formatBoards([board, empty], { albums: true });
  assert.deepEqual(bounded.map((entry) => ids(entry.albums)), displayed.map((entry) => ids(entry.albums)));
  assert.deepEqual(ids(bounded[0].albums), [second.albumId, first.albumId]);
  assert.deepEqual(bounded[0].albums.map((album) => [album.explicitlySaved, album.savedAt.toISOString(), album.listenCount]), [
    [false, at(1).toISOString(), 2], [true, at(5).toISOString(), 1],
  ]);
  assert.deepEqual(bounded[1].albums, []);
  await assert.rejects(formatBoards([board, empty], { ...options, maxRows: 2 }), { code: "EXPORT_TOO_LARGE", status: 413 });
});
