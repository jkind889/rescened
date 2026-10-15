const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { once } = require("node:events");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const AlbumCatalog = require("../models/AlbumCatalog");
const AlbumSubmission = require("../models/AlbumSubmission");
const { Genre } = require("../models/Genre");
const { validateGenreName } = require("../lib/genres/vocabulary");

const enabled = process.env.RUN_MONGO_INTEGRATION === "true";
const integration = (name, fn) => test(name, { skip: !enabled }, fn);
const MODERATOR = "genre-moderator";
const ENV = {
  COMMUNITY_SUBMISSIONS_ENABLED: "true",
  COMMUNITY_MODERATION_ENABLED: "true",
  GENRES_ENABLED: "true",
  MODERATOR_USER_IDS: MODERATOR,
};
let replSet;
let server;
let baseUrl;
let previousEnv;
const genres = {};

async function call(method, route, userId, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { "content-type": "application/json", "x-test-user": userId || "" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function newAlbum(genreSlugs = []) {
  return AlbumCatalog.create({
    albumId: crypto.randomUUID(),
    title: `Album ${crypto.randomUUID().slice(0, 8)}`,
    artistDisplayName: "Artist",
    ...(genreSlugs.length ? { genres: genreSlugs.map((slug) => genres[slug]._id), genresRevision: 1 } : {}),
  });
}

function suggest(userId, album, body) {
  return call("POST", "/suggestions/genres", userId, { albumId: album.albumId, ...body });
}

test.before(async () => {
  if (!enabled) return;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: "rescened_genre_suggestions" });
  await Promise.all([AlbumCatalog, AlbumSubmission, Genre].map((model) => model.syncIndexes()));
  const hipHop = await Genre.create({ genreId: crypto.randomUUID(), ...validateGenreName("Hip hop"), aliases: [{ name: "Rap", ...validateGenreName("Rap") }], origin: { source: "seed" } });
  genres["hip-hop"] = hipHop;
  for (const [name, parent] of [["Jazz", null], ["Soul", null], ["Funk", null], ["Jazz rap", hipHop._id]]) {
    const row = await Genre.create({ genreId: crypto.randomUUID(), ...validateGenreName(name), parent, origin: { source: "seed" } });
    genres[row.slug] = row;
  }

  previousEnv = Object.fromEntries(Object.keys(ENV).map((key) => [key, process.env[key]]));
  Object.assign(process.env, ENV);
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
  app.use("/suggestions", require("../routes/suggestions"));
  app.use("/moderation/album-suggestions", require("../routes/moderation"));
  if (previous) require.cache[clerkPath] = previous;
  else delete require.cache[clerkPath];
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (!enabled) return;
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  server?.close();
  await mongoose.disconnect();
  await replSet?.stop();
});

integration("a contributor creates one open genre suggestion per album", async () => {
  const album = await newAlbum(["hip-hop"]);
  const created = await suggest("alice", album, {
    add: [{ genreId: genres["jazz-rap"].genreId, primary: true }],
    note: "Jazz samples throughout",
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.submissionType, "genre_suggestion");
  assert.equal(created.body.status, "pending");
  assert.equal(created.body.targetAlbumId, album.albumId);
  assert.deepEqual(created.body.baseGenres.map((row) => row.slug), ["hip-hop"]);
  assert.deepEqual(created.body.genreChanges.add, [{ genre: { genreId: genres["jazz-rap"].genreId, slug: "jazz-rap", name: "Jazz rap" } }]);
  assert.deepEqual(created.body.genreChanges.primary, { addIndex: 0 });
  assert.equal(created.body.moderationHistory[0].action, "submitted");

  const again = await suggest("alice", album, { add: [{ genreId: genres.jazz.genreId }] });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "GENRE_SUGGESTION_EXISTS");
  assert.deepEqual(again.body.details, [{ submissionId: created.body.submissionId }]);

  // Another contributor can still suggest for the same album.
  assert.equal((await suggest("bob", album, { add: [{ genreId: genres.soul.genreId }] })).status, 201);

  const open = await call("GET", `/suggestions/genres/open?albumId=${album.albumId}`, "alice");
  assert.equal(open.body.suggestion.submissionId, created.body.submissionId);
  assert.equal((await call("GET", `/suggestions/genres/open?albumId=${album.albumId}`, "carol")).body.suggestion, null);

  const stored = await AlbumSubmission.findOne({ submissionId: created.body.submissionId }).lean();
  assert.equal(stored.openGenreSuggestionKey, `alice:${album._id}`);
  assert.deepEqual(stored.supportingSources, []);
});

integration("concurrent creates for one user and album leave exactly one suggestion", async () => {
  const album = await newAlbum();
  const results = await Promise.all([0, 1, 2].map(() => suggest("dana", album, { add: [{ genreId: genres.funk.genreId }] })));
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409, 409]);
  assert.ok(results.filter((result) => result.status === 409).every((result) => result.body.code === "GENRE_SUGGESTION_EXISTS"));
  assert.equal(await AlbumSubmission.countDocuments({ submittedByUserId: "dana" }), 1);
});

integration("a name that already exists is reported and stored as a reference", async () => {
  const album = await newAlbum();
  const created = await suggest("erin", album, { add: [{ newGenre: { name: "RAP" } }] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(created.body.resolvedNewGenres, [{ name: "RAP", matchedBy: "alias", genre: { genreId: genres["hip-hop"].genreId, slug: "hip-hop", name: "Hip hop" } }]);
  assert.equal(created.body.genreChanges.add[0].genre.slug, "hip-hop");
  assert.equal(await Genre.exists({ normalizedName: "rap" }), null);
});

integration("validation, limit, and flag errors keep their codes", async () => {
  const full = await newAlbum(["hip-hop", "jazz", "soul", "funk", "jazz-rap"]);
  const overLimit = await suggest("frank", full, { add: [{ newGenre: { name: "Lo-fi" } }] });
  assert.equal(overLimit.status, 409);
  assert.equal(overLimit.body.code, "GENRE_LIMIT_EXCEEDED");

  const album = await newAlbum();
  const invalid = await suggest("frank", album, { add: [{ genreId: genres.jazz.genreId }], tags: ["x"] });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, "INVALID_SUBMISSION");
  assert.equal((await call("POST", "/suggestions/genres", "frank", { albumId: crypto.randomUUID(), add: [] })).body.code, "CATALOG_TARGET_NOT_FOUND");
  assert.equal((await call("POST", "/suggestions/genres", "", { albumId: album.albumId })).status, 401);

  process.env.GENRES_ENABLED = "false";
  try {
    assert.equal((await suggest("frank", album, { add: [{ genreId: genres.jazz.genreId }] })).body.code, "GENRES_DISABLED");
  } finally {
    process.env.GENRES_ENABLED = "true";
  }
  process.env.COMMUNITY_SUBMISSIONS_ENABLED = "false";
  try {
    assert.equal((await suggest("frank", album, { add: [{ genreId: genres.jazz.genreId }] })).body.code, "SUBMISSIONS_DISABLED");
  } finally {
    process.env.COMMUNITY_SUBMISSIONS_ENABLED = "true";
  }
  assert.equal(await AlbumSubmission.countDocuments({ submittedByUserId: "frank" }), 0);
});

integration("request changes, revise, reject, and withdraw manage the open slot", async () => {
  const album = await newAlbum(["soul"]);
  const created = await suggest("gina", album, { add: [{ genreId: genres.funk.genreId }] });
  const id = created.body.submissionId;
  const moderate = (action, body) => call("POST", `/moderation/album-suggestions/${id}/${action}`, MODERATOR, body);

  assert.equal((await moderate("request-changes", { reason: "Also add Jazz?" })).status, 200);
  // Needs-changes is still open, so a second create is refused.
  assert.equal((await suggest("gina", album, { add: [{ genreId: genres.jazz.genreId }] })).body.code, "GENRE_SUGGESTION_EXISTS");

  // The album changed meanwhile; revising re-baselines against it.
  await AlbumCatalog.updateOne({ _id: album._id }, { $set: { genres: [genres.soul._id, genres["hip-hop"]._id], genresRevision: 2 } });
  const revised = await call("POST", `/suggestions/${id}/revise`, "gina", { add: [{ genreId: genres.funk.genreId }, { genreId: genres.jazz.genreId }] });
  assert.equal(revised.status, 200, JSON.stringify(revised.body));
  assert.equal(revised.body.status, "pending");
  assert.equal(revised.body.currentRevision, 2);
  assert.deepEqual(revised.body.baseGenres.map((row) => row.slug), ["soul", "hip-hop"]);
  assert.deepEqual(revised.body.revisions.map((revision) => revision.genreChanges.add.length), [1, 2]);
  assert.equal((await AlbumSubmission.findOne({ submissionId: id }).lean()).genreBaseline.genresRevision, 2);

  const rejected = await moderate("reject", { reason: "Funk doesn't fit" });
  assert.equal(rejected.body.suggestion.status, "rejected");
  assert.equal((await AlbumSubmission.findOne({ submissionId: id }).lean()).openGenreSuggestionKey, undefined);

  // The slot is free again; a withdrawal frees it too.
  const second = await suggest("gina", album, { add: [{ genreId: genres.jazz.genreId }] });
  assert.equal(second.status, 201);
  assert.equal((await call("POST", `/suggestions/${second.body.submissionId}/withdraw`, "gina")).body.status, "withdrawn");
  assert.equal((await suggest("gina", album, { add: [{ genreId: genres.jazz.genreId }] })).status, 201);
});

integration("approval needs genre decisions and duplicate marking is refused", async () => {
  const album = await newAlbum();
  const created = await suggest("hana", album, { add: [{ genreId: genres.jazz.genreId }] });
  const id = created.body.submissionId;
  const approve = await call("POST", `/moderation/album-suggestions/${id}/approve`, MODERATOR, { reason: "" });
  assert.equal(approve.status, 400);
  assert.match(approve.body.error, /genreDecisions is required/);
  const withAlbum = await call("POST", `/moderation/album-suggestions/${id}/approve`, MODERATOR, { albumId: album.albumId, genreDecisions: { add: [{ decision: "apply" }] } });
  assert.equal(withAlbum.status, 400);
  const duplicate = await call("POST", `/moderation/album-suggestions/${id}/mark-duplicate`, MODERATOR, { duplicateOfSubmissionId: crypto.randomUUID() });
  assert.equal(duplicate.status, 400);
  const stored = await AlbumSubmission.findOne({ submissionId: id }).lean();
  assert.equal(stored.status, "pending");
  assert.equal(stored.moderationHistory.length, 1);
  assert.equal((await AlbumCatalog.findById(album._id).lean()).genres, undefined);

  const queue = await call("GET", "/moderation/album-suggestions?submissionType=genre_suggestion", MODERATOR);
  assert.equal(queue.status, 200);
  assert.ok(queue.body.suggestions.length > 0);
  assert.ok(queue.body.suggestions.every((row) => row.submissionType === "genre_suggestion"));
});

integration("a contributor can have at most ten proposed genre names waiting", async () => {
  const albums = await Promise.all(Array.from({ length: 6 }, () => newAlbum()));
  const created = [];
  for (let index = 0; index < 5; index += 1) {
    const result = await suggest("ivan", albums[index], { add: [{ newGenre: { name: `Scene ${index}a` } }, { newGenre: { name: `Scene ${index}b` } }] });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    created.push(result.body.submissionId);
  }
  const blocked = await suggest("ivan", albums[5], { add: [{ newGenre: { name: "One more" } }] });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "GENRE_PROPOSAL_LIMIT");
  // Existing genres don't count against the allowance.
  assert.equal((await suggest("ivan", albums[5], { add: [{ genreId: genres.jazz.genreId }] })).status, 201);

  // Revising a suggestion doesn't count its own names twice.
  await call("POST", `/moderation/album-suggestions/${created[0]}/request-changes`, MODERATOR, { reason: "Rename these" });
  const revised = await call("POST", `/suggestions/${created[0]}/revise`, "ivan", { add: [{ newGenre: { name: "Scene renamed" } }, { newGenre: { name: "Scene other" } }] });
  assert.equal(revised.status, 200, JSON.stringify(revised.body));
});
