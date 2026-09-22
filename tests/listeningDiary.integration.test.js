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
const Follow = require("../models/Follow");
const Like = require("../models/Like");
const Notification = require("../models/Notification");
const { createListen, deleteListen, updateListen, listListens } = require("../routes/utils/listeningDiary");
const { setMembership, deleteBoard, saveAlbum, removeAlbum, transaction, claimBoard } = require("../routes/utils/boardMutations");
const { formatBoard, savedAlbums, savedUserCount, albumBoards } = require("../routes/utils/boardLibrary");

const enabled = process.env.RUN_MONGO_INTEGRATION === "true";
const models = [AlbumCatalog, Board, BoardItem, BoardListen, Listen, ListenCreation, UserProfile, Review, Follow, Like, Notification];
let replSet;
let server;
let baseUrl;
let owner;
let album;
let board;
let secondBoard;

function input(overrides = {}) {
  return { albumId: album.albumId, listenedOn: "2020-01-02", timeZone: "UTC", ...overrides };
}
function log(overrides = {}, key = crypto.randomUUID()) {
  return createListen(owner, input(overrides), key);
}
async function request(method, path, options = {}) {
  const headers = { "x-test-user": options.userId === undefined ? owner : options.userId };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.key) headers["Idempotency-Key"] = options.key;
  const response = await fetch(`${baseUrl}${path}`, {
    method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}
function noInternalIds(body, ids = []) {
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes('"_id"'), false);
  assert.equal(serialized.includes("albumCatalogId"), false);
  assert.equal(serialized.includes("interactionRevision"), false);
  assert.equal(serialized.includes("fingerprint"), false);
  for (const id of ids) assert.equal(serialized.includes(String(id)), false);
}

test.before(async () => {
  if (!enabled) return;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: "rescened_listening_diary" });
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
  app.use("/diary", require("../routes/diary"));
  app.use("/boards", require("../routes/boards"));
  app.use("/profile", require("../routes/profile"));
  app.use("/albums", require("../routes/album"));
  if (previous) require.cache[clerkPath] = previous;
  else delete require.cache[clerkPath];
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(async () => {
  if (!enabled) return;
  await Promise.all(models.map((model) => model.deleteMany({})));
  owner = `diary-${crypto.randomUUID()}`;
  album = await AlbumCatalog.create({ albumId: crypto.randomUUID(), title: "Diary album", artistDisplayName: "An artist", catalogSource: "manual" });
  board = await Board.create({ userId: owner, title: "Mornings" });
  secondBoard = await Board.create({ userId: owner, title: "January" });
});

test.after(async () => {
  if (!enabled) return;
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
});

const integration = (name, fn) => test(name, { skip: !enabled }, fn);

integration("standalone diary logging creates a profile but no board membership or saved album", async () => {
  const created = await request("POST", "/diary", { body: input(), key: crypto.randomUUID() });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.listenedOn, "2020-01-02");
  assert.ok(await UserProfile.exists({ userId: owner }));
  assert.equal(await Board.countDocuments({ userId: owner, isDefault: true }), 0);
  assert.equal(await BoardListen.countDocuments({}), 0);
  assert.deepEqual(await savedAlbums(owner), []);
  assert.equal(await savedUserCount(album._id), 0);
  const diary = await request("GET", "/diary");
  assert.equal(diary.body.listens.length, 1);
  assert.equal(diary.body.nextCursor, null);
  const stored = await Listen.findOne({ listenId: created.body.listenId });
  noInternalIds(diary.body, [stored._id, album._id]);
});

integration("creation retries are atomic and distinct keys preserve intentional same-day listens", async () => {
  const key = crypto.randomUUID();
  const body = input({ boardIds: [board.boardId, secondBoard.boardId] });
  const results = await Promise.all(Array.from({ length: 6 }, () => createListen(owner, body, key)));
  assert.equal(new Set(results.map((result) => result.listen.listenId)).size, 1);
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal(await Listen.countDocuments({}), 1);
  assert.equal(await ListenCreation.countDocuments({}), 1);
  assert.equal(await BoardListen.countDocuments({}), 2);
  await assert.rejects(createListen(owner, { ...body, listenedOn: "2020-01-01" }, key), { status: 409, code: "IDEMPOTENCY_CONFLICT" });
  const replay = await request("POST", "/diary", { body: { ...body, boardIds: [...body.boardIds].reverse() }, key });
  assert.equal(replay.status, 200);
  await log({ boardIds: [board.boardId] });
  assert.equal(await Listen.countDocuments({}), 2);
  await deleteListen(owner, results[0].listen.listenId);
  const deletedReplay = await request("POST", "/diary", { body, key });
  assert.equal(deletedReplay.status, 409);
  assert.equal(deletedReplay.body.code, "LISTEN_DELETED");
  assert.equal(await Listen.countDocuments({}), 1);
});

integration("an invalid or foreign board rolls back the entire multi-board creation", async () => {
  const foreign = await Board.create({ userId: "another-user", title: "Other" });
  for (const badId of [foreign.boardId, crypto.randomUUID()]) {
    const result = await request("POST", "/diary", {
      body: input({ boardIds: [board.boardId, badId] }), key: crypto.randomUUID(),
    });
    assert.equal(result.status, 404);
  }
  assert.equal(await Listen.countDocuments({}), 0);
  assert.equal(await ListenCreation.countDocuments({}), 0);
  assert.equal(await BoardListen.countDocuments({}), 0);
  assert.equal(await UserProfile.countDocuments({ userId: owner }), 0);
});

integration("failure after the first membership write rolls back the listen, receipt and parent claims", async (t) => {
  const original = BoardListen.create;
  let writes = 0;
  t.mock.method(BoardListen, "create", async function (...args) {
    writes += 1;
    if (writes === 2) throw new Error("Injected membership failure");
    return original.apply(this, args);
  });
  await assert.rejects(log({ boardIds: [board.boardId, secondBoard.boardId] }), /Injected membership failure/);
  assert.equal(writes, 2);
  assert.equal(await Listen.countDocuments({}), 0);
  assert.equal(await ListenCreation.countDocuments({}), 0);
  assert.equal(await BoardListen.countDocuments({}), 0);
  for (const target of [board, secondBoard]) {
    assert.equal((await Board.findById(target._id).select("+interactionRevision")).interactionRevision, 0);
  }
});

integration("one cover summarizes board-specific listens and preserves explicit savedAt", async () => {
  const first = await log({ boardIds: [board.boardId, secondBoard.boardId] });
  await log({ listenedOn: "2020-01-03", boardIds: [board.boardId] });
  const undatedAlbum = await AlbumCatalog.create({ albumId: crypto.randomUUID(), title: "Undated", artistDisplayName: "Artist", catalogSource: "manual" });
  await saveAlbum(owner, board.boardId, undatedAlbum._id);
  let detail = await request("GET", `/boards/${board.boardId}`);
  assert.equal(detail.body.itemCount, 2);
  assert.equal(detail.body.listenCount, 2);
  const card = detail.body.albums.find((item) => item.albumId === album.albumId);
  assert.equal(card.listenCount, 2);
  assert.equal(card.latestListenedOn, "2020-01-03");
  assert.equal(card.explicitlySaved, false);
  assert.equal(detail.body.albums.find((item) => item.albumId === undatedAlbum.albumId).listenCount, 0);
  const oldSave = new Date("2019-01-01T00:00:00Z");
  await BoardItem.create({ userId: owner, boardId: board._id, albumCatalogId: album._id, savedAt: oldSave });
  detail = await request("GET", `/boards/${board.boardId}`);
  assert.equal(detail.body.albums.find((item) => item.albumId === album.albumId).savedAt, oldSave.toISOString());
  const dates = await request("GET", `/boards/${secondBoard.boardId}/albums/${album.albumId}/listens`);
  assert.deepEqual(dates.body.listens.map((item) => item.listenId), [first.listen.listenId]);
  assert.equal(JSON.stringify(dates.body).includes(board.boardId), false);
  const saved = await request("GET", "/profile/me/saved");
  assert.equal(saved.body.filter((item) => item.albumId === album.albumId).length, 1);
  assert.equal(await savedUserCount(album._id), 1);
  const status = await request("GET", `/boards/album/${album.albumId}`);
  assert.equal(status.body.saved, true);
  assert.equal(status.body.boards.length, 2);
  noInternalIds(detail.body, [board._id, album._id]);
});

integration("detaching a last listen removes its cover unless explicitly saved, without deleting history", async () => {
  const { listen } = await log({ boardIds: [board.boardId, secondBoard.boardId] });
  await saveAlbum(owner, secondBoard.boardId, album._id);
  const first = await request("DELETE", `/boards/${board.boardId}/listens/${listen.listenId}`);
  assert.equal(first.status, 200);
  assert.equal((await formatBoard(board)).itemCount, 0);
  assert.equal((await savedAlbums(owner)).length, 1);
  assert.equal((await request("DELETE", `/boards/${board.boardId}/listens/${listen.listenId}`)).status, 200);
  await setMembership(owner, secondBoard.boardId, listen.listenId, false);
  const detail = await formatBoard(secondBoard, true);
  assert.equal(detail.itemCount, 1);
  assert.equal(detail.albums[0].explicitlySaved, true);
  assert.equal(detail.listenCount, 0);
  assert.equal(await Listen.countDocuments({}), 1);
  await removeAlbum(owner, secondBoard.boardId, album._id);
  assert.deepEqual(await savedAlbums(owner), []);
});

integration("album removal unlinks all listens only from that board, while listen deletion cascades everywhere", async () => {
  const first = await log({ boardIds: [board.boardId, secondBoard.boardId] });
  const second = await log({ boardIds: [board.boardId, secondBoard.boardId] });
  await saveAlbum(owner, board.boardId, album._id);
  const removed = await request("DELETE", `/boards/${board.boardId}/albums/${album.albumId}`);
  assert.equal(removed.status, 200);
  assert.equal((await formatBoard(board)).itemCount, 0);
  assert.equal(await Listen.countDocuments({}), 2);
  assert.equal(await BoardListen.countDocuments({ boardId: secondBoard._id }), 2);
  await deleteListen(owner, first.listen.listenId);
  assert.equal((await formatBoard(secondBoard)).listenCount, 1);
  await deleteListen(owner, second.listen.listenId);
  assert.equal((await formatBoard(secondBoard)).itemCount, 0);
  assert.equal(await BoardListen.countDocuments({}), 0);
  assert.equal(await ListenCreation.countDocuments({}), 2);
});

integration("board deletion clears its pin and both kinds of membership but retains listens", async () => {
  await log({ boardIds: [board.boardId, secondBoard.boardId] });
  await saveAlbum(owner, board.boardId, album._id);
  await UserProfile.updateOne({ userId: owner }, { $set: { pinnedBoardId: board._id } });
  const response = await request("DELETE", `/boards/${board.boardId}`);
  assert.equal(response.status, 200);
  assert.equal(await BoardItem.countDocuments({ boardId: board._id }), 0);
  assert.equal(await BoardListen.countDocuments({ boardId: board._id }), 0);
  assert.equal((await UserProfile.findOne({ userId: owner })).pinnedBoardId, null);
  assert.equal(await Listen.countDocuments({}), 1);
  assert.equal((await savedAlbums(owner)).length, 1);
});

integration("date correction updates diary ordering and summaries without rewriting catalog identity", async () => {
  const { listen } = await log({ boardIds: [board.boardId] });
  const response = await request("PATCH", `/diary/${listen.listenId}`, { body: { listenedOn: "2010-05-01", timeZone: "America/New_York" } });
  assert.equal(response.status, 200);
  assert.equal(response.body.listenedOn, "2010-05-01");
  assert.equal((await formatBoard(board, true)).albums[0].latestListenedOn, "2010-05-01");
  for (const body of [
    { listenedOn: "2025-02-29", timeZone: "UTC" },
    { listenedOn: "9999-01-01", timeZone: "UTC" },
    { listenedOn: "2020-01-01", timeZone: "Not/AZone" },
    { listenedOn: "2020-01-01", timeZone: "UTC", albumId: crypto.randomUUID() },
  ]) assert.equal((await request("PATCH", `/diary/${listen.listenId}`, { body })).status, 400);
  assert.equal((await Listen.findOne({ listenId: listen.listenId })).listenedOn, "2010-05-01");
});

integration("privacy applies to diary pages, board dates, pinned boards and existing collections", async () => {
  await UserProfile.create({ userId: owner, isPrivate: true });
  await log({ boardIds: [board.boardId] });
  await log({ boardIds: [board.boardId] });
  assert.equal((await UserProfile.findOne({ userId: owner })).isPrivate, true);
  const paths = [
    `/profile/${owner}/diary`, `/profile/${owner}/diary?boardId=${board.boardId}`,
    `/profile/${owner}/boards/${board.boardId}/albums/${album.albumId}/listens`,
    `/profile/${owner}/boards/${board.boardId}`, `/profile/${owner}/saved`,
  ];
  for (const path of paths) {
    assert.equal((await request("GET", path, { userId: "visitor" })).status, 403);
    assert.equal((await request("GET", path, { userId: "" })).status, 403);
    assert.equal((await request("GET", path)).status, 200);
  }
  await UserProfile.updateOne({ userId: owner }, { $set: { isPrivate: false, pinnedBoardId: board._id } });
  const publicPage = await request("GET", `/profile/${owner}/diary?limit=1`, { userId: "" });
  assert.equal(publicPage.status, 200);
  assert.ok(publicPage.body.nextCursor);
  const publicBoard = await request("GET", `/profile/${owner}/boards/${board.boardId}`, { userId: "" });
  const pinned = await request("GET", `/profile/${owner}`, { userId: "" });
  assert.equal(publicBoard.body.listenCount, 2);
  assert.equal(pinned.body.pinnedBoard.listenCount, 2);
  const dates = await request("GET", `/profile/${owner}/boards/${board.boardId}/albums/${album.albumId}/listens`, { userId: "" });
  assert.equal(dates.body.listens.length, 2);
  await UserProfile.updateOne({ userId: owner }, { $set: { isPrivate: true } });
  assert.equal((await request("GET", `/profile/${owner}/diary?limit=1&cursor=${publicPage.body.nextCursor}`, { userId: "" })).status, 403);
  assert.equal((await request("GET", `/profile/${owner}`, { userId: "visitor" })).body.pinnedBoard, null);
});

integration("ownership and authentication cannot be supplied through diary or board request bodies", async () => {
  const { listen } = await log();
  const foreign = await Board.create({ userId: "foreign", title: "Foreign" });
  for (const method of ["PUT", "DELETE"]) {
    assert.equal((await request(method, `/boards/${board.boardId}/listens/${listen.listenId}`, { userId: "foreign" })).status, 404);
    assert.equal((await request(method, `/boards/${foreign.boardId}/listens/${listen.listenId}`, { userId: "foreign" })).status, 404);
  }
  assert.equal((await request("PATCH", `/diary/${listen.listenId}`, { userId: "foreign", body: { listenedOn: "2020-01-01", timeZone: "UTC" } })).status, 404);
  assert.equal((await request("DELETE", `/diary/${listen.listenId}`, { userId: "foreign" })).status, 200);
  assert.equal(await Listen.countDocuments({}), 1);
  for (const [method, path, body] of [["GET", "/diary"], ["POST", "/diary", input()], ["PATCH", `/diary/${listen.listenId}`, input()], ["DELETE", `/diary/${listen.listenId}`], ["PUT", `/boards/${board.boardId}/listens/${listen.listenId}`]]) {
    assert.equal((await request(method, path, { userId: "", body })).status, 401);
  }
  assert.equal((await request("POST", "/diary", { body: { ...input(), userId: "foreign" }, key: crypto.randomUUID() })).status, 400);
  assert.equal((await request("POST", "/diary", { body: input({ albumId: crypto.randomUUID() }), key: crypto.randomUUID() })).status, 404);
  assert.equal((await request("POST", "/diary", { body: input({ albumId: String(album._id) }), key: crypto.randomUUID() })).status, 400);
});

integration("pagination is deterministic for ties, binds filters, and resolves current catalog metadata", async () => {
  const rows = [];
  for (let i = 0; i < 5; i += 1) rows.push((await log({ boardIds: [board.boardId], listenedOn: i === 0 ? "2019-12-31" : "2020-01-02" })).listen);
  await Listen.updateMany({}, { $set: { createdAt: new Date("2021-01-01T00:00:00Z") } }, { timestamps: false, strict: false });
  const seen = [];
  let cursor;
  do {
    const page = await listListens(owner, { limit: "2", ...(cursor ? { cursor } : {}) });
    seen.push(...page.listens.map((row) => row.listenId));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(seen.length, 5);
  assert.equal(new Set(seen).size, 5);
  assert.equal(seen.at(-1), rows[0].listenId);
  const first = await listListens(owner, { limit: "1" });
  for (const filters of [{ from: "2020-01-01" }, { boardId: board.boardId }, { albumId: album.albumId }]) {
    await assert.rejects(listListens(owner, { ...filters, cursor: first.nextCursor }), { code: "INVALID_DIARY_CURSOR" });
  }
  await assert.rejects(listListens("someone-else", { cursor: first.nextCursor }), { code: "INVALID_DIARY_CURSOR" });
  const filtered = await listListens(owner, { from: "2020-01-02", to: "2020-01-02", boardId: board.boardId, albumId: album.albumId });
  assert.equal(filtered.listens.length, 4);
  await AlbumCatalog.updateOne({ _id: album._id }, { $set: { title: "Corrected title" } });
  assert.equal((await listListens(owner)).listens[0].album.title, "Corrected title");
  assert.equal((await formatBoard(board, true)).albums[0].title, "Corrected title");
  const missing = await AlbumCatalog.create({ albumId: crypto.randomUUID(), title: "Gone", artistDisplayName: "Artist", catalogSource: "manual" });
  await log({ albumId: missing.albumId, listenedOn: "2020-01-03", boardIds: [board.boardId] });
  await AlbumCatalog.deleteOne({ _id: missing._id });
  const page = await listListens(owner, { limit: "1" });
  assert.equal(page.listens.length, 1);
  assert.equal(page.listens[0].albumId, album.albumId);
  assert.equal((await formatBoard(board)).itemCount, 1);
});

integration("default board alias and existing save APIs support both membership sources", async () => {
  const { listen } = await log();
  const attached = await request("PUT", `/boards/default/listens/${listen.listenId}`);
  assert.equal(attached.status, 200);
  assert.equal((await request("PUT", `/boards/default/listens/${listen.listenId}`)).status, 200);
  const detail = await request("GET", "/boards/default");
  assert.equal(detail.body.isDefault, true);
  assert.equal(detail.body.listenCount, 1);
  const saved = await request("POST", "/boards/default/albums", { body: { albumId: album.albumId } });
  assert.equal(saved.status, 201);
  assert.equal(saved.body.album.explicitlySaved, true);
  assert.equal(saved.body.album.listenCount, 1);
  assert.equal((await request("DELETE", "/boards/default")).status, 400);
  await deleteListen(owner, listen.listenId);
  assert.equal((await request("GET", "/boards/default")).body.itemCount, 1);
});

integration("diary mutations retain rate limits and emit one listen activity without synthetic saves", async () => {
  await log({ boardIds: [board.boardId] });
  const activity = await request("GET", "/profile/me/activity");
  assert.equal(activity.body.length, 1);
  assert.equal(activity.body[0].type, "listen");
  assert.equal(activity.body[0].listenedOn, "2020-01-02");
  await saveAlbum(owner, board.boardId, album._id);
  const explicitActivity = await request("GET", "/profile/me/activity");
  assert.equal(explicitActivity.body.length, 2);
  assert.equal(explicitActivity.body.filter((item) => item.type === "saved_album").length, 1);
  for (let i = 0; i < 30; i += 1) {
    assert.equal((await request("POST", "/diary", { body: {} })).status, 400);
  }
  const limited = await request("POST", "/diary", { body: input(), key: crypto.randomUUID() });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, "RATE_LIMITED");
  assert.ok(Number(limited.headers.get("Retry-After")) > 0);
  assert.equal(await Listen.countDocuments({}), 1);
});

integration("concurrent attachment and listen deletion leave no dangling relationships", async () => {
  for (let i = 0; i < 5; i += 1) {
    const { listen } = await log({ boardIds: [board.boardId] });
    const results = await Promise.allSettled([
      setMembership(owner, secondBoard.boardId, listen.listenId, true),
      deleteListen(owner, listen.listenId),
    ]);
    assert.equal(results[1].status, "fulfilled");
    if (results[0].status === "rejected") assert.equal(results[0].reason.status, 404);
    assert.equal(await Listen.exists({ listenId: listen.listenId }), null);
    assert.equal(await BoardListen.countDocuments({}), 0);
  }
});

integration("concurrent saves, logs, pins and board deletion serialize without orphaning data", async () => {
  for (let i = 0; i < 4; i += 1) {
    const target = await Board.create({ userId: owner, title: `Race ${i}` });
    const { listen } = await log();
    const results = await Promise.allSettled([
      saveAlbum(owner, target.boardId, album._id),
      setMembership(owner, target.boardId, listen.listenId, true),
      transaction("BOARD", async (session) => {
        const claimed = await claimBoard(owner, target.boardId, session);
        await UserProfile.updateOne({ userId: owner }, { $set: { pinnedBoardId: claimed._id } }, { session });
      }),
      deleteBoard(owner, target.boardId),
    ]);
    assert.equal(results[3].status, "fulfilled");
    for (const result of results.slice(0, 3)) if (result.status === "rejected") assert.equal(result.reason.status, 404);
    assert.equal(await BoardItem.countDocuments({ boardId: target._id }), 0);
    assert.equal(await BoardListen.countDocuments({ boardId: target._id }), 0);
    assert.equal(await UserProfile.countDocuments({ pinnedBoardId: target._id }), 0);
    assert.ok(await Listen.exists({ listenId: listen.listenId }));
  }
});

integration("overlapping album removal and logging commit whole operations", async () => {
  await saveAlbum(owner, board.boardId, album._id);
  await log({ boardIds: [board.boardId] });
  const [removed, created] = await Promise.allSettled([
    removeAlbum(owner, board.boardId, album._id),
    log({ boardIds: [board.boardId] }),
  ]);
  assert.equal(removed.status, "fulfilled");
  assert.equal(created.status, "fulfilled");
  assert.equal(await Listen.countDocuments({}), 2);
  assert.equal(await BoardItem.countDocuments({ boardId: board._id }), 0);
  const memberships = await BoardListen.find({ boardId: board._id });
  assert.ok(memberships.length === 0 || memberships.length === 1);
  if (memberships.length) {
    const linked = await Listen.findById(memberships[0].listenId);
    assert.equal(linked.listenId, created.value.listen.listenId);
  }
  assert.equal((await formatBoard(board)).listenCount, memberships.length);
});


integration("listen activity reflects retries, date corrections, privacy, current metadata and deletion", async () => {
  const key = crypto.randomUUID();
  const { listen } = await log({ boardIds: [board.boardId, secondBoard.boardId] }, key);
  await log({ boardIds: [board.boardId, secondBoard.boardId] }, key);
  const viewerId = "feed-viewer";
  await Follow.create({ followerId: viewerId, followingId: owner });
  await AlbumCatalog.updateOne({ _id: album._id }, { $set: { title: "Updated album" } });
  const paths = ["/profile/me/activity", `/profile/${owner}/activity`, "/profile/me/network"];
  for (const path of paths) {
    const response = await request("GET", path, { userId: path.endsWith("network") ? viewerId : owner });
    assert.equal(response.status, 200);
    assert.equal(response.body.length, 1);
    const item = response.body[0];
    assert.equal(item.id, listen.listenId);
    assert.equal(item.listenId, listen.listenId);
    assert.equal(item.type, "listen");
    assert.equal(item.album.title, "Updated album");
    assert.equal(item.actor.userId, owner);
    noInternalIds(response.body, [album._id]);
  }
  const original = (await request("GET", "/profile/me/activity")).body[0];
  await updateListen(owner, listen.listenId, { listenedOn: "2021-02-03", timeZone: "UTC" });
  const corrected = (await request("GET", "/profile/me/activity")).body[0];
  assert.equal(corrected.listenedOn, "2021-02-03");
  assert.equal(corrected.createdAt, original.createdAt);
  await UserProfile.updateOne({ userId: owner }, { $set: { isPrivate: true } });
  assert.equal((await request("GET", `/profile/${owner}/activity`, { userId: viewerId })).status, 403);
  assert.deepEqual((await request("GET", "/profile/me/network", { userId: viewerId })).body, []);
  assert.equal((await request("GET", "/profile/me/activity")).body.length, 1);
  await deleteListen(owner, listen.listenId);
  assert.deepEqual((await request("GET", "/profile/me/activity")).body, []);
});

integration("activity caps mixed events globally and excludes missing catalog listens before limiting", async () => {
  await Follow.create({ followerId: "feed-viewer", followingId: owner });
  await UserProfile.create({ userId: owner });
  const missingAlbum = new mongoose.Types.ObjectId();
  await Listen.insertMany(Array.from({ length: 25 }, (_, index) => ({
    userId: owner, albumCatalogId: album._id, listenedOn: "2020-01-02",
    createdAt: new Date(Date.UTC(2026, 0, index + 1)),
  })));
  await Listen.create({ userId: owner, albumCatalogId: missingAlbum, listenedOn: "2020-01-02", createdAt: new Date("2026-03-01") });
  const review = await Review.create({ userId: owner, albumCatalogId: album._id, rating: 4, reviewText: "Latest review", date: new Date("2026-02-01") });
  for (const path of ["/profile/me/activity", "/profile/me/network"]) {
    const response = await request("GET", path, { userId: path.endsWith("network") ? "feed-viewer" : owner });
    assert.equal(response.status, 200);
    assert.equal(response.body.length, 20);
    assert.equal(response.body[0].reviewId, review.reviewId);
    assert.equal(response.body[1].createdAt, "2026-01-25T00:00:00.000Z");
    assert.equal(response.body.at(-1).createdAt, "2026-01-07T00:00:00.000Z");
    assert.ok(response.body.every((item) => item.album.albumId === album.albumId));
  }
});
