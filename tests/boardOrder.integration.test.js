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
const ListenCreation = require("../models/ListenCreation");
const UserProfile = require("../models/UserProfile");
const Review = require("../models/Reviews");
const { DiaryAlbumFence } = require("../models/AutomaticListen");
const { BOARD_ORDER_LIMIT } = require("../routes/utils/boardOrder");

const enabled = process.env.RUN_MONGO_INTEGRATION === "true";
const models = [AlbumCatalog, Board, BoardItem, BoardListen, Listen, ListenCreation, UserProfile, Review, DiaryAlbumFence];
let replSet;
let server;
let baseUrl;
let owner;
let albums;

async function request(method, path, options = {}) {
  const headers = { "x-test-user": options.userId === undefined ? owner : options.userId };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.key) headers["Idempotency-Key"] = options.key;
  const response = await fetch(`${baseUrl}${path}`, {
    method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { status: response.status, body: await response.json() };
}
function ids(list) { return list.map((album) => album.albumId); }
async function createAlbums(count, offset = 0) {
  return AlbumCatalog.create(Array.from({ length: count }, (_, index) => ({
    albumId: crypto.randomUUID(), title: `Ordered album ${offset + index + 1}`, artistDisplayName: "An artist", catalogSource: "manual",
  })));
}
async function createBoard(title = "Top albums") {
  const created = await request("POST", "/boards", { body: { title } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.boardId;
}
async function save(boardId, album) {
  const saved = await request("POST", `/boards/${boardId}/albums`, { body: { albumId: album.albumId } });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
}
function getBoard(boardId) { return request("GET", `/boards/${boardId}`); }
function setSettings(boardId, body) { return request("PATCH", `/boards/${boardId}`, { body }); }
function reorder(boardId, albumIds, revision) { return request("PUT", `/boards/${boardId}/order`, { body: { albumIds, revision } }); }
// Seeds saves directly so large boards stay fast; album i is saved i minutes in.
async function seedSaves(boardId, list) {
  const board = await Board.findOne({ boardId });
  await BoardItem.insertMany(list.map((album, index) => ({
    userId: owner, boardId: board._id, albumCatalogId: album._id, savedAt: new Date(Date.UTC(2026, 0, 1, 0, index)),
  })));
}
function noInternalIds(body) {
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes('"_id"'), false);
  assert.equal(serialized.includes("albumOrder"), false);
  assert.equal(serialized.includes("albumCatalogId"), false);
  assert.equal(serialized.includes("interactionRevision"), false);
  for (const album of albums) assert.equal(serialized.includes(String(album._id)), false);
}

test.before(async () => {
  if (!enabled) return;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: "rescened_board_order" });
  await Promise.all(models.map((model) => model.syncIndexes()));
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
  app.use("/boards", require("../routes/boards"));
  app.use("/diary", require("../routes/diary"));
  app.use("/profile", require("../routes/profile"));
  if (previous) require.cache[clerkPath] = previous;
  else delete require.cache[clerkPath];
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(async () => {
  if (!enabled) return;
  await Promise.all(models.map((model) => model.deleteMany({})));
  owner = `board-order-${crypto.randomUUID()}`;
  await UserProfile.create({ userId: owner });
  albums = await createAlbums(4);
});

test.after(async () => {
  if (!enabled) return;
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
});

const integration = (name, fn) => test(name, { skip: !enabled }, fn);

integration("owners switch to custom order, reorder, and new albums go to the bottom", async () => {
  const [first, second, third, fourth] = albums;
  const boardId = await createBoard();
  for (const album of [first, second, third]) await save(boardId, album);

  const manual = await setSettings(boardId, { orderMode: "manual" });
  assert.equal(manual.status, 200, JSON.stringify(manual.body));
  assert.equal(manual.body.orderMode, "manual");
  assert.equal(manual.body.displayStyle, "grid");
  let board = await getBoard(boardId);
  assert.deepEqual(ids(board.body.albums), [third.albumId, second.albumId, first.albumId], "the seeded order is the date order the board showed");
  assert.equal(board.body.revision, manual.body.revision);

  const reordered = await reorder(boardId, [first.albumId, third.albumId, second.albumId], board.body.revision);
  assert.equal(reordered.status, 200, JSON.stringify(reordered.body));
  assert.deepEqual(ids(reordered.body.albums), [first.albumId, third.albumId, second.albumId]);
  assert.deepEqual(ids(reordered.body.previewAlbums), [first.albumId, third.albumId, second.albumId]);
  assert.equal(reordered.body.orderedCount, 3);
  noInternalIds(reordered.body);

  await save(boardId, fourth);
  board = await getBoard(boardId);
  assert.deepEqual(ids(board.body.albums), [first.albumId, third.albumId, second.albumId, fourth.albumId]);

  const stale = await reorder(boardId, [fourth.albumId, first.albumId, third.albumId, second.albumId], reordered.body.revision);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "BOARD_CHANGED");
  const missing = await reorder(boardId, [first.albumId, third.albumId], board.body.revision);
  assert.equal(missing.body.code, "BOARD_CHANGED", "a reorder must list every album");
  const extra = await reorder(boardId, ids(board.body.albums).concat(crypto.randomUUID()), board.body.revision);
  assert.equal(extra.body.code, "BOARD_CHANGED");

  const ranked = await setSettings(boardId, { displayStyle: "ranked" });
  assert.equal(ranked.body.displayStyle, "ranked");
  const dated = await setSettings(boardId, { orderMode: "added" });
  assert.equal(dated.body.orderMode, "added");
  assert.equal(dated.body.displayStyle, "grid", "leaving custom order drops the ranked display");
  assert.equal((await Board.findOne({ boardId })).albumOrder, undefined);
  board = await getBoard(boardId);
  assert.deepEqual(ids(board.body.albums), [fourth.albumId, third.albumId, second.albumId, first.albumId]);
  const notManual = await reorder(boardId, ids(board.body.albums), board.body.revision);
  assert.equal(notManual.status, 400);
  assert.equal(notManual.body.code, "INVALID_BOARD_ORDER");
  const rankedDated = await setSettings(boardId, { displayStyle: "ranked" });
  assert.equal(rankedDated.status, 400);
  assert.equal(rankedDated.body.code, "INVALID_BOARD_ORDER");
});

integration("a remove racing a reorder drawn before it yields exactly one 409", async () => {
  const boardId = await createBoard();
  for (const album of albums) await save(boardId, album);
  await setSettings(boardId, { orderMode: "manual" });
  const before = await getBoard(boardId);
  const order = ids(before.body.albums).reverse();

  const [removed, reordered] = await Promise.all([
    request("DELETE", `/boards/${boardId}/albums/${order[0]}`),
    reorder(boardId, order, before.body.revision),
  ]);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  // Whichever commits first, the reorder was drawn before the removal, so the
  // reorder either loses to it, or wins and the removal still applies after.
  const after = await getBoard(boardId);
  assert.equal(ids(after.body.albums).includes(order[0]), false);
  if (reordered.status === 409) {
    assert.equal(reordered.body.code, "BOARD_CHANGED");
    assert.deepEqual(ids(after.body.albums), ids(before.body.albums).filter((id) => id !== order[0]));
  } else {
    assert.equal(reordered.status, 200, JSON.stringify(reordered.body));
    assert.deepEqual(ids(after.body.albums), order.slice(1));
  }
  const stored = (await Board.findOne({ boardId })).albumOrder.map(String);
  assert.equal(stored.length, albums.length - 1, "the removed album left the stored order");

  // Two reorders from the same read: one wins, the other gets 409.
  const results = await Promise.all([
    reorder(boardId, ids(after.body.albums).reverse(), after.body.revision),
    reorder(boardId, ids(after.body.albums), after.body.revision),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
});

integration("removing an album from one board keeps it on the shelf while another board has it", async () => {
  const [shared, other] = albums;
  const firstBoard = await createBoard("First");
  const secondBoard = await createBoard("Second");
  for (const boardId of [firstBoard, secondBoard]) {
    await save(boardId, shared);
    await save(boardId, other);
    await setSettings(boardId, { orderMode: "manual" });
  }
  assert.equal((await request("DELETE", `/boards/${firstBoard}/albums/${shared.albumId}`)).status, 200);

  const status = await request("GET", `/boards/album/${shared.albumId}`);
  assert.equal(status.body.saved, true);
  assert.deepEqual(status.body.boards.map((board) => board.boardId), [secondBoard]);
  const shelf = await request("GET", "/profile/me/saved");
  assert.ok(ids(shelf.body).includes(shared.albumId));
  assert.deepEqual(ids((await getBoard(firstBoard)).body.albums), [other.albumId]);
  assert.deepEqual(ids((await getBoard(secondBoard)).body.albums).sort(), [shared.albumId, other.albumId].sort());
});

integration("deleting a board removes its stored order with it", async () => {
  const boardId = await createBoard();
  for (const album of albums) await save(boardId, album);
  await setSettings(boardId, { orderMode: "manual", displayStyle: "ranked" });
  assert.equal((await Board.findOne({ boardId })).albumOrder.length, albums.length);
  assert.equal((await request("DELETE", `/boards/${boardId}`)).status, 200);
  assert.equal(await Board.exists({ boardId }), null);
  assert.equal(await Board.countDocuments({ albumOrder: { $in: albums.map((album) => album._id) } }), 0);
  assert.equal((await getBoard(boardId)).status, 404);
});

integration("listen links follow the order rules, and a detached album rejoins at the bottom", async () => {
  const [first, second, third] = albums;
  const boardId = await createBoard();
  await save(boardId, first);
  await save(boardId, second);
  await setSettings(boardId, { orderMode: "manual" });
  const listened = await request("POST", "/diary", {
    key: crypto.randomUUID(), body: { albumId: third.albumId, listenedOn: "2026-10-01", timeZone: "UTC", boardIds: [boardId] },
  });
  assert.equal(listened.status, 201, JSON.stringify(listened.body));
  let board = await getBoard(boardId);
  assert.deepEqual(ids(board.body.albums), [second.albumId, first.albumId, third.albumId]);

  const moved = await reorder(boardId, [third.albumId, second.albumId, first.albumId], board.body.revision);
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal((await request("DELETE", `/diary/${listened.body.listenId}`)).status, 200);
  board = await getBoard(boardId);
  assert.deepEqual(ids(board.body.albums), [second.albumId, first.albumId]);

  const again = await request("POST", "/diary", {
    key: crypto.randomUUID(), body: { albumId: third.albumId, listenedOn: "2026-10-02", timeZone: "UTC", boardIds: [boardId] },
  });
  assert.equal(again.status, 201);
  board = await getBoard(boardId);
  assert.deepEqual(ids(board.body.albums), [second.albumId, first.albumId, third.albumId], "a returning album is new, so it goes last");
});

integration("a board past the order limit cannot switch to custom order", async () => {
  const many = await createAlbums(BOARD_ORDER_LIMIT + 1, 4);
  albums.push(...many);
  const boardId = await createBoard("Everything");
  await seedSaves(boardId, many);
  const refused = await setSettings(boardId, { orderMode: "manual" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "BOARD_ORDER_LIMIT");
  const board = await Board.findOne({ boardId });
  assert.equal(board.orderMode, "added");
  assert.equal(board.albumOrder, undefined);
  const ranked = await setSettings(boardId, { orderMode: "manual", displayStyle: "ranked", title: "Renamed" });
  assert.equal(ranked.body.code, "BOARD_ORDER_LIMIT");
  assert.equal((await Board.findOne({ boardId })).title, "Everything", "a refused update changes nothing");
});

integration("a manual board that grows past the limit keeps its block, and later albums follow it", async () => {
  const many = await createAlbums(BOARD_ORDER_LIMIT, 4);
  const later = await createAlbums(2, 200);
  albums.push(...many, ...later);
  const boardId = await createBoard("Top 100");
  await seedSaves(boardId, many);
  const manual = await setSettings(boardId, { orderMode: "manual", displayStyle: "ranked" });
  assert.equal(manual.status, 200, JSON.stringify(manual.body));
  const block = ids(many);
  const reordered = await reorder(boardId, block, manual.body.revision);
  assert.equal(reordered.status, 200, JSON.stringify(reordered.body));

  await save(boardId, later[0]);
  await save(boardId, later[1]);
  let board = await getBoard(boardId);
  assert.equal(board.body.itemCount, BOARD_ORDER_LIMIT + 2);
  assert.equal(board.body.orderedCount, BOARD_ORDER_LIMIT);
  assert.deepEqual(ids(board.body.albums).slice(0, BOARD_ORDER_LIMIT), block);
  assert.deepEqual(ids(board.body.albums).slice(BOARD_ORDER_LIMIT), ids(later));
  assert.equal((await Board.findOne({ boardId })).albumOrder.length, BOARD_ORDER_LIMIT);

  // The owner can still arrange the block, and move a later album into it.
  const tooMany = await reorder(boardId, ids(board.body.albums), board.body.revision);
  assert.equal(tooMany.status, 400, "more than the limit is a malformed reorder");
  const promoted = [later[1].albumId, ...block.slice(0, -1)];
  const moved = await reorder(boardId, promoted, board.body.revision);
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  // The displaced album (seeded in January) now follows the block ahead of the newer later[0].
  assert.deepEqual(ids(moved.body.albums), [...promoted, block.at(-1), later[0].albumId]);

  // A removal leaves the block short; the next album still follows the older ones.
  await request("DELETE", `/boards/${boardId}/albums/${promoted[5]}`);
  const [last] = await createAlbums(1, 300);
  albums.push(last);
  await save(boardId, last);
  board = await getBoard(boardId);
  assert.equal(board.body.itemCount, BOARD_ORDER_LIMIT + 2);
  assert.equal(ids(board.body.albums).at(-1), last.albumId);
  assert.equal(board.body.orderedCount, BOARD_ORDER_LIMIT);
  noInternalIds(board.body);
});

integration("public board reads follow the saved order and never contain Mongo IDs", async () => {
  const [first, second, third] = albums;
  const boardId = await createBoard("Ranked");
  for (const album of [first, second, third]) await save(boardId, album);
  const manual = await setSettings(boardId, { orderMode: "manual", displayStyle: "ranked" });
  await reorder(boardId, [second.albumId, third.albumId, first.albumId], manual.body.revision);
  await request("PUT", "/profile/me", { body: { bio: "", spotifyProfileUrl: "", favoriteAlbumIds: [], pinnedReviewId: "", pinnedBoardId: boardId } });

  const visitor = `visitor-${crypto.randomUUID()}`;
  const publicBoard = await request("GET", `/profile/${owner}/boards/${boardId}`, { userId: visitor });
  assert.equal(publicBoard.status, 200, JSON.stringify(publicBoard.body));
  assert.deepEqual(ids(publicBoard.body.albums), [second.albumId, third.albumId, first.albumId]);
  assert.equal(publicBoard.body.displayStyle, "ranked");
  assert.equal(Object.hasOwn(publicBoard.body, "revision"), false);
  noInternalIds(publicBoard.body);

  const boards = await request("GET", `/profile/${owner}/boards`, { userId: visitor });
  const listed = boards.body.find((board) => board.boardId === boardId);
  assert.deepEqual(ids(listed.previewAlbums), [second.albumId, third.albumId, first.albumId]);
  noInternalIds(boards.body);

  const profile = await request("GET", `/profile/${owner}`, { userId: visitor });
  assert.deepEqual(ids(profile.body.pinnedBoard.previewAlbums), [second.albumId, third.albumId, first.albumId]);
  noInternalIds(profile.body.pinnedBoard);

  const ownerList = await request("GET", "/boards");
  noInternalIds(ownerList.body);
});
