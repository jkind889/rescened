const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { once } = require("node:events");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const AlbumCatalog = require("../models/AlbumCatalog");
const Board = require("../models/Board");
const BoardListen = require("../models/BoardListen");
const Listen = require("../models/Listen");
const ListenCreation = require("../models/ListenCreation");
const UserProfile = require("../models/UserProfile");
const Review = require("../models/Reviews");
const { DiaryAlbumFence } = require("../models/AutomaticListen");
const { createAutomaticListen } = require("../routes/utils/listeningDiary");
const { MAX_QUEUE } = require("../routes/utils/listenQueue");

const enabled = process.env.RUN_MONGO_INTEGRATION === "true";
const models = [AlbumCatalog, Board, BoardListen, Listen, ListenCreation, UserProfile, Review, DiaryAlbumFence];
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
function add(album, position, userId) {
  return request("POST", "/profile/me/queue", { body: { albumId: album.albumId, ...(position ? { position } : {}) }, userId });
}
function queueIds(body) { return body.albums.map((album) => album.albumId); }
function noInternalIds(body) {
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes('"_id"'), false);
  assert.equal(serialized.includes("albumCatalogId"), false);
  assert.equal(serialized.includes("queueRevision"), false);
  for (const album of albums) assert.equal(serialized.includes(String(album._id)), false);
}
async function createAlbums(count) {
  return AlbumCatalog.create(Array.from({ length: count }, (_, index) => ({
    albumId: crypto.randomUUID(), title: `Queue album ${index + 1}`, artistDisplayName: "An artist", catalogSource: "manual",
  })));
}

test.before(async () => {
  if (!enabled) return;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: "rescened_listen_queue" });
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
  owner = `queue-${crypto.randomUUID()}`;
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

integration("owners add, move, reorder, and remove queued albums using public IDs", async () => {
  const [first, second, third] = albums;
  assert.equal((await add(first)).status, 200);
  assert.equal((await add(second)).status, 200);
  const topped = await add(third, "top");
  assert.equal(topped.status, 200, JSON.stringify(topped.body));
  assert.deepEqual(queueIds(topped.body), [third.albumId, first.albumId, second.albumId]);
  assert.equal(topped.body.revision, 3);
  assert.equal(topped.body.count, 3);
  assert.equal(topped.body.limit, MAX_QUEUE);
  noInternalIds(topped.body);

  const moved = await add(third, "bottom");
  assert.deepEqual(queueIds(moved.body), [first.albumId, second.albumId, third.albumId]);
  const unchanged = await add(third, "bottom");
  assert.equal(unchanged.body.revision, moved.body.revision, "a no-op move does not write");
  const readded = await add(first);
  assert.deepEqual(queueIds(readded.body), [first.albumId, second.albumId, third.albumId], "an add without a position keeps a queued album in place");
  assert.equal(readded.body.revision, moved.body.revision);

  const reordered = await request("PUT", "/profile/me/queue", { body: { albumIds: [second.albumId, third.albumId, first.albumId], revision: moved.body.revision } });
  assert.equal(reordered.status, 200, JSON.stringify(reordered.body));
  assert.deepEqual(queueIds(reordered.body), [second.albumId, third.albumId, first.albumId]);

  const removed = await request("DELETE", `/profile/me/queue/${third.albumId}`);
  assert.deepEqual(queueIds(removed.body), [second.albumId, first.albumId]);
  const again = await request("DELETE", `/profile/me/queue/${third.albumId}`);
  assert.equal(again.status, 200);
  assert.equal(again.body.revision, removed.body.revision, "removing an absent album is idempotent");
  assert.equal((await request("DELETE", `/profile/me/queue/${crypto.randomUUID()}`)).status, 200);

  const profile = await request("GET", "/profile/me");
  assert.deepEqual(profile.body.upNext.map((album) => album.albumId), [second.albumId, first.albumId]);
  assert.equal(profile.body.queueCount, 2);
  assert.equal(profile.body.listeningNextAlbum.albumId, second.albumId);
  noInternalIds(profile.body);
});

integration("queue writes reject unknown albums, bad input, and anonymous callers", async () => {
  const missing = await request("POST", "/profile/me/queue", { body: { albumId: crypto.randomUUID() } });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "ALBUM_NOT_FOUND");
  const extra = await request("POST", "/profile/me/queue", { body: { albumId: albums[0].albumId, userId: "someone-else" } });
  assert.equal(extra.status, 400);
  assert.equal(extra.body.code, "INVALID_QUEUE_REQUEST");
  assert.equal((await request("POST", "/profile/me/queue", { body: { albumId: albums[0].albumId }, userId: "" })).status, 401);
  assert.equal((await request("GET", "/profile/me/queue", { userId: "" })).status, 401);
  assert.equal(await UserProfile.exists({ userId: owner, queueRevision: { $gt: 0 } }), null);
});

integration("the queue holds 15 albums but still allows moves when full", async () => {
  const extra = await createAlbums(MAX_QUEUE - albums.length + 1);
  const all = [...albums, ...extra];
  for (const album of all.slice(0, MAX_QUEUE)) assert.equal((await add(album)).status, 200);
  const full = await add(all[MAX_QUEUE]);
  assert.equal(full.status, 409);
  assert.equal(full.body.code, "QUEUE_FULL");
  const moved = await add(all[MAX_QUEUE - 1], "top");
  assert.equal(moved.status, 200);
  assert.equal(moved.body.albums[0].albumId, all[MAX_QUEUE - 1].albumId);
  assert.equal(moved.body.count, MAX_QUEUE);
  assert.equal((await UserProfile.findOne({ userId: owner })).listenQueue.length, MAX_QUEUE);
});

integration("stale or mismatched reorders return 409 without changing the queue", async () => {
  const [first, second, third] = albums;
  await add(first);
  const before = await add(second);
  const reorder = (albumIds, revision) => request("PUT", "/profile/me/queue", { body: { albumIds, revision } });

  const stale = await reorder([second.albumId, first.albumId], before.body.revision - 1);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "QUEUE_CHANGED");
  const missing = await reorder([second.albumId], before.body.revision);
  assert.equal(missing.body.code, "QUEUE_CHANGED");
  const foreign = await reorder([second.albumId, third.albumId], before.body.revision);
  assert.equal(foreign.body.code, "QUEUE_CHANGED");

  const after = await request("GET", "/profile/me/queue");
  assert.deepEqual(queueIds(after.body), [first.albumId, second.albumId]);
  assert.equal(after.body.revision, before.body.revision);
});

integration("a concurrent reorder and add leave one consistent queue", async () => {
  const [first, second, third, fourth] = albums;
  await add(first);
  await add(second);
  const before = await add(third);
  const [reorder, added] = await Promise.all([
    request("PUT", "/profile/me/queue", { body: { albumIds: [third.albumId, second.albumId, first.albumId], revision: before.body.revision } }),
    add(fourth),
  ]);
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.ok([200, 409].includes(reorder.status), JSON.stringify(reorder.body));
  const after = await request("GET", "/profile/me/queue");
  const ids = queueIds(after.body);
  assert.equal(new Set(ids).size, 4);
  assert.equal(ids[3], fourth.albumId, "the added album is last either way");
  if (reorder.status === 200) assert.deepEqual(ids.slice(0, 3), [third.albumId, second.albumId, first.albumId]);
  else {
    assert.equal(reorder.body.code, "QUEUE_CHANGED");
    assert.deepEqual(ids.slice(0, 3), [first.albumId, second.albumId, third.albumId]);
  }
  assert.equal(after.body.revision, before.body.revision + (reorder.status === 200 ? 2 : 1));
});

integration("logging a listen removes the album from the queue in the same transaction", async () => {
  const [first, second, third] = albums;
  await add(first);
  const before = await add(second);
  const unrelated = await request("POST", "/diary", { body: { albumId: third.albumId, listenedOn: "2026-10-01", timeZone: "UTC" }, key: crypto.randomUUID() });
  assert.equal(unrelated.status, 201, JSON.stringify(unrelated.body));
  assert.equal((await request("GET", "/profile/me/queue")).body.revision, before.body.revision, "an unqueued album leaves the revision alone");

  const logged = await request("POST", "/diary", { body: { albumId: first.albumId, listenedOn: "2026-10-01", timeZone: "UTC" }, key: crypto.randomUUID() });
  assert.equal(logged.status, 201);
  const after = await request("GET", "/profile/me/queue");
  assert.deepEqual(queueIds(after.body), [second.albumId]);
  assert.equal(after.body.revision, before.body.revision + 1);

  const failed = await request("POST", "/diary", { body: { albumId: second.albumId, listenedOn: "2026-10-01", timeZone: "UTC", boardIds: [crypto.randomUUID()] }, key: crypto.randomUUID() });
  assert.equal(failed.status, 404);
  assert.deepEqual(queueIds((await request("GET", "/profile/me/queue")).body), [second.albumId], "a failed listen keeps the album queued");
});

integration("automatic listens remove the album from the queue", async () => {
  const [first, second] = albums;
  await add(first);
  await add(second);
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(() => createAutomaticListen({ userId: owner, album: second, listenedOn: "2026-10-02", session }));
  } finally {
    await session.endSession();
  }
  assert.deepEqual(queueIds((await request("GET", "/profile/me/queue")).body), [first.albumId]);
  assert.equal(await Listen.countDocuments({ userId: owner, source: "automatic" }), 1);
});

integration("the legacy listening-next album reads as the queue until the first write", async () => {
  const [legacy, added] = albums;
  await UserProfile.collection.insertOne({ userId: owner, bio: "", isPrivate: false, favoriteAlbums: [], listeningNextAlbum: { albumCatalogId: legacy._id }, createdAt: new Date(), updatedAt: new Date() });

  const read = await request("GET", "/profile/me/queue");
  assert.deepEqual(queueIds(read.body), [legacy.albumId]);
  assert.equal(read.body.revision, 0);
  const saved = await request("PUT", "/profile/me", { body: { bio: "Still here", favoriteAlbumIds: [] } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.upNext.map((album) => album.albumId), [legacy.albumId], "saving the profile keeps the legacy album");

  const written = await add(added);
  assert.deepEqual(queueIds(written.body), [legacy.albumId, added.albumId]);
  const stored = await UserProfile.findOne({ userId: owner }).lean();
  assert.equal(stored.listeningNextAlbum, null);
  assert.equal(stored.queueRevision, 1);
});

integration("a listen clears an unmigrated legacy listening-next album", async () => {
  const [legacy] = albums;
  await UserProfile.collection.insertOne({ userId: owner, bio: "", isPrivate: false, favoriteAlbums: [], listeningNextAlbum: { albumCatalogId: legacy._id }, createdAt: new Date(), updatedAt: new Date() });
  const logged = await request("POST", "/diary", { body: { albumId: legacy.albumId, listenedOn: "2026-10-01", timeZone: "UTC" }, key: crypto.randomUUID() });
  assert.equal(logged.status, 201);
  const read = await request("GET", "/profile/me/queue");
  assert.deepEqual(read.body.albums, []);
  assert.equal(read.body.revision, 1);
});

integration("other people can read a public queue but not a private one", async () => {
  await add(albums[0]);
  await add(albums[1]);
  const viewer = `viewer-${crypto.randomUUID()}`;
  const visible = await request("GET", `/profile/${owner}/queue`, { userId: viewer });
  assert.equal(visible.status, 200);
  assert.deepEqual(queueIds(visible.body), [albums[0].albumId, albums[1].albumId]);
  assert.equal(Object.hasOwn(visible.body, "revision"), false);
  noInternalIds(visible.body);
  assert.equal((await request("GET", `/profile/${owner}/queue`, { userId: "" })).status, 200);
  const publicProfile = await request("GET", `/profile/${owner}`, { userId: viewer });
  assert.equal(publicProfile.body.queueCount, 2);

  await UserProfile.updateOne({ userId: owner }, { $set: { isPrivate: true } });
  const hidden = await request("GET", `/profile/${owner}/queue`, { userId: viewer });
  assert.equal(hidden.status, 403);
  assert.equal(hidden.body.isPrivate, true);
  const privateProfile = await request("GET", `/profile/${owner}`, { userId: viewer });
  assert.deepEqual(privateProfile.body.upNext, []);
  assert.equal(privateProfile.body.queueCount, 0);
  assert.equal((await request("GET", `/profile/${owner}/queue`)).status, 200, "the owner still reads a private queue");
});
