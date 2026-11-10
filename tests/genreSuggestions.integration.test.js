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

function albumProposal(proposedGenres) {
  return {
    proposedMetadata: { title: `Inline genres ${crypto.randomUUID()}`, artistCredits: [{ name: "Fixture Artist" }], releaseType: "album", releaseDate: "2026", coverSourceUrl: "https://example.com/fixture-cover.jpg" },
    supportingSources: [{ type: "official_artist", url: "https://example.com/fixture-album" }],
    ...(proposedGenres ? { proposedGenres } : {}),
  };
}

integration("album genres stay private until separate moderation, with one atomic and idempotent handoff", async () => {
  const body = albumProposal({ add: [{ genreId: genres.jazz.genreId }, { newGenre: { name: "Inline Dream Jazz" }, primary: true }], note: "Private genre evidence" });
  const albumsBefore = await AlbumCatalog.countDocuments();
  const genresBefore = await Genre.countDocuments();
  const created = await call("POST", "/suggestions", "inline-owner", body);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.proposedGenres.add[0].genre.genreId, genres.jazz.genreId);
  assert.equal(created.body.revisions[0].proposedGenres.note, "Private genre evidence");
  assert.equal(await AlbumCatalog.countDocuments(), albumsBefore);
  assert.equal(await Genre.countDocuments(), genresBefore);
  assert.equal((await call("GET", `/suggestions/${created.body.submissionId}`, "not-owner")).status, 404);
  const approve = () => call("POST", `/moderation/album-suggestions/${created.body.submissionId}/approve`, MODERATOR, {});
  const results = await Promise.all([approve(), approve()]);
  assert.ok(results.every((result) => result.status === 200), JSON.stringify(results));
  const approved = results[0].body;
  const linkedId = approved.suggestion.linkedGenreSubmissionId;
  assert.ok(linkedId);
  assert.equal(results[1].body.suggestion.linkedGenreSubmissionId, linkedId);
  assert.equal(await AlbumSubmission.countDocuments({ sourceAlbumSubmissionId: created.body.submissionId }), 1);
  const album = await AlbumCatalog.findOne({ albumId: approved.album.albumId }).lean();
  assert.deepEqual(album.genres || [], []);
  assert.equal(await Genre.countDocuments(), genresBefore);
  const child = await call("GET", `/suggestions/${linkedId}`, "inline-owner");
  assert.equal(child.status, 200);
  assert.equal(child.body.status, "pending");
  assert.equal(child.body.sourceAlbumSubmissionId, created.body.submissionId);
  assert.equal(child.body.targetAlbumId, album.albumId);
  assert.equal(child.body.genreChanges.note, "Private genre evidence");
  assert.equal((await call("GET", `/suggestions/${linkedId}`, "not-owner")).status, 404);
  const genreApproval = await call("POST", `/moderation/album-suggestions/${linkedId}/approve`, MODERATOR, {
    genreDecisions: { add: [{ decision: "apply" }, { decision: "apply", resolution: { action: "create", name: "Inline Dream Jazz" } }], remove: [], primary: "apply" },
  });
  assert.equal(genreApproval.status, 200, JSON.stringify(genreApproval.body));
  const published = await AlbumCatalog.findById(album._id).lean();
  assert.equal(published.genres.length, 2);
  const primary = await Genre.findById(published.genres[0]).lean();
  assert.equal(primary.name, "Inline Dream Jazz");
});

integration("album revisions retain genre history, reject workflow fields, and allow removing genres when disabled", async () => {
  const body = albumProposal({ add: [{ genreId: genres.jazz.genreId }] });
  const created = await call("POST", "/suggestions", "inline-revise", body);
  assert.equal(created.status, 201);
  const id = created.body.submissionId;
  const request = await call("POST", `/moderation/album-suggestions/${id}/request-changes`, MODERATOR, { reason: "Please revise the genre." });
  assert.equal(request.status, 200, JSON.stringify(request.body));
  process.env.GENRES_ENABLED = "false";
  try {
    const blocked = await call("POST", `/suggestions/${id}/revise`, "inline-revise", body);
    assert.equal(blocked.status, 503);
    assert.equal(blocked.body.code, "GENRES_DISABLED");
    const { proposedGenres, ...withoutGenres } = body;
    const revised = await call("POST", `/suggestions/${id}/revise`, "inline-revise", withoutGenres);
    assert.equal(revised.status, 200, JSON.stringify(revised.body));
    assert.equal(revised.body.proposedGenres, undefined);
    assert.equal(revised.body.revisions.length, 2);
    assert.equal(revised.body.revisions[0].proposedGenres.add.length, 1);
    assert.equal(revised.body.revisions[1].proposedGenres, undefined);
  } finally { process.env.GENRES_ENABLED = "true"; }
  for (const key of ["linkedGenreSubmissionId", "sourceAlbumSubmissionId", "genreChanges"]) {
    const result = await call("POST", "/suggestions", `inline-forged-${key}`, { ...albumProposal(), [key]: crypto.randomUUID() });
    assert.equal(result.status, 400);
  }
});

integration("failed album approval rolls back the queued genre review and catalog publication", async (t) => {
  const created = await call("POST", "/suggestions", "inline-rollback", albumProposal({ add: [{ genreId: genres.jazz.genreId }] }));
  assert.equal(created.status, 201);
  const albumsBefore = await AlbumCatalog.countDocuments();
  const original = AlbumSubmission.findOneAndUpdate;
  const mock = t.mock.method(AlbumSubmission, "findOneAndUpdate", function (query, ...args) {
    if (query.submissionId === created.body.submissionId) return Promise.resolve(null);
    return original.call(this, query, ...args);
  });
  const failed = await call("POST", `/moderation/album-suggestions/${created.body.submissionId}/approve`, MODERATOR, {});
  mock.mock.restore();
  assert.equal(failed.status, 409, JSON.stringify(failed.body));
  assert.equal(failed.body.code, "STATE_CONFLICT");
  assert.equal(await AlbumCatalog.countDocuments(), albumsBefore);
  assert.equal(await AlbumSubmission.countDocuments({ sourceAlbumSubmissionId: created.body.submissionId }), 0);
  assert.equal((await AlbumSubmission.findOne({ submissionId: created.body.submissionId }).lean()).status, "pending");
});

integration("linking to an existing album never overwrites an open genre review", async () => {
  const album = await newAlbum(["hip-hop"]);
  const open = await suggest("inline-link", album, { add: [{ genreId: genres.jazz.genreId }] });
  assert.equal(open.status, 201);
  const created = await call("POST", "/suggestions", "inline-link", albumProposal({ add: [{ genreId: genres.soul.genreId }] }));
  const result = await call("POST", `/moderation/album-suggestions/${created.body.submissionId}/approve`, MODERATOR, { albumId: album.albumId });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.code, "GENRE_SUGGESTION_EXISTS");
  assert.equal(await AlbumSubmission.countDocuments({ sourceAlbumSubmissionId: created.body.submissionId }), 0);
  assert.equal((await AlbumSubmission.findOne({ submissionId: created.body.submissionId }).lean()).status, "pending");
  assert.equal((await AlbumSubmission.findOne({ submissionId: open.body.submissionId }).lean()).genreChanges.additions[0].genre.genreId, genres.jazz.genreId);
});

integration("inline and standalone proposals share the open new-name allowance", async () => {
  for (let index = 0; index < 5; index += 1) {
    const result = await call("POST", "/suggestions", "inline-quota", albumProposal({ add: [
      { newGenre: { name: `Inline scene ${index}a` } }, { newGenre: { name: `Inline scene ${index}b` } },
    ] }));
    assert.equal(result.status, 201, JSON.stringify(result.body));
  }
  const blocked = await call("POST", "/suggestions", "inline-quota", albumProposal({ add: [{ newGenre: { name: "Extra inline scene" } }] }));
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "GENRE_PROPOSAL_LIMIT");
  const target = await newAlbum();
  const standalone = await suggest("inline-quota", target, { add: [{ newGenre: { name: "Extra standalone scene" } }] });
  assert.equal(standalone.status, 409);
  assert.equal(standalone.body.code, "GENRE_PROPOSAL_LIMIT");
});

integration("linking an inline proposal queues its review against current catalog genres", async () => {
  const album = await newAlbum(["hip-hop"]);
  const created = await call("POST", "/suggestions", "inline-link-success", albumProposal({ add: [{ genreId: genres.soul.genreId }] }));
  const approved = await call("POST", `/moderation/album-suggestions/${created.body.submissionId}/approve`, MODERATOR, { albumId: album.albumId });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.suggestion.publicationType, "catalog_linked");
  const child = await AlbumSubmission.findOne({ submissionId: approved.body.suggestion.linkedGenreSubmissionId }).lean();
  assert.equal(String(child.targetAlbumCatalogId), String(album._id));
  assert.equal(child.genreBaseline.genres[0].genreId, genres["hip-hop"].genreId);
  assert.equal(child.genreChanges.additions[0].genre.genreId, genres.soul.genreId);
  const unchanged = await AlbumCatalog.findById(album._id).lean();
  assert.deepEqual(unchanged.genres.map(String), album.genres.map(String));
});

async function openGenreNameCount(userId) {
  const rows = await AlbumSubmission.find({ submittedByUserId: userId, status: { $in: ["pending", "needs_changes"] } }).lean();
  return rows.reduce((total, row) => total + (row.genreChanges?.additions || []).filter((entry) => entry.newGenre).length, 0);
}
function twoNewNames(label) {
  return { add: [{ newGenre: { name: `${label} one` } }, { newGenre: { name: `${label} two` } }] };
}
async function seedEightNames(userId) {
  for (let index = 0; index < 4; index += 1) {
    const result = await call("POST", "/suggestions", userId, albumProposal(twoNewNames(`Seed ${userId.slice(-8)} ${index}`)));
    assert.equal(result.status, 201, JSON.stringify(result.body));
  }
}

integration("concurrent album proposals cannot exceed ten open genre names", async () => {
  const user = "quota-album-race";
  await seedEightNames(user);
  const results = await Promise.all(["Concurrent album A", "Concurrent album B"].map((name) => call("POST", "/suggestions", user, albumProposal(twoNewNames(name)))));
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409], JSON.stringify(results));
  assert.equal(results.find((result) => result.status === 409).body.code, "GENRE_PROPOSAL_LIMIT");
  assert.equal(await openGenreNameCount(user), 10);
});

integration("concurrent album and standalone proposals share an atomic genre quota", async () => {
  const user = "quota-mixed-race";
  await seedEightNames(user);
  const target = await newAlbum();
  const results = await Promise.all([
    call("POST", "/suggestions", user, albumProposal(twoNewNames("Concurrent mixed album"))),
    suggest(user, target, twoNewNames("Concurrent standalone")),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409], JSON.stringify(results));
  assert.equal(await openGenreNameCount(user), 10);
});

integration("concurrent album and standalone revisions cannot exceed the shared name quota", async () => {
  const user = "quota-revise-race";
  await seedEightNames(user);
  const existing = { add: [{ genreId: genres.jazz.genreId }] };
  const albumBody = albumProposal(existing);
  const albumDraft = await call("POST", "/suggestions", user, albumBody);
  const target = await newAlbum();
  const genreDraft = await suggest(user, target, existing);
  for (const draft of [albumDraft, genreDraft]) {
    assert.equal(draft.status, 201);
    assert.equal((await call("POST", `/moderation/album-suggestions/${draft.body.submissionId}/request-changes`, MODERATOR, { reason: "Revise these genre choices." })).status, 200);
  }
  const results = await Promise.all([
    call("POST", `/suggestions/${albumDraft.body.submissionId}/revise`, user, { ...albumBody, proposedGenres: twoNewNames("Revised album genre") }),
    call("POST", `/suggestions/${genreDraft.body.submissionId}/revise`, user, { albumId: target.albumId, ...twoNewNames("Revised standalone genre") }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409], JSON.stringify(results));
  assert.equal(await openGenreNameCount(user), 10);
  const blocked = await AlbumSubmission.findOne({ submissionId: results[0].status === 409 ? albumDraft.body.submissionId : genreDraft.body.submissionId }).lean();
  assert.equal(blocked.currentRevision, 1);
  assert.equal(blocked.status, "needs_changes");
});

integration("simultaneous first genre proposals both succeed when the quota has room", async () => {
  const user = "quota-first-race";
  const targets = await Promise.all([newAlbum(), newAlbum()]);
  const results = await Promise.all(targets.map((target, index) => suggest(user, target, twoNewNames(`First scene ${index}`))));
  assert.deepEqual(results.map((result) => result.status), [201, 201], JSON.stringify(results));
  assert.equal(await openGenreNameCount(user), 4);
});
