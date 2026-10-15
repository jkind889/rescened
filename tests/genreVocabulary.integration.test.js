const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { once } = require("node:events");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const AlbumCatalog = require("../models/AlbumCatalog");
const AlbumSubmission = require("../models/AlbumSubmission");
const { Genre, GenreEvent } = require("../models/Genre");
const { validateGenreName } = require("../lib/genres/vocabulary");
const { main: mergeMain } = require("../scripts/mergeGenres");

const enabled = process.env.RUN_MONGO_INTEGRATION === "true";
const integration = (name, fn) => test(name, { skip: !enabled }, fn);
const MODERATOR = "vocabulary-moderator";
const ENV = { COMMUNITY_MODERATION_ENABLED: "true", GENRES_ENABLED: "true", MODERATOR_USER_IDS: MODERATOR };
let replSet;
let server;
let baseUrl;
let previousEnv;
let workDir;

async function call(method, route, body, userId = MODERATOR) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { "content-type": "application/json", "x-test-user": userId },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function genre(name, extra = {}) {
  return Genre.create({ genreId: crypto.randomUUID(), ...validateGenreName(name), origin: { source: "seed" }, ...extra });
}

async function command(row, action, body) {
  const fresh = await Genre.findById(row._id).lean();
  return call("POST", `/moderation/genres/${fresh.genreId}/${action}`, { expectedRevision: fresh.revision || 0, ...body });
}

function quietOutput() {
  const lines = [];
  return { lines, log: (line) => lines.push(line), error: (line) => lines.push(line) };
}

test.before(async () => {
  if (!enabled) return;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: "rescened_genre_vocabulary" });
  await Promise.all([AlbumCatalog, AlbumSubmission, Genre, GenreEvent].map((model) => model.syncIndexes()));
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "genre-merge-"));
  previousEnv = Object.fromEntries(Object.keys(ENV).map((key) => [key, process.env[key]]));
  Object.assign(process.env, ENV);
  const clerkPath = require.resolve("@clerk/express");
  const previous = require.cache[clerkPath];
  require.cache[clerkPath] = {
    id: clerkPath, filename: clerkPath, loaded: true,
    exports: { getAuth: (req) => ({ userId: req.headers["x-test-user"] || null }), clerkClient: { users: { getUserList: async () => ({ data: [] }) } } },
  };
  const app = express();
  app.use(express.json());
  app.use("/moderation/genres", require("../routes/genreModeration"));
  app.use("/genres", require("../routes/genres"));
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
  fs.rmSync(workDir, { recursive: true, force: true });
});

integration("only moderators can read or change the vocabulary", async () => {
  assert.equal((await call("GET", "/moderation/genres", undefined, "")).status, 401);
  assert.equal((await call("GET", "/moderation/genres", undefined, "someone")).status, 403);
  const rock = await genre("Rock");
  process.env.COMMUNITY_MODERATION_ENABLED = "false";
  try {
    assert.equal((await command(rock, "aliases", { name: "Rock music" })).body.code, "MODERATION_DISABLED");
  } finally {
    process.env.COMMUNITY_MODERATION_ENABLED = "true";
  }
  const list = await call("GET", "/moderation/genres?q=roc", undefined);
  assert.deepEqual(list.body.genres.map((row) => [row.slug, row.revision, row.albumCount, "_id" in row]), [["rock", 0, 0, false]]);
});

integration("rename keeps the old name as an alias and its slug as a redirect", async () => {
  const lofi = await genre("Lofi");
  const renamed = await command(lofi, "rename", { name: "Lo-fi hip hop", reason: "Clearer name" });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.deepEqual([renamed.body.genre.name, renamed.body.genre.slug, renamed.body.genre.aliases, renamed.body.genre.revision], ["Lo-fi hip hop", "lo-fi-hip-hop", ["Lofi"], 1]);
  const viaOldSlug = await call("GET", "/genres/lofi");
  assert.equal(viaOldSlug.body.genre.slug, "lo-fi-hip-hop");
  assert.equal(viaOldSlug.body.canonical, false);

  // Renaming back to an alias promotes it instead of duplicating it.
  const back = await command(lofi, "rename", { name: "Lofi" });
  assert.deepEqual(back.body.genre.aliases, ["Lo-fi hip hop"]);
  // A case-only change adds no alias.
  const cased = await command(lofi, "rename", { name: "LoFi" });
  assert.deepEqual(cased.body.genre.aliases, ["Lo-fi hip hop"]);

  const detail = await call("GET", `/moderation/genres/${renamed.body.genre.genreId}`);
  assert.deepEqual(detail.body.events.map((event) => event.action), ["rename", "rename", "rename"]);
  assert.equal(detail.body.events[2].reason, "Clearer name");
  assert.equal(detail.body.events[0].reason, "Genre renamed by a moderator.");
  assert.equal(detail.body.events[0].actorUserId, MODERATOR);
});

integration("names stay unique across genres and stale revisions are refused", async () => {
  const soul = await genre("Soul");
  const funk = await genre("Funk", { aliases: [{ name: "P-Funk", ...validateGenreName("P-Funk") }] });
  const taken = await command(soul, "rename", { name: "p funk" });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.code, "GENRE_NAME_CONFLICT");
  assert.equal(taken.body.details[0].slug, "funk");
  assert.equal((await command(soul, "aliases", { name: "FUNK" })).body.code, "GENRE_NAME_CONFLICT");
  assert.equal((await command(funk, "aliases", { name: "p-funk" })).status, 400);

  const stale = await call("POST", `/moderation/genres/${soul.genreId}/aliases`, { expectedRevision: 5, name: "Soul music" });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "GENRE_REVISION_CONFLICT");
  const added = await command(soul, "aliases", { name: "Soul music" });
  assert.deepEqual(added.body.genre.aliases, ["Soul music"]);
  assert.equal((await GenreEvent.findOne({ genre: soul._id, action: "alias_add" }).lean()).after.aliases[0], "Soul music");
});

integration("parents nest one level and retiring respects sub-genres", async () => {
  const jazz = await genre("Jazz");
  const bebop = await genre("Bebop", { parent: jazz._id });
  const hardBop = await genre("Hard bop");
  assert.equal((await command(hardBop, "parent", { parentGenreId: bebop.genreId })).body.code, "GENRE_NOT_TOP_LEVEL");
  assert.equal((await command(jazz, "parent", { parentGenreId: hardBop.genreId })).body.code, "GENRE_HAS_CHILDREN");
  assert.equal((await command(jazz, "parent", { parentGenreId: jazz.genreId })).status, 400);
  const moved = await command(hardBop, "parent", { parentGenreId: jazz.genreId });
  assert.deepEqual(moved.body.genre.parent, { genreId: jazz.genreId, slug: "jazz", name: "Jazz", status: "active" });

  const blocked = await command(jazz, "retire", { reason: "Testing" });
  assert.equal(blocked.body.code, "GENRE_HAS_CHILDREN");
  assert.equal((await command(bebop, "retire", {})).status, 400, "retiring needs a reason");

  const retired = await command(bebop, "retire", { reason: "Folded into Jazz" });
  assert.equal(retired.body.genre.status, "retired");
  assert.equal((await call("GET", "/genres/bebop")).body.code, "GENRE_NOT_FOUND");
  assert.equal((await command(bebop, "aliases", { name: "Bop" })).body.code, "GENRE_RETIRED");
  const restored = await command(bebop, "restore", {});
  assert.equal(restored.body.genre.status, "active");
  assert.equal((await command(bebop, "restore", {})).body.code, "INVALID_GENRE_STATE");
  assert.equal((await command(hardBop, "parent", { parentGenreId: null })).body.genre.parent, null);
});

integration("a merge is planned, reviewed, and applied as one transaction", async () => {
  const hipHop = await genre("Hip hop");
  const lofi = await genre("Lo-fi beats", { aliases: [{ name: "Chillhop", ...validateGenreName("Chillhop") }] });
  const lofiHipHop = await genre("Lo-fi hip hop", { parent: hipHop._id });
  const both = await AlbumCatalog.create({ albumId: crypto.randomUUID(), title: "Both", artistDisplayName: "A", genres: [lofi._id, lofiHipHop._id], genresRevision: 2 });
  const only = await AlbumCatalog.create({ albumId: crypto.randomUUID(), title: "Only", artistDisplayName: "B", genres: [hipHop._id, lofi._id], genresRevision: 1 });
  const untouched = await AlbumCatalog.create({ albumId: crypto.randomUUID(), title: "Other", artistDisplayName: "C", genres: [hipHop._id], genresRevision: 1 });
  const report = path.join(workDir, "merge.json");
  const args = ["--from", "lo-fi-beats", "--into", "lo-fi-hip-hop", "--report", report];

  const dry = quietOutput();
  assert.equal(await mergeMain(args, { output: dry }), 0, dry.lines.join("\n"));
  const planned = JSON.parse(fs.readFileSync(report, "utf8"));
  assert.equal(planned.database, "rescened_genre_vocabulary");
  assert.deepEqual(planned.counts, { albums: 2, aliasesMoved: 2, openSuggestionsReferencingFrom: 0 });
  assert.deepEqual(planned.albums.map((album) => [album.title, album.after]), [["Both", ["lo-fi-hip-hop"]], ["Only", ["hip-hop", "lo-fi-hip-hop"]]]);
  assert.equal((await Genre.findById(lofi._id).lean()).status, "active", "a dry run changes nothing");

  const wrong = quietOutput();
  assert.equal(await mergeMain([...args, "--apply", "--expect-plan-sha256", "0".repeat(64)], { output: wrong }), 1);
  assert.match(wrong.lines.join("\n"), /GENRE_MERGE_PLAN_CHANGED/);
  assert.equal((await AlbumCatalog.findById(only._id).lean()).genresRevision, 1);

  const applied = quietOutput();
  assert.equal(await mergeMain([...args, "--apply", "--expect-plan-sha256", planned.planSha256], { output: applied }), 0, applied.lines.join("\n"));
  const after = await AlbumCatalog.find({ _id: { $in: [both._id, only._id, untouched._id] } }).sort({ _id: 1 }).lean();
  assert.deepEqual(after.map((album) => album.genres.map(String)), [[String(lofiHipHop._id)], [String(hipHop._id), String(lofiHipHop._id)], [String(hipHop._id)]]);
  assert.deepEqual(after.map((album) => album.genresRevision), [3, 2, 1]);
  assert.equal(after[0].fieldProvenance.genres.reason, "genre merge");

  const from = await Genre.findById(lofi._id).lean();
  const into = await Genre.findById(lofiHipHop._id).lean();
  assert.equal(from.status, "retired");
  assert.deepEqual(into.aliases.map((alias) => alias.name), ["Lo-fi beats", "Chillhop"]);
  assert.equal(await GenreEvent.countDocuments({ genre: from._id, action: "merge" }), 1);
  assert.equal((await call("GET", "/genres/lo-fi-beats")).body.genre.slug, "lo-fi-hip-hop");
  assert.equal((await call("GET", "/genres/chillhop")).body.genre.slug, "lo-fi-hip-hop");

  // Re-applying the old plan is refused because the plan no longer matches.
  const again = quietOutput();
  assert.equal(await mergeMain([...args, "--apply", "--expect-plan-sha256", planned.planSha256], { output: again }), 1);
  assert.match(again.lines.join("\n"), /GENRE_MERGE_PLAN_CHANGED/);
});

integration("restore refuses a merged genre and a sub-genre of a retired parent", async () => {
  const krautrock = await genre("Krautrock");
  const kosmische = await genre("Kosmische");
  const legacy = await AlbumCatalog.create({ albumId: crypto.randomUUID(), title: "Legacy", artistDisplayName: "D", genres: [kosmische._id], genresRevision: 1 });
  // Some legacy albums store fieldProvenance as null, where a dotted $set fails.
  await AlbumCatalog.collection.updateOne({ _id: legacy._id }, { $set: { fieldProvenance: null } });
  const report = path.join(workDir, "kosmische.json");
  const args = ["--from", "kosmische", "--into", "krautrock", "--report", report];
  const dry = quietOutput();
  assert.equal(await mergeMain(args, { output: dry }), 0, dry.lines.join("\n"));
  const { planSha256 } = JSON.parse(fs.readFileSync(report, "utf8"));
  const applied = quietOutput();
  assert.equal(await mergeMain([...args, "--apply", "--expect-plan-sha256", planSha256], { output: applied }), 0, applied.lines.join("\n"));
  const merged = await AlbumCatalog.findById(legacy._id).lean();
  assert.deepEqual(merged.genres.map(String), [String(krautrock._id)]);
  assert.equal(merged.fieldProvenance.genres.reason, "genre merge");

  // The merged genre's names now belong to Krautrock, so it can't come back.
  const restoreMerged = await command(kosmische, "restore", {});
  assert.equal(restoreMerged.status, 409);
  assert.equal(restoreMerged.body.code, "GENRE_NAME_CONFLICT");
  assert.equal(restoreMerged.body.details[0].slug, "krautrock");
  assert.equal((await call("GET", "/genres/kosmische")).body.genre.slug, "krautrock");

  const ambient = await genre("Ambient X");
  const darkAmbient = await genre("Dark ambient X", { parent: ambient._id });
  await command(darkAmbient, "retire", { reason: "Testing" });
  await command(ambient, "retire", { reason: "Testing" });
  const orphan = await command(darkAmbient, "restore", {});
  assert.equal(orphan.status, 409);
  assert.equal(orphan.body.code, "GENRE_RETIRED");
  assert.equal((await command(ambient, "restore", {})).status, 200);
  assert.equal((await command(darkAmbient, "restore", {})).body.genre.status, "active");
});

integration("a merge refuses a source with sub-genres or a retired target", async () => {
  const parent = await genre("Synth");
  await genre("Synthwave revival", { parent: parent._id });
  const target = await genre("Synth music");
  const children = quietOutput();
  assert.equal(await mergeMain(["--from", "synth", "--into", "synth-music", "--report", path.join(workDir, "children.json")], { output: children }), 1);
  assert.match(children.lines.join("\n"), /GENRE_HAS_CHILDREN/);

  await Genre.updateOne({ _id: target._id }, { $set: { status: "retired" } });
  const retired = quietOutput();
  assert.equal(await mergeMain(["--from", "synthwave-revival", "--into", "synth-music", "--report", path.join(workDir, "retired.json")], { output: retired }), 1);
  assert.match(retired.lines.join("\n"), /GENRE_RETIRED/);
});
