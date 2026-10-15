const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { once } = require("node:events");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const AlbumCatalog = require("../models/AlbumCatalog");
const AlbumSubmission = require("../models/AlbumSubmission");
const { Genre, GenreEvent } = require("../models/Genre");
const { validateGenreName } = require("../lib/genres/vocabulary");
const { correctionSnapshot, normalizeCorrectionPayload } = require("../routes/utils/submissions");

const enabled = process.env.RUN_MONGO_INTEGRATION === "true";
const integration = (name, fn) => test(name, { skip: !enabled }, fn);
const MODERATOR = "genre-approver";
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
let userCounter = 0;
const genres = {};

async function call(method, route, userId, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { "content-type": "application/json", "x-test-user": userId || "" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function newAlbum(slugs = []) {
  return AlbumCatalog.create({
    albumId: crypto.randomUUID(),
    title: `Album ${crypto.randomUUID().slice(0, 8)}`,
    artistDisplayName: "Artist",
    ...(slugs.length ? { genres: slugs.map((slug) => genres[slug]._id), genresRevision: 1 } : {}),
  });
}

// Each suggestion comes from a fresh contributor, so the per-user rate limit
// and open-suggestion slot never interfere between tests.
async function suggest(album, body) {
  userCounter += 1;
  const result = await call("POST", "/suggestions/genres", `contributor-${userCounter}`, { albumId: album.albumId, ...body });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body;
}

function approve(submissionId, genreDecisions, reason) {
  return call("POST", `/moderation/album-suggestions/${submissionId}/approve`, MODERATOR, { genreDecisions, ...(reason ? { reason } : {}) });
}

async function albumGenres(album) {
  const row = await AlbumCatalog.findById(album._id).populate("genres").lean();
  return { slugs: (row.genres || []).map((genre) => genre.slug), revision: row.genresRevision, row };
}

test.before(async () => {
  if (!enabled) return;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: "rescened_genre_approval" });
  await Promise.all([AlbumCatalog, AlbumSubmission, Genre, GenreEvent].map((model) => model.syncIndexes()));
  const hipHop = await Genre.create({ genreId: crypto.randomUUID(), ...validateGenreName("Hip hop"), aliases: [{ name: "Rap", ...validateGenreName("Rap") }], origin: { source: "seed" } });
  genres["hip-hop"] = hipHop;
  for (const [name, parent] of [["Jazz", null], ["Soul", null], ["Funk", null], ["Disco", null], ["Electronic", null], ["Jazz rap", hipHop._id], ["Vaporwave", null]]) {
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

integration("approval applies additions, removals, and the primary genre once", async () => {
  const album = await newAlbum(["hip-hop", "soul"]);
  const suggestion = await suggest(album, {
    add: [{ genreId: genres.jazz.genreId }, { genreId: genres["jazz-rap"].genreId, primary: true }],
    remove: [genres.soul.genreId],
  });

  const approved = await approve(suggestion.submissionId, { add: [{ decision: "apply" }, { decision: "apply" }], remove: [{ decision: "apply" }], primary: "apply" });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.suggestion.status, "approved");
  assert.equal(approved.body.suggestion.publicationType, "genres_updated");
  assert.equal(approved.body.albumUrl, `/album/${album.albumId}`);
  assert.deepEqual(approved.body.album.genres.map((genre) => genre.slug), ["jazz-rap", "hip-hop", "jazz"]);
  assert.equal(approved.body.idempotent, false);

  const after = await albumGenres(album);
  assert.deepEqual(after.slugs, ["jazz-rap", "hip-hop", "jazz"]);
  assert.equal(after.revision, 2);
  assert.equal(after.row.catalogRevision, 1, "genre approval leaves catalogRevision alone");
  assert.equal(after.row.fieldProvenance.genres.submissionId, suggestion.submissionId);
  assert.equal(after.row.fieldProvenance.genres.approvedByUserId, MODERATOR);

  const event = approved.body.suggestion.moderationHistory.at(-1);
  assert.equal(event.action, "approved");
  assert.equal(event.reason, "Genre suggestion approved.");
  assert.deepEqual(event.genreApplication.add.map((entry) => [entry.decision, entry.genre.slug, entry.resolution]), [["applied", "jazz", "existing"], ["applied", "jazz-rap", "existing"]]);
  assert.deepEqual(event.genreApplication.remove.map((entry) => [entry.decision, entry.genre.slug]), [["applied", "soul"]]);
  assert.equal(event.genreApplication.primary, "applied");
  assert.deepEqual([event.genreApplication.baseGenresRevision, event.genreApplication.resultGenresRevision], [1, 2]);
  const stored = await AlbumSubmission.findOne({ submissionId: suggestion.submissionId }).lean();
  assert.equal(stored.openGenreSuggestionKey, undefined);

  const retry = await approve(suggestion.submissionId, { add: [{ decision: "apply" }, { decision: "apply" }], remove: [{ decision: "apply" }], primary: "apply" });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.idempotent, true);
  assert.equal((await AlbumSubmission.findOne({ submissionId: suggestion.submissionId }).lean()).moderationHistory.length, 2);
  assert.equal((await albumGenres(album)).revision, 2);

  // The public approved feed lists it as a genre update.
  const feed = await call("GET", "/suggestions/approved?limit=50", "");
  const item = feed.body.suggestions.find((row) => row.submissionId === suggestion.submissionId);
  assert.equal(item.publicationType, "genres_updated");
  assert.equal(item.album.albumId, album.albumId);
});

integration("a new name can be created with moderator edits or mapped with an alias", async () => {
  const album = await newAlbum();
  const suggestion = await suggest(album, {
    add: [
      { newGenre: { name: "Lofi hiphop", parentGenreId: genres.electronic.genreId } },
      { newGenre: { name: "Boogie-woogie funk" } },
    ],
  });
  const review = await call("GET", `/moderation/album-suggestions/${suggestion.submissionId}`, MODERATOR);
  assert.equal(review.body.genreReview.stale, false);
  assert.deepEqual(review.body.genreReview.currentGenres, []);
  assert.ok(review.body.genreReview.newGenreCandidates[0].some((row) => row.slug === "hip-hop"));
  assert.ok(review.body.genreReview.newGenreCandidates[1].some((row) => row.slug === "funk"));

  const approved = await approve(suggestion.submissionId, {
    add: [
      { decision: "apply", resolution: { action: "create", name: "Lo-fi hip hop", parentGenreId: genres["hip-hop"].genreId } },
      { decision: "apply", resolution: { action: "map", genreId: genres.funk.genreId, addAlias: true } },
    ],
  }, "Lo-fi belongs under hip hop");
  assert.equal(approved.status, 200, JSON.stringify(approved.body));

  const created = await Genre.findOne({ slug: "lo-fi-hip-hop" }).populate("parent").lean();
  assert.equal(created.name, "Lo-fi hip hop");
  assert.equal(created.parent.slug, "hip-hop");
  assert.deepEqual(created.origin, { source: "community", datasetId: null, submissionId: suggestion.submissionId });
  assert.equal(await GenreEvent.countDocuments({ genre: created._id, action: "create", submissionId: suggestion.submissionId, actorUserId: MODERATOR }), 1);

  const funk = await Genre.findById(genres.funk._id).lean();
  assert.deepEqual(funk.aliases.map((alias) => alias.name), ["Boogie-woogie funk"]);
  assert.equal(await GenreEvent.countDocuments({ genre: funk._id, action: "alias_add" }), 1);

  assert.deepEqual((await albumGenres(album)).slugs, ["lo-fi-hip-hop", "funk"]);
  const application = approved.body.suggestion.moderationHistory.at(-1).genreApplication;
  assert.deepEqual(application.add.map((entry) => entry.resolution), ["created", "mapped"]);
  assert.deepEqual(application.createdGenres.map((genre) => genre.slug), ["lo-fi-hip-hop"]);
  assert.deepEqual(application.aliasesAdded, [{ genre: { genreId: funk.genreId, slug: "funk", name: "Funk" }, alias: "Boogie-woogie funk" }]);
});

integration("a conflict rolls back every write in the approval", async () => {
  const album = await newAlbum(["soul"]);
  const suggestion = await suggest(album, {
    add: [{ newGenre: { name: "Glitch hop" } }, { newGenre: { name: "Space disco" } }],
    remove: [genres.soul.genreId],
  });
  const genresBefore = await Genre.countDocuments();
  const eventsBefore = await GenreEvent.countDocuments();
  // The second resolution renames onto an existing alias ("Rap"), after the
  // first has already inserted a genre inside the transaction.
  const blocked = await approve(suggestion.submissionId, {
    add: [
      { decision: "apply", resolution: { action: "create" } },
      { decision: "apply", resolution: { action: "create", name: "rap" } },
    ],
    remove: [{ decision: "apply" }],
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "GENRE_NAME_CONFLICT");
  assert.equal(blocked.body.details[0].slug, "hip-hop");
  assert.equal(await Genre.countDocuments(), genresBefore);
  assert.equal(await GenreEvent.countDocuments(), eventsBefore);
  assert.deepEqual((await albumGenres(album)).slugs, ["soul"]);
  assert.equal((await AlbumSubmission.findOne({ submissionId: suggestion.submissionId }).lean()).status, "pending");

  // Fixing the decision lets the same suggestion through.
  const fixed = await approve(suggestion.submissionId, {
    add: [{ decision: "apply", resolution: { action: "create" } }, { decision: "skip" }],
    remove: [{ decision: "skip" }],
  });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  assert.deepEqual((await albumGenres(album)).slugs, ["soul", "glitch-hop"]);
});

integration("operations apply to the album's current genres, not the baseline", async () => {
  const album = await newAlbum(["soul"]);
  const first = await suggest(album, { add: [{ genreId: genres.funk.genreId }] });
  const second = await suggest(album, { add: [{ genreId: genres.funk.genreId }, { genreId: genres.disco.genreId }], remove: [genres.soul.genreId] });

  assert.equal((await approve(first.submissionId, { add: [{ decision: "apply" }] })).status, 200);
  const review = await call("GET", `/moderation/album-suggestions/${second.submissionId}`, MODERATOR);
  assert.equal(review.body.genreReview.stale, true);
  assert.deepEqual(review.body.genreReview.currentGenres.map((row) => row.slug), ["soul", "funk"]);

  const approved = await approve(second.submissionId, { add: [{ decision: "apply" }, { decision: "apply" }], remove: [{ decision: "apply" }] });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const application = approved.body.suggestion.moderationHistory.at(-1).genreApplication;
  assert.deepEqual(application.add.map((entry) => entry.decision), ["noop", "applied"]);
  assert.deepEqual((await albumGenres(album)).slugs, ["funk", "disco"]);

  // A suggestion whose accepted operations all turn out to be no-ops is still
  // approved, but leaves the album and its revision untouched.
  const third = await suggest(album, { add: [{ genreId: genres.jazz.genreId }] });
  await AlbumCatalog.updateOne({ _id: album._id }, { $push: { genres: genres.jazz._id }, $inc: { genresRevision: 1 } });
  const revisionBefore = (await albumGenres(album)).revision;
  const noop = await approve(third.submissionId, { add: [{ decision: "apply" }] });
  assert.equal(noop.status, 200);
  assert.equal(noop.body.suggestion.moderationHistory.at(-1).genreApplication.add[0].decision, "noop");
  assert.equal((await albumGenres(album)).revision, revisionBefore);
});

integration("concurrent approvals on one album both land", async () => {
  const album = await newAlbum();
  const [left, right] = await Promise.all([
    suggest(album, { add: [{ genreId: genres.jazz.genreId }] }),
    suggest(album, { add: [{ genreId: genres.soul.genreId }] }),
  ]);
  const results = await Promise.all([
    approve(left.submissionId, { add: [{ decision: "apply" }] }),
    approve(right.submissionId, { add: [{ decision: "apply" }] }),
  ]);
  assert.deepEqual(results.map((result) => result.status), [200, 200], JSON.stringify(results.map((result) => result.body)));
  const after = await albumGenres(album);
  assert.deepEqual([...after.slugs].sort(), ["jazz", "soul"]);
  assert.equal(after.revision, 2);
});

integration("the genre cap, retired genres, and bad decisions are refused without writes", async () => {
  const album = await newAlbum(["hip-hop", "jazz"]);
  const suggestion = await suggest(album, { add: [{ genreId: genres.soul.genreId }, { genreId: genres.funk.genreId }, { newGenre: { name: "Cosmic disco" } }] });
  // Two other approvals fill the album meanwhile.
  await AlbumCatalog.updateOne({ _id: album._id }, { $set: { genres: ["hip-hop", "jazz", "disco", "electronic"].map((slug) => genres[slug]._id), genresRevision: 3 } });
  const genresBefore = await Genre.countDocuments();
  const capped = await approve(suggestion.submissionId, { add: [{ decision: "apply" }, { decision: "apply" }, { decision: "apply", resolution: { action: "create" } }] });
  assert.equal(capped.status, 409);
  assert.equal(capped.body.code, "GENRE_LIMIT_EXCEEDED");
  assert.equal(await Genre.countDocuments(), genresBefore, "the created genre rolled back");

  await Genre.updateOne({ _id: genres.soul._id }, { $set: { status: "retired" } });
  try {
    const retired = await approve(suggestion.submissionId, { add: [{ decision: "apply" }, { decision: "skip" }, { decision: "skip" }] });
    assert.equal(retired.status, 409);
    assert.equal(retired.body.code, "GENRE_RETIRED");
  } finally {
    await Genre.updateOne({ _id: genres.soul._id }, { $set: { status: "active" } });
  }

  const nothing = await approve(suggestion.submissionId, { add: [{ decision: "skip" }, { decision: "skip" }, { decision: "skip" }] });
  assert.equal(nothing.status, 400);
  const mismatch = await approve(suggestion.submissionId, { add: [{ decision: "apply" }] });
  assert.equal(mismatch.status, 400);
  assert.equal((await albumGenres(album)).revision, 3);
  assert.equal((await AlbumSubmission.findOne({ submissionId: suggestion.submissionId }).lean()).status, "pending");

  const fits = await approve(suggestion.submissionId, { add: [{ decision: "apply" }, { decision: "skip" }, { decision: "skip" }] });
  assert.equal(fits.status, 200);
  assert.deepEqual((await albumGenres(album)).slugs, ["hip-hop", "jazz", "disco", "electronic", "soul"]);
});

integration("retired genres don't count toward the cap and are dropped only to make room", async () => {
  const full = await newAlbum(["hip-hop", "jazz", "soul", "funk", "disco"]);
  const roomy = await newAlbum(["disco", "jazz"]);
  await Genre.updateOne({ _id: genres.disco._id }, { $set: { status: "retired" } });
  try {
    // Contributors see four genres on the full album, so a fifth fits.
    const suggestion = await suggest(full, { add: [{ genreId: genres.electronic.genreId }] });
    const approved = await approve(suggestion.submissionId, { add: [{ decision: "apply" }] });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.deepEqual((await albumGenres(full)).slugs, ["hip-hop", "jazz", "soul", "funk", "electronic"]);
    assert.deepEqual(approved.body.suggestion.moderationHistory.at(-1).genreApplication.retiredRemoved.map((genre) => genre.slug), ["disco"]);

    // With room to spare, the retired genre stays for a later merge.
    const kept = await suggest(roomy, { add: [{ genreId: genres.soul.genreId }] });
    assert.equal((await approve(kept.submissionId, { add: [{ decision: "apply" }] })).status, 200);
    assert.deepEqual((await albumGenres(roomy)).slugs, ["disco", "jazz", "soul"]);

    // Jazz is already the first genre anyone sees, so promoting it changes nothing.
    const promote = await call("POST", "/suggestions/genres", "contributor-promote", { albumId: roomy.albumId, primaryGenreId: genres.jazz.genreId });
    assert.equal(promote.status, 400);
  } finally {
    await Genre.updateOne({ _id: genres.disco._id }, { $set: { status: "active" } });
  }
});

integration("a catalog correction keeps the album's genre provenance", async () => {
  const album = await newAlbum();
  const suggestion = await suggest(album, { add: [{ genreId: genres.jazz.genreId }] });
  assert.equal((await approve(suggestion.submissionId, { add: [{ decision: "apply" }] })).status, 200);

  const target = await AlbumCatalog.findById(album._id).lean();
  const payload = normalizeCorrectionPayload({
    albumId: target.albumId,
    proposedChanges: { title: "Corrected Title" },
    supportingSources: [{ type: "official_label", url: "https://example.com/evidence" }],
  }, target);
  const submittedAt = new Date();
  const correction = await AlbumSubmission.create({
    submittedByUserId: "corrector",
    submissionType: "catalog_correction",
    targetAlbumCatalogId: payload.targetAlbumCatalogId,
    baseCatalogRevision: payload.baseCatalogRevision,
    baseValues: payload.baseValues,
    baseProvenance: payload.baseProvenance,
    proposedChanges: payload.proposedChanges,
    supportingSources: payload.supportingSources,
    normalizedFingerprint: payload.normalizedFingerprint,
    revisions: [correctionSnapshot(payload, submittedAt, 1)],
    moderationHistory: [{ actorUserId: "corrector", action: "submitted", createdAt: submittedAt }],
  });
  const corrected = await call("POST", `/moderation/album-suggestions/${correction.submissionId}/approve`, MODERATOR, { applyFields: ["title"] });
  assert.equal(corrected.status, 200, JSON.stringify(corrected.body));

  const after = await AlbumCatalog.findById(album._id).lean();
  assert.equal(after.title, "Corrected Title");
  assert.equal(after.catalogRevision, 2);
  assert.equal(after.fieldProvenance.title.submissionId, correction.submissionId);
  assert.equal(after.fieldProvenance.genres.submissionId, suggestion.submissionId);
  assert.equal(after.genresRevision, 1);
});
