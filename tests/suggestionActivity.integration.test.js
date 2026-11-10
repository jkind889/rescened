const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { once } = require("node:events");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const AlbumCatalog = require("../models/AlbumCatalog");
const AlbumSubmission = require("../models/AlbumSubmission");
const UserProfile = require("../models/UserProfile");
const Follow = require("../models/Follow");
const Review = require("../models/Reviews");
const { getSuggestionActivity } = require("../routes/utils/suggestionActivity");

const enabled = process.env.RUN_MONGO_INTEGRATION === "true";
const integration = (name, fn) => test(name, { skip: !enabled }, fn);
const models = [AlbumCatalog, AlbumSubmission, UserProfile, Follow, Review];
let replSet;
let server;
let baseUrl;
let album;
const clerkPath = require.resolve("@clerk/express");
let previousClerk;

function submission(overrides = {}) {
  return {
    submissionId: crypto.randomUUID(), submittedByUserId: "contributor", status: "approved",
    approvedAt: new Date("2026-11-01T12:00:00Z"), approvalPublicationType: "catalog_created",
    approvedAlbumCatalogId: album._id,
    createdAt: new Date("2026-10-01T12:00:00Z"), updatedAt: new Date("2026-11-10T12:00:00Z"),
    proposedMetadata: { title: "Private unapproved title" }, supportingSources: [{ note: "private source" }],
    revisions: [{ proposedChanges: { title: "private revision" } }],
    moderationHistory: [{ actorUserId: "moderator", reason: "private reason" }],
    ...overrides,
  };
}
async function request(path, userId = "contributor") {
  const response = await fetch(`${baseUrl}${path}`, { headers: { "x-test-user": userId } });
  return { status: response.status, body: await response.json() };
}

test.before(async () => {
  if (!enabled) return;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: "rescened_suggestion_activity" });
  await Promise.all(models.map((model) => model.syncIndexes()));
  previousClerk = require.cache[clerkPath];
  require.cache[clerkPath] = {
    id: clerkPath, filename: clerkPath, loaded: true,
    exports: {
      getAuth: (req) => ({ userId: req.headers["x-test-user"] || null }),
      clerkClient: { users: { getUserList: async ({ userId }) => ({ data: userId.map((id) => ({ id, username: `${id}-name` })) }) } },
    },
  };
  const app = express();
  app.use("/profile", require("../routes/profile"));
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(async () => {
  if (!enabled) return;
  await Promise.all(models.map((model) => model.deleteMany({})));
  album = await AlbumCatalog.create({ albumId: crypto.randomUUID(), title: "Catalog title", artistDisplayName: "Catalog artist", catalogSource: "manual" });
  await UserProfile.create({ userId: "contributor" });
});
test.after(async () => {
  if (!enabled) return;
  if (server) await new Promise((resolve) => server.close(resolve));
  if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
  if (previousClerk) require.cache[clerkPath] = previousClerk;
  else delete require.cache[clerkPath];
});

integration("all approved publication types appear in own, public, and following activity with current catalog metadata", async () => {
  const rows = ["catalog_created", "catalog_linked", "catalog_corrected", "genres_updated"].map((approvalPublicationType, i) => submission({
    approvalPublicationType, approvedAt: new Date(Date.UTC(2026, 10, 1, i)),
  }));
  // Insert raw fixtures to also exercise malformed historical rows below.
  await AlbumSubmission.collection.insertMany(rows);
  await Follow.create({ followerId: "viewer", followingId: "contributor" });
  await AlbumCatalog.updateOne({ _id: album._id }, { $set: { title: "Updated catalog title", cover: "https://example.test/current.jpg" } });
  for (const [path, userId] of [["/profile/me/activity", "contributor"], ["/profile/contributor/activity", ""], ["/profile/me/network", "viewer"]]) {
    const response = await request(path, userId);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body.map((row) => row.submissionId), rows.map((row) => row.submissionId).reverse());
    for (const item of response.body) {
      assert.equal(item.type, "suggestion_approved");
      assert.equal(item.actor.userId, "contributor");
      assert.equal(item.actor.username, "contributor-name");
      assert.equal(item.album.albumId, album.albumId);
      assert.equal(item.album.title, "Updated catalog title");
      assert.equal(item.album.cover, "https://example.test/current.jpg");
      assert.equal(item.createdAt, rows.find((row) => row.submissionId === item.submissionId).approvedAt.toISOString());
      const serialized = JSON.stringify(item);
      for (const hidden of ["private", "moderator", "proposedMetadata", "revisions", "moderationHistory", "_id", String(album._id)]) assert.equal(serialized.includes(hidden), false, hidden);
    }
    assert.deepEqual((await request(path, userId)).body, response.body, "repeated reads do not duplicate approvals");
  }
  assert.deepEqual((await request("/profile/me/activity", "moderator")).body, []);
});

integration("unapproved, incomplete, orphaned, and invalid-public-ID suggestions never consume feed slots", async () => {
  const valid = Array.from({ length: 21 }, (_, i) => submission({ approvedAt: new Date(Date.UTC(2026, 9, 1, i)) }));
  const excluded = ["pending", "needs_changes", "rejected", "duplicate", "withdrawn"].map((status) => submission({ status }));
  excluded.push(
    submission({ approvedAt: null }), submission({ approvedAt: "invalid date" }),
    submission({ approvalPublicationType: null }), submission({ approvalPublicationType: "unknown" }),
    submission({ submissionId: "not-a-public-id" }), submission({ approvedAlbumCatalogId: new mongoose.Types.ObjectId() }),
  );
  await AlbumSubmission.collection.insertMany([...valid, ...excluded]);
  const items = await getSuggestionActivity(["contributor"], 20);
  assert.equal(items.length, 20);
  assert.deepEqual(items.map((item) => item.submissionId), valid.slice(1).reverse().map((row) => row.submissionId));
  await AlbumCatalog.deleteOne({ _id: album._id });
  assert.deepEqual(await getSuggestionActivity(["contributor"], 20), []);
});

integration("private-profile approvals stay owner-only and network excludes self and unfollowed actors", async () => {
  await UserProfile.updateOne({ userId: "contributor" }, { $set: { isPrivate: true } });
  await Follow.create([{ followerId: "viewer", followingId: "contributor" }, { followerId: "viewer", followingId: "viewer" }]);
  await AlbumSubmission.collection.insertMany([submission(), submission({ submittedByUserId: "viewer" }), submission({ submittedByUserId: "stranger" })]);
  assert.equal((await request("/profile/me/activity")).body.length, 1);
  assert.equal((await request("/profile/contributor/activity", "viewer")).status, 403);
  assert.equal((await request("/profile/contributor/activity", "")).status, 403);
  assert.equal((await request("/profile/me/network", "")).status, 401);
  assert.deepEqual((await request("/profile/me/network", "viewer")).body, []);
  await UserProfile.updateOne({ userId: "contributor" }, { $set: { isPrivate: false } });
  const visible = await request("/profile/me/network", "viewer");
  assert.equal(visible.body.length, 1);
  assert.equal(visible.body[0].userId, "contributor");
});

integration("approvals merge into the newest 20 with stable public-ID ties and no mutation-flag dependency", async () => {
  await Follow.create({ followerId: "viewer", followingId: "contributor" });
  const approvedAt = new Date("2026-11-01T12:00:00Z");
  const rows = Array.from({ length: 22 }, () => submission({ approvedAt }));
  await AlbumSubmission.collection.insertMany(rows);
  const review = await Review.create({ albumCatalogId: album._id, userId: "contributor", rating: 4, reviewText: "Review", date: approvedAt });
  const previous = [process.env.COMMUNITY_SUBMISSIONS_ENABLED, process.env.COMMUNITY_MODERATION_ENABLED];
  process.env.COMMUNITY_SUBMISSIONS_ENABLED = "false";
  process.env.COMMUNITY_MODERATION_ENABLED = "false";
  try {
    const expected = rows.map((row) => `suggestion:${row.submissionId}`).sort().reverse().slice(0, 19);
    for (const [path, userId] of [["/profile/me/activity", "contributor"], ["/profile/me/network", "viewer"]]) {
      const response = await request(path, userId);
      assert.equal(response.status, 200);
      assert.equal(response.body.length, 20);
      assert.deepEqual(response.body.map((row) => row.id), [review.reviewId, ...expected]);
    }
  } finally {
    for (const [i, name] of ["COMMUNITY_SUBMISSIONS_ENABLED", "COMMUNITY_MODERATION_ENABLED"].entries()) {
      if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i];
    }
  }
});
