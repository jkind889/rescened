const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

const AlbumCatalog = require("../models/AlbumCatalog");
const Board = require("../models/Board");
const BoardItem = require("../models/BoardItem");
const BoardListen = require("../models/BoardListen");
const Follow = require("../models/Follow");
const UserProfile = require("../models/UserProfile");

const clerkPath = require.resolve("@clerk/express");
const boardRoutePath = require.resolve("../routes/boards");
const profileRoutePath = require.resolve("../routes/profile");
const BOARD_ID = "11111111-1111-4111-8111-111111111111";
const ALBUM_ID = "22222222-2222-4222-8222-222222222222";

function installClerk(t) {
  const previous = require.cache[clerkPath];
  require.cache[clerkPath] = {
    id: clerkPath,
    filename: clerkPath,
    loaded: true,
    exports: {
      getAuth: () => ({ userId: "owner" }),
      clerkClient: {
        users: {
          async getUserList() {
            return { data: [{ id: "owner", username: "owner-name", imageUrl: "https://example.test/owner.png" }] };
          },
        },
      },
    },
  };
  t.after(() => {
    if (previous) require.cache[clerkPath] = previous;
    else delete require.cache[clerkPath];
  });
}

function loadRoute(t, routePath) {
  installClerk(t);
  t.mock.method(BoardListen, "aggregate", async () => []);
  const previous = require.cache[routePath];
  delete require.cache[routePath];
  const router = require(routePath);
  t.after(() => {
    if (previous) require.cache[routePath] = previous;
    else delete require.cache[routePath];
  });
  return router;
}

async function invokeLastHandler(router, path, method, req) {
  const layer = router.stack.find((item) => item.route?.path === path && item.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} must remain registered`);
  const res = {
    statusCode: 200,
    body: null,
    status(statusCode) { this.statusCode = statusCode; return this; },
    json(body) { this.body = body; return this; },
  };
  await layer.route.stack.at(-1).handle(req, res);
  return { status: res.statusCode, body: res.body };
}

function chainQuery(value) {
  const query = {
    populate() { return query; },
    sort() { return query; },
    limit() { return query; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  };
  return query;
}

function populatedQuery(value) {
  const query = {
    populate() { return query; },
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  };
  return query;
}

function board(overrides = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    boardId: BOARD_ID,
    userId: "owner",
    title: "Essential listens",
    isDefault: false,
    createdAt: new Date("2026-09-07T12:00:00.000Z"),
    updatedAt: new Date("2026-09-07T12:00:00.000Z"),
    ...overrides,
  };
}

function catalogAlbum() {
  return {
    _id: new mongoose.Types.ObjectId(),
    albumId: ALBUM_ID,
    title: "A Catalog Album",
    artistDisplayName: "A Catalog Artist",
    artistCredits: [],
    tracks: [],
    catalogSource: "manual",
  };
}

function assertNoInternalIds(value, internalBoardId, internalItemId) {
  const serialized = JSON.stringify(value);
  assert.equal(Object.hasOwn(value, "_id"), false);
  assert.equal(serialized.includes(String(internalBoardId)), false);
  assert.equal(serialized.includes(String(internalItemId)), false);
}

test("boards receive immutable UUID-v4 public identities", () => {
  const created = new Board({ userId: "owner", title: "Essential listens" });
  const boardId = created.boardId;
  assert.equal(Board.isBoardId(created.boardId), true);
  assert.equal(Board.schema.path("boardId").options.immutable, true);
  assert.equal(created.validateSync(), undefined);

  created.$isNew = false;
  created.boardId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  assert.equal(created.boardId, boardId);

  const legacy = Board.hydrate({
    _id: new mongoose.Types.ObjectId(),
    userId: "legacy-owner",
    title: "Legacy board",
  });
  assert.equal(legacy.boardId, undefined);
  assert.equal(Object.hasOwn(legacy.toObject(), "boardId"), false);

  const invalid = new Board({ userId: "owner", title: "Essential listens", boardId: "not-a-board-id" });
  assert.ok(invalid.validateSync()?.errors.boardId);
});

test("board detail resolves a UUID and never serializes Board or BoardItem Mongo IDs", async (t) => {
  const sourceBoard = board();
  const album = catalogAlbum();
  const item = {
    _id: new mongoose.Types.ObjectId(),
    userId: "owner",
    boardId: sourceBoard._id,
    albumCatalogId: album,
    savedAt: new Date("2026-09-07T12:00:00.000Z"),
  };
  const boardFilters = [];
  const itemFilters = [];
  t.mock.method(Board, "findOne", async (filter) => {
    boardFilters.push(filter);
    return sourceBoard;
  });
  t.mock.method(BoardItem, "find", (filter) => {
    itemFilters.push(filter);
    return chainQuery([item]);
  });
  t.mock.method(BoardItem, "countDocuments", async () => 1);
  const router = loadRoute(t, boardRoutePath);

  const response = await invokeLastHandler(router, "/:boardId", "get", {
    userId: "owner",
    params: { boardId: BOARD_ID.toUpperCase() },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(boardFilters, [{ boardId: BOARD_ID, userId: "owner" }]);
  assert.deepEqual(itemFilters, [{ boardId: sourceBoard._id }]);
  assert.equal(response.body.boardId, BOARD_ID);
  assert.equal(response.body.albums[0].albumId, ALBUM_ID);
  assert.equal(Object.hasOwn(response.body.albums[0], "boardId"), false);
  assertNoInternalIds(response.body, sourceBoard._id, item._id);
});

test("the authenticated default-board alias remains available while returning its UUID", async (t) => {
  const sourceBoard = board({ isDefault: true });
  const boardFilters = [];
  t.mock.method(Board, "findOne", async (filter) => {
    boardFilters.push(filter);
    return sourceBoard;
  });
  t.mock.method(BoardItem, "find", () => chainQuery([]));
  t.mock.method(BoardItem, "countDocuments", async () => 0);
  const router = loadRoute(t, boardRoutePath);

  const response = await invokeLastHandler(router, "/:boardId", "get", {
    userId: "owner",
    params: { boardId: "default" },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(boardFilters, [{ userId: "owner", isDefault: true }]);
  assert.equal(response.body.boardId, BOARD_ID);
  assert.equal(JSON.stringify(response.body).includes(String(sourceBoard._id)), false);
});

test("album board status returns public board IDs and rejects an internal board route ID", async (t) => {
  const sourceBoard = board();
  const album = catalogAlbum();
  const item = { _id: new mongoose.Types.ObjectId(), boardId: sourceBoard, userId: "owner", albumCatalogId: album._id };
  t.mock.method(AlbumCatalog, "findOne", async (filter) => {
    assert.deepEqual(filter, { albumId: ALBUM_ID });
    return album;
  });
  t.mock.method(BoardItem, "find", () => chainQuery([item]));
  const router = loadRoute(t, boardRoutePath);

  const response = await invokeLastHandler(router, "/album/:albumId", "get", {
    userId: "owner",
    params: { albumId: ALBUM_ID },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.boards, [{ boardId: BOARD_ID, title: sourceBoard.title, isDefault: false }]);
  assertNoInternalIds(response.body, sourceBoard._id, item._id);

  let lookupAttempted = false;
  t.mock.method(Board, "findOne", async () => {
    lookupAttempted = true;
    return sourceBoard;
  });
  const rejected = await invokeLastHandler(router, "/:boardId", "get", {
    userId: "owner",
    params: { boardId: String(sourceBoard._id) },
  });
  assert.deepEqual(rejected, { status: 404, body: { error: "Board not found" } });
  assert.equal(lookupAttempted, false);
});

test("board mutations reject client-owned IDs and deletion clears a profile pin", async (t) => {
  const sourceBoard = board();
  let pinClear;
  t.mock.method(Board, "findOne", async () => sourceBoard);
  t.mock.method(Board, "findOneAndUpdate", async () => sourceBoard);
  t.mock.method(mongoose, "startSession", async () => ({ withTransaction: async (fn) => fn(), endSession: async () => {} }));
  t.mock.method(BoardListen, "deleteMany", async () => ({}));
  t.mock.method(BoardItem, "deleteMany", async () => ({}));
  t.mock.method(UserProfile, "updateMany", async (filter, update) => {
    pinClear = { filter, update };
    return {};
  });
  t.mock.method(Board, "deleteOne", async () => ({ deletedCount: 1 }));
  const router = loadRoute(t, boardRoutePath);

  for (const identity of [{ _id: String(sourceBoard._id) }, { boardId: BOARD_ID }]) {
    const rejected = await invokeLastHandler(router, "/", "post", {
      userId: "owner",
      body: { title: "Attempted override", ...identity },
    });
    assert.deepEqual(rejected, { status: 400, body: { error: "boardId is server-generated", code: "INVALID_BOARD_ID" } });
  }

  const deleted = await invokeLastHandler(router, "/:boardId", "delete", {
    userId: "owner",
    params: { boardId: BOARD_ID },
    body: {},
  });
  assert.deepEqual(deleted, { status: 200, body: { message: "Board deleted" } });
  assert.deepEqual(pinClear, {
    filter: { pinnedBoardId: sourceBoard._id },
    update: { $set: { pinnedBoardId: null } },
  });
});

test("profile pins resolve a board UUID to the internal relation and serialize a public board ID", async (t) => {
  const sourceBoard = board();
  const internalItemId = new mongoose.Types.ObjectId();
  const profile = {
    userId: "owner",
    bio: "",
    spotifyProfileUrl: "",
    isPrivate: false,
    favoriteAlbums: [],
    listeningNextAlbum: null,
    pinnedReviewId: null,
    pinnedBoardId: sourceBoard,
  };
  let boardFilter;
  let storedUpdate;
  t.mock.method(Board, "findOne", async (filter) => {
    boardFilter = filter;
    return sourceBoard;
  });
  t.mock.method(Board, "findOneAndUpdate", async () => sourceBoard);
  t.mock.method(mongoose, "startSession", async () => ({ withTransaction: async (fn) => fn(), endSession: async () => {} }));
  t.mock.method(UserProfile, "findOneAndUpdate", async (_filter, update) => {
    storedUpdate = update;
    return profile;
  });
  t.mock.method(UserProfile, "findOne", () => populatedQuery(profile));
  t.mock.method(BoardItem, "find", () => chainQuery([]));
  t.mock.method(Follow, "countDocuments", async () => 0);
  const router = loadRoute(t, profileRoutePath);

  const response = await invokeLastHandler(router, "/me", "put", {
    userId: "owner",
    body: {
      bio: "",
      spotifyProfileUrl: "",
      favoriteAlbumIds: [],
      pinnedReviewId: "",
      pinnedBoardId: BOARD_ID.toUpperCase(),
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(boardFilter, { boardId: BOARD_ID, userId: "owner" });
  assert.equal(String(storedUpdate.$set.pinnedBoardId), String(sourceBoard._id));
  assert.equal(response.body.pinnedBoard.boardId, BOARD_ID);
  assertNoInternalIds(response.body.pinnedBoard, sourceBoard._id, internalItemId);
});
