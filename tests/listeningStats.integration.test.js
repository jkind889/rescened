const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { once } = require("node:events");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const AlbumCatalog = require("../models/AlbumCatalog");
const Like = require("../models/Like");
const Listen = require("../models/Listen");
const Review = require("../models/Reviews");
const UserProfile = require("../models/UserProfile");

const enabled = process.env.RUN_MONGO_INTEGRATION === "true";
const integration = (name, fn) => test(name, { skip: !enabled }, fn);
let replSet;
let server;
let baseUrl;

// Dates are relative to the real clock because the route reads "today" itself.
const today = new Date().toISOString().slice(0, 10);
const year = Number(today.slice(0, 4));

async function request(path, userId = "") {
  const response = await fetch(`${baseUrl}${path}`, { headers: { "x-test-user": userId } });
  return { status: response.status, body: await response.json() };
}

test.before(async () => {
  if (!enabled) return;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: "rescened_listening_stats" });
  await Promise.all([AlbumCatalog, Like, Listen, Review, UserProfile].map((model) => model.syncIndexes()));
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
  app.use("/profile", require("../routes/profile"));
  if (previous) require.cache[clerkPath] = previous;
  else delete require.cache[clerkPath];
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const timed = [1, 2].map((trackNumber) => ({ trackId: crypto.randomUUID(), trackNumber, title: `T${trackNumber}`, durationMs: 1800000 }));
  const [recent, older] = await AlbumCatalog.create([
    { albumId: crypto.randomUUID(), title: "Recent", artistDisplayName: "Now Band", releaseYear: year, catalogSource: "manual", tracks: timed },
    { albumId: crypto.randomUUID(), title: "Older", artistDisplayName: "Then Band", releaseYear: 1997, catalogSource: "manual" },
  ]);
  await Listen.create([
    { userId: "owner", albumCatalogId: recent._id, listenedOn: today },
    { userId: "owner", albumCatalogId: recent._id, listenedOn: today, source: "automatic" },
    { userId: "owner", albumCatalogId: recent._id, listenedOn: `${year - 1}-06-15` },
    { userId: "owner", albumCatalogId: older._id, listenedOn: `${year - 1}-06-16` },
    // Outside the two-year window.
    { userId: "owner", albumCatalogId: older._id, listenedOn: `${year - 3}-06-15` },
    { userId: "someone-else", albumCatalogId: older._id, listenedOn: today },
  ]);
  const [ownerReview] = await Review.create([
    { userId: "owner", albumCatalogId: recent._id, rating: 5, reviewText: "Owner review", date: new Date() },
    ...["a", "b", "c"].map((userId) => ({ userId, albumCatalogId: recent._id, rating: 3, reviewText: "Fine", date: new Date() })),
  ]);
  await Like.create({ userId: "a", targetType: "review", reviewId: ownerReview._id });
  await UserProfile.create([{ userId: "owner", isPrivate: false }, { userId: "hidden", isPrivate: true }]);
  await Listen.create({ userId: "hidden", albumCatalogId: older._id, listenedOn: today });
});

test.after(async () => {
  if (!enabled) return;
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
});

integration("stats isolate periods, honor the automatic toggle, and resolve public IDs only", async () => {
  const rolling = await request("/profile/owner/stats", "viewer");
  assert.equal(rolling.status, 200);
  assert.equal(rolling.body.listening.totalListens, 4, "the listen three years back is outside the window");
  assert.equal(rolling.body.listening.automaticListens, 1);
  assert.equal(rolling.body.listening.distinctAlbums, 2);
  assert.equal(rolling.body.topAlbums[0].album.title, "Recent");
  assert.equal(rolling.body.topAlbums[0].listenCount, 3);
  assert.deepEqual(rolling.body.listeningTime, { estimatedHours: 3, coveredListens: 3, totalListens: 4 });
  assert.deepEqual(rolling.body.reviews.versusCommunity, { difference: 2, albumCount: 1 });
  assert.equal(rolling.body.reviews.mostLiked.likeCount, 1);
  assert.equal(rolling.body.reviews.reviewRate, 50);
  assert.equal(JSON.stringify(rolling.body).includes("_id"), false);

  const thisYear = await request(`/profile/owner/stats?period=${year}`, "viewer");
  assert.equal(thisYear.body.listening.totalListens, 2);
  assert.equal(thisYear.body.listening.perMonth.length, Number(today.slice(5, 7)));
  assert.equal(thisYear.body.eras.releasedThatYearShare, 100);

  const lastYear = await request(`/profile/owner/stats?period=${year - 1}`, "viewer");
  assert.equal(lastYear.body.listening.totalListens, 2);
  assert.deepEqual(lastYear.body.listening.longestStreak, { days: 2, start: `${year - 1}-06-15`, end: `${year - 1}-06-16` });
  assert.equal(lastYear.body.reviews.count, 0);

  const manualOnly = await request("/profile/owner/stats?automatic=exclude", "viewer");
  assert.equal(manualOnly.body.listening.totalListens, 3);
  assert.equal(manualOnly.body.includesAutomatic, false);
});

integration("private profiles keep stats owner-only", async () => {
  assert.equal((await request("/profile/hidden/stats", "viewer")).status, 403);
  assert.equal((await request("/profile/hidden/stats")).status, 403);
  const own = await request("/profile/hidden/stats", "hidden");
  assert.equal(own.status, 200);
  assert.equal(own.body.listening.totalListens, 1);
  const me = await request("/profile/me/stats", "hidden");
  assert.equal(me.body.listening.totalListens, 1);
  assert.equal((await request("/profile/me/stats")).status, 401);
});
