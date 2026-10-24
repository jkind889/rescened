const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

const AlbumCatalog = require("../models/AlbumCatalog");
const Board = require("../models/Board");
const BoardItem = require("../models/BoardItem");
const BoardListen = require("../models/BoardListen");
const Follow = require("../models/Follow");
const Listen = require("../models/Listen");
const Review = require("../models/Reviews");
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
  t.mock.method(Review, "aggregate", async () => []);
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

test("board descriptions are optional, normalized, bounded, and patchable on their own", async (t) => {
  const sourceBoard = { ...board(), description: "", save: async () => {} };
  let created;
  t.mock.method(Board, "findOne", async () => sourceBoard);
  t.mock.method(Board, "create", async (doc) => { created = doc; return { ...board(), ...doc }; });
  t.mock.method(BoardItem, "find", () => chainQuery([]));
  const router = loadRoute(t, boardRoutePath);

  const withDescription = await invokeLastHandler(router, "/", "post", {
    userId: "owner",
    body: { title: "Late night", description: "  For 2am.  \r\n\r\n\r\nQuiet ones only.  " },
  });
  assert.equal(withDescription.status, 201);
  assert.equal(created.description, "For 2am.\n\nQuiet ones only.");
  assert.equal(withDescription.body.description, "For 2am.\n\nQuiet ones only.");

  await invokeLastHandler(router, "/", "post", { userId: "owner", body: { title: "No description" } });
  assert.equal(created.description, "");

  for (const description of ["x".repeat(281), 42]) {
    const rejected = await invokeLastHandler(router, "/", "post", { userId: "owner", body: { title: "Too much", description } });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.code, "INVALID_BOARD_DESCRIPTION");
  }

  const patched = await invokeLastHandler(router, "/:boardId", "patch", {
    userId: "owner",
    params: { boardId: BOARD_ID },
    body: { description: "Only the description changes" },
  });
  assert.equal(patched.status, 200);
  assert.equal(sourceBoard.title, "Essential listens");
  assert.equal(patched.body.description, "Only the description changes");

  const empty = await invokeLastHandler(router, "/:boardId", "patch", { userId: "owner", params: { boardId: BOARD_ID }, body: {} });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.code, "INVALID_DIARY_REQUEST");
  assert.match(empty.body.error, /title or description/);
  const blankTitle = await invokeLastHandler(router, "/:boardId", "patch", { userId: "owner", params: { boardId: BOARD_ID }, body: { title: " ", description: "ok" } });
  assert.equal(blankTitle.status, 400);
});

test("the album pick route is matched before board IDs and validates its board filter first", async (t) => {
  const findOne = t.mock.method(Board, "findOne", async () => null);
  const distinct = t.mock.method(BoardItem, "distinct", async () => []);
  t.mock.method(Listen, "distinct", async () => []);
  t.mock.method(Review, "distinct", async () => []);
  const router = loadRoute(t, boardRoutePath);

  const getPaths = router.stack.filter((layer) => layer.route?.methods.get).map((layer) => layer.route.path);
  assert.ok(getPaths.indexOf("/pick") >= 0 && getPaths.indexOf("/pick") < getPaths.indexOf("/:boardId"), "/pick must be registered before /:boardId");

  const everyBoard = await invokeLastHandler(router, "/pick", "get", { userId: "owner", query: {} });
  assert.equal(everyBoard.status, 200);
  assert.deepEqual(everyBoard.body, { album: null, candidateCount: 0 });
  assert.deepEqual(distinct.mock.calls[0].arguments[1], { userId: "owner" });

  for (const boardId of ["not-a-board", "507f1f77bcf86cd799439011", [BOARD_ID, BOARD_ID]]) {
    const rejected = await invokeLastHandler(router, "/pick", "get", { userId: "owner", query: { boardId } });
    assert.equal(rejected.status, 404);
    assert.equal(rejected.body.code, "BOARD_NOT_FOUND");
  }
  assert.equal(findOne.mock.callCount(), 0);

  const unknownField = await invokeLastHandler(router, "/pick", "get", { userId: "owner", query: { userId: "someone-else" } });
  assert.equal(unknownField.status, 400);
  assert.equal(unknownField.body.code, "INVALID_DIARY_REQUEST");

  const missingBoard = await invokeLastHandler(router, "/pick", "get", { userId: "owner", query: { boardId: BOARD_ID } });
  assert.equal(missingBoard.status, 404);
  assert.deepEqual(findOne.mock.calls[0].arguments[0], { userId: "owner", boardId: BOARD_ID });
  assert.equal(distinct.mock.callCount(), 1);
});

test("profile diary calendars follow profile privacy before reading listens", async (t) => {
  let profile = { userId: "listener", isPrivate: true };
  t.mock.method(UserProfile, "exists", async () => ({ _id: new mongoose.Types.ObjectId() }));
  t.mock.method(UserProfile, "findOne", () => populatedQuery(profile));
  const aggregate = t.mock.method(Listen, "aggregate", async () => []);
  const router = loadRoute(t, profileRoutePath);

  const hidden = await invokeLastHandler(router, "/:userId/diary/calendar", "get", { params: { userId: "listener" }, query: { month: "2026-10" } });
  assert.equal(hidden.status, 403);
  assert.equal(hidden.body.isPrivate, true);
  assert.equal(aggregate.mock.callCount(), 0);

  profile = { userId: "owner", isPrivate: true };
  const own = await invokeLastHandler(router, "/:userId/diary/calendar", "get", { params: { userId: "owner" }, query: { month: "2026-10" } });
  assert.equal(own.status, 200);
  assert.deepEqual(own.body, { month: "2026-10", total: 0, limit: 400, truncated: false, days: [] });
  assert.equal(aggregate.mock.calls[0].arguments[0][0].$match.userId, "owner");

  profile = { userId: "listener", isPrivate: false };
  const invalidMonth = await invokeLastHandler(router, "/:userId/diary/calendar", "get", { params: { userId: "listener" }, query: { month: "October" } });
  assert.equal(invalidMonth.status, 400);
  assert.equal(invalidMonth.body.code, "INVALID_DIARY_REQUEST");
});

test("a manual board lists and previews albums in its saved order without exposing the order's catalog IDs", async (t) => {
  const first = catalogAlbum();
  const second = { ...catalogAlbum(), albumId: "33333333-3333-4333-8333-333333333333", title: "Second" };
  const third = { ...catalogAlbum(), albumId: "44444444-4444-4444-8444-444444444444", title: "Listen only" };
  const sourceBoard = board({ orderMode: "manual", displayStyle: "ranked", albumOrder: [first._id, second._id], interactionRevision: 7 });
  const item = (album, savedAt) => ({ _id: new mongoose.Types.ObjectId(), userId: "owner", boardId: sourceBoard._id, albumCatalogId: album, savedAt: new Date(savedAt) });
  t.mock.method(Board, "findOne", async () => sourceBoard);
  t.mock.method(BoardItem, "find", () => chainQuery([item(second, "2026-09-02"), item(first, "2026-09-01")]));
  const router = loadRoute(t, boardRoutePath);
  // A listen-only album that is not in albumOrder follows the ordered albums.
  t.mock.method(BoardListen, "aggregate", async () => [{
    _id: { board: sourceBoard._id, album: third._id, user: "owner" },
    savedAt: new Date("2026-08-01"), listenCount: 1, latestListenedOn: "2026-08-01", album: third,
  }]);

  const response = await invokeLastHandler(router, "/:boardId", "get", { userId: "owner", params: { boardId: BOARD_ID } });
  assert.equal(response.status, 200);
  // Date order would put the newer save, second, first.
  assert.deepEqual(response.body.albums.map((album) => album.albumId), [first.albumId, second.albumId, third.albumId]);
  assert.deepEqual(response.body.previewAlbums.map((album) => album.albumId), [first.albumId, second.albumId, third.albumId]);
  assert.equal(response.body.orderMode, "manual");
  assert.equal(response.body.displayStyle, "ranked");
  assert.equal(response.body.orderedCount, 3);
  assert.equal(response.body.revision, 7);
  assert.equal(Object.hasOwn(response.body, "albumOrder"), false);
  const serialized = JSON.stringify(response.body);
  for (const id of [sourceBoard._id, first._id, second._id, third._id]) assert.equal(serialized.includes(String(id)), false);

  const { formatBoard } = require("../routes/utils/boardLibrary");
  const publicBoard = await formatBoard(sourceBoard, { albums: true });
  assert.equal(Object.hasOwn(publicBoard, "revision"), false, "only the owner's reads carry the reorder token");
});
