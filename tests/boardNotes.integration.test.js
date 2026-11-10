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
const BoardItemNote = require("../models/BoardItemNote");
const BoardListen = require("../models/BoardListen");
const Listen = require("../models/Listen");
const ListenCreation = require("../models/ListenCreation");
const UserProfile = require("../models/UserProfile");
const { DiaryAlbumFence } = require("../models/AutomaticListen");
const { formatBoards, savedAlbums } = require("../routes/utils/boardLibrary");
const { serializeExport } = require("../lib/dataExport/serializers");

const enabled = process.env.RUN_MONGO_INTEGRATION === "true";
const integration = (name, fn) => test(name, { skip: !enabled }, fn);
const models = [AlbumCatalog, Board, BoardItem, BoardItemNote, BoardListen, Listen, ListenCreation, UserProfile, DiaryAlbumFence];
let replSet, server, baseUrl, owner, board, albums;
async function request(method, path, body, userId = owner) {
  const response = await fetch(`${baseUrl}${path}`, { method, headers: { "Content-Type": "application/json", "x-test-user": userId }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
const url = (target = board, album = albums[0]) => `/boards/${target.boardId}/albums/${album.albumId}/note`;
async function read(target = board) { return (await request("GET", `/boards/${target.boardId}`)).body; }
async function write(note, target = board, album = albums[0], revision) {
  return request("PATCH", url(target, album), { note, revision: revision ?? (await read(target)).revision });
}
async function attach(album = albums[0], target = board) {
  const listen = await Listen.create({ userId: owner, albumCatalogId: album._id, listenedOn: "2020-01-01" });
  await BoardListen.create({ userId: owner, boardId: target._id, albumCatalogId: album._id, listenId: listen._id });
  return listen;
}
async function save(album = albums[0], target = board) {
  return request("POST", `/boards/${target.boardId}/albums`, { albumId: album.albumId });
}
function noInternalIds(value) {
  const serialized = JSON.stringify(value);
  for (const field of ['"_id"', '"albumCatalogId"', '"interactionRevision"', String(board._id), ...albums.map((album) => String(album._id))]) assert.equal(serialized.includes(field), false, field);
}

test.before(async () => {
  if (!enabled) return;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: "rescened_board_notes" });
  await Promise.all(models.map((model) => model.syncIndexes()));
  const clerkPath = require.resolve("@clerk/express");
  const previous = require.cache[clerkPath];
  require.cache[clerkPath] = { id: clerkPath, filename: clerkPath, loaded: true, exports: {
    getAuth: (req) => ({ userId: req.headers["x-test-user"] || null }), clerkClient: { users: { getUserList: async () => ({ data: [] }) } },
  } };
  const app = express(); app.use(express.json());
  app.use("/boards", require("../routes/boards")); app.use("/profile", require("../routes/profile")); app.use("/diary", require("../routes/diary"));
  if (previous) require.cache[clerkPath] = previous; else delete require.cache[clerkPath];
  server = app.listen(0, "127.0.0.1"); await once(server, "listening"); baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(async () => {
  if (!enabled) return;
  await Promise.all(models.map((model) => model.deleteMany({})));
  owner = `notes-${crypto.randomUUID()}`;
  await UserProfile.create({ userId: owner });
  board = await Board.create({ userId: owner, title: "A board" });
  albums = await AlbumCatalog.create(["Saved", "Listened", "Both"].map((title) => ({ title, albumId: crypto.randomUUID(), artistDisplayName: "Artist", catalogSource: "manual" })));
});
test.after(async () => {
  if (!enabled) return;
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect(); if (replSet) await replSet.stop();
});

integration("notes cover saved, listen-only, and combined items without changing membership or order", async () => {
  await save(); await attach(albums[1]); await save(albums[2]); await attach(albums[2]);
  const before = await read();
  for (const album of albums) {
    const result = await write(`Note for ${album.title}`, board, album);
    assert.equal(result.status, 200, JSON.stringify(result.body)); noInternalIds(result.body);
  }
  const after = await read();
  assert.deepEqual(after.albums.map(({ note, ...album }) => album), before.albums.map(({ note, ...album }) => album));
  assert.equal(after.itemCount, before.itemCount); assert.equal(after.explicitSaveCount, 2); assert.equal(await BoardItem.countDocuments(), 2);
  assert.deepEqual(new Set(after.albums.map((album) => album.note)), new Set(albums.map((album) => `Note for ${album.title}`)));
  assert.ok(after.previewAlbums.every((album) => !Object.hasOwn(album, "note")));
  assert.ok((await savedAlbums(owner)).every((album) => !Object.hasOwn(album, "note")));
  const second = await Board.create({ userId: owner, title: "Other" }); await save(albums[0], second);
  await write("Different note", second);
  assert.equal((await read()).albums.find((album) => album.albumId === albums[0].albumId).note, "Note for Saved");
  assert.equal((await read(second)).albums[0].note, "Different note");
});

integration("notes inherit public/private board visibility and only the owner may write", async () => {
  await save(); await write("<script>plain text</script>");
  const publicRead = await request("GET", `/profile/${owner}/boards/${board.boardId}`, undefined, "");
  assert.equal(publicRead.status, 200); assert.equal(publicRead.body.albums[0].note, "<script>plain text</script>"); noInternalIds(publicRead.body);
  assert.equal((await request("PATCH", url(), { note: "bad", revision: 0 }, "")).status, 401);
  assert.equal((await request("PATCH", url(), { note: "bad", revision: 0 }, "stranger")).status, 404);
  await UserProfile.updateOne({ userId: owner }, { $set: { isPrivate: true } });
  const hidden = await request("GET", `/profile/${owner}/boards/${board.boardId}`, undefined, "stranger");
  assert.equal(hidden.status, 403); assert.equal(JSON.stringify(hidden.body).includes("plain text"), false);
  assert.equal((await read()).albums[0].note, "<script>plain text</script>");
});

integration("validation, legacy empty notes, clearing, and default aliases keep the contract", async () => {
  await save(); assert.equal((await read()).albums[0].note, "");
  for (const note of ["x".repeat(101), 3, null]) assert.equal((await write(note)).status, 400);
  const normalized = await write("  Cafe\u0301\r\n memories  "); assert.equal(normalized.body.albums[0].note, "Café memories");
  assert.equal((await write("👩🏽‍💻".repeat(100))).status, 200);
  assert.equal((await write("👩🏽‍💻".repeat(101))).status, 400);
  assert.equal((await write(" \n ")).body.albums[0].note, ""); assert.equal(await BoardItemNote.countDocuments(), 0);
  assert.equal((await write("not a member", board, albums[1])).status, 404); assert.equal(await BoardItem.countDocuments(), 1);
  const defaultSaved = await request("POST", "/boards/default/albums", { albumId: albums[1].albumId });
  const defaultBoard = { boardId: "default" };
  assert.equal(defaultSaved.status, 201); assert.equal((await write("On default", defaultBoard, albums[1])).status, 200);
});

integration("notes survive partial listen removal and explicit saves, but leave with the final membership", async () => {
  const first = await attach(); const second = await attach(); await write("Remember this");
  await request("DELETE", `/boards/${board.boardId}/listens/${first.listenId}`);
  assert.equal((await read()).albums[0].note, "Remember this");
  await request("DELETE", `/diary/${second.listenId}`);
  assert.equal((await read()).albums.length, 0); assert.equal(await BoardItemNote.countDocuments(), 0);
  const third = await attach(); await save(); await write("Saved stays");
  await request("DELETE", `/diary/${third.listenId}`);
  assert.equal((await read()).albums[0].note, "Saved stays");
  await request("DELETE", `/boards/${board.boardId}/albums/${albums[0].albumId}`);
  assert.equal(await BoardItemNote.countDocuments(), 0); await save(); assert.equal((await read()).albums[0].note, "");
  await write("Gone with board"); await request("DELETE", `/boards/${board.boardId}`); assert.equal(await BoardItemNote.countDocuments(), 0);
});

integration("stale and concurrent edits conflict; remove races never leave orphan notes", async () => {
  await save(); const revision = (await read()).revision;
  const edits = await Promise.all([write("First", board, albums[0], revision), write("Second", board, albums[0], revision)]);
  assert.deepEqual(edits.map((result) => result.status).sort(), [200, 409]);
  assert.equal(edits.find((result) => result.status === 409).body.code, "BOARD_CHANGED");
  const current = await read();
  const [written, removed] = await Promise.all([write("Racing", board, albums[0], current.revision), request("DELETE", `/boards/${board.boardId}/albums/${albums[0].albumId}`)]);
  assert.ok([200, 409].includes(written.status)); assert.equal(removed.status, 200);
  assert.equal(await BoardItemNote.countDocuments(), 0); assert.equal((await read()).albums.length, 0);
});

integration("exports include each board note, escape CSV formulas, and omit orphan/foreign notes", async () => {
  await save(); await attach(albums[1]); await write("=formula"); await write("👩🏽‍💻 note", board, albums[1]);
  await BoardItemNote.create({ userId: owner, boardId: board._id, albumCatalogId: albums[2]._id, note: "Orphan" });
  const items = await formatBoards([board], { albums: true, maxRows: 10, batchSize: 2 });
  const json = JSON.parse(serializeExport("boards", "json", { items }).body); noInternalIds(json);
  assert.deepEqual(new Set(json.items[0].albums.map((album) => album.note)), new Set(["=formula", "👩🏽‍💻 note"]));
  const csv = serializeExport("boards", "csv", { items }).body;
  assert.ok(csv.includes('"note"')); assert.ok(csv.includes('"\'=formula"')); assert.equal(csv.includes("Orphan"), false);
  await BoardItemNote.updateOne({ boardId: board._id, albumCatalogId: albums[0]._id }, { $set: { userId: "foreign" } });
  assert.equal((await read()).albums.find((album) => album.albumId === albums[0].albumId).note, "");
});
