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
const { Genre, GenreEvent } = require("../models/Genre");
const { main: importMain } = require("../scripts/importGenres");
const { readGenreDataset, sha256 } = require("../lib/genres/seed");

const enabled = process.env.RUN_MONGO_INTEGRATION === "true";
const integration = (name, fn) => test(name, { skip: !enabled }, fn);
const DATASET_PATH = path.join(__dirname, "..", "data", "genres", "genres-v1.json");
let replSet;
let server;
let baseUrl;
let workDir;
let previousFlag;

function quietOutput() {
  const lines = [];
  return { lines, log: (line) => lines.push(line), error: (line) => lines.push(line) };
}

// Copies a dataset into the scratch directory with a matching sidecar.
function writeDataset(name, genres) {
  const file = path.join(workDir, `${name}.json`);
  const text = `${JSON.stringify({ schemaVersion: "1.0.0", datasetId: name, genres }, null, 2)}\n`;
  fs.writeFileSync(file, text);
  fs.writeFileSync(`${file}.sha256`, `${sha256(text)}  ${name}.json\n`);
  return { file, sha: sha256(text) };
}

async function request(route) {
  const response = await fetch(`${baseUrl}${route}`);
  return { status: response.status, body: await response.json() };
}

test.before(async () => {
  if (!enabled) return;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: "rescened_genres" });
  await Promise.all([AlbumCatalog, Genre, GenreEvent].map((model) => model.syncIndexes()));
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "genres-integration-"));
  previousFlag = process.env.GENRES_ENABLED;
  process.env.GENRES_ENABLED = "true";
  const app = express();
  app.use("/genres", require("../routes/genres"));
  app.use("/albums", require("../routes/album"));
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (!enabled) return;
  if (previousFlag === undefined) delete process.env.GENRES_ENABLED;
  else process.env.GENRES_ENABLED = previousFlag;
  server?.close();
  await mongoose.disconnect();
  await replSet?.stop();
  fs.rmSync(workDir, { recursive: true, force: true });
});

integration("a dry run writes a report and changes nothing", async () => {
  const report = path.join(workDir, "dry-run.json");
  const output = quietOutput();
  const exitCode = await importMain(["--input", DATASET_PATH, "--report", report], { output });
  assert.equal(exitCode, 0, output.lines.join("\n"));
  const written = JSON.parse(fs.readFileSync(report, "utf8"));
  const { rows, sha256: datasetSha } = readGenreDataset(DATASET_PATH);
  assert.equal(written.mode, "dry-run");
  assert.equal(written.database, "rescened_genres");
  assert.equal(written.datasetSha256, datasetSha);
  assert.equal(written.counts.create, rows.length);
  assert.equal(await Genre.countDocuments(), 0);
});

integration("apply needs the reviewed checksum, then seeds genres with audit events once", async () => {
  const report = path.join(workDir, "apply.json");
  const { rows, sha256: datasetSha } = readGenreDataset(DATASET_PATH);

  const wrong = quietOutput();
  assert.equal(await importMain(["--input", DATASET_PATH, "--report", report, "--apply", "--expect-sha256", "0".repeat(64)], { output: wrong }), 1);
  assert.match(wrong.lines.join("\n"), /GENRE_DATASET_CHECKSUM_MISMATCH/);
  assert.equal(await Genre.countDocuments(), 0);

  const output = quietOutput();
  assert.equal(await importMain(["--input", DATASET_PATH, "--report", report, "--apply", "--expect-sha256", datasetSha], { output }), 0, output.lines.join("\n"));
  assert.equal(await Genre.countDocuments(), rows.length);
  assert.equal(await GenreEvent.countDocuments({ action: "create", datasetSha256: datasetSha }), rows.length);
  const jazzRap = await Genre.findOne({ slug: "jazz-rap" }).populate("parent").lean();
  assert.equal(jazzRap.parent.slug, "hip-hop");
  assert.deepEqual(jazzRap.origin, { source: "seed", datasetId: "rescened-genres-v1", submissionId: null });
  assert.equal(JSON.parse(fs.readFileSync(report, "utf8")).created.length, rows.length);

  // A second apply finds every genre unchanged and writes nothing.
  const again = quietOutput();
  assert.equal(await importMain(["--input", DATASET_PATH, "--report", report, "--apply", "--expect-sha256", datasetSha], { output: again }), 0);
  assert.equal(await Genre.countDocuments(), rows.length);
  assert.equal(await GenreEvent.countDocuments(), rows.length);
});

integration("a conflicting dataset is refused without partial writes", async () => {
  const before = await Genre.countDocuments();
  const { file, sha } = writeDataset("conflicting-genres", [
    { name: "Bedroom pop" },
    { name: "Lo-fi", aliases: ["Rap"] },
  ]);
  const output = quietOutput();
  assert.equal(await importMain(["--input", file, "--apply", "--expect-sha256", sha], { output }), 1);
  assert.match(output.lines.join("\n"), /GENRE_SEED_CONFLICT/);
  assert.equal(await Genre.countDocuments(), before);
  assert.equal(await Genre.exists({ slug: "bedroom-pop" }), null);
});

integration("genre search matches names, word starts, and aliases", async () => {
  const exact = await request("/genres/search?q=jazz");
  assert.equal(exact.status, 200);
  assert.equal(exact.body.results[0].slug, "jazz");
  assert.ok(exact.body.results.some((genre) => genre.slug === "jazz-rap"));

  const alias = await request("/genres/search?q=rap");
  assert.deepEqual(alias.body.results[0], { genreId: alias.body.results[0].genreId, slug: "hip-hop", name: "Hip hop", matchedAlias: "Rap" });
  assert.ok(alias.body.results.some((genre) => genre.slug === "cloud-rap"));
  for (const genre of alias.body.results) assert.equal("_id" in genre, false);

  assert.deepEqual((await request("/genres/search?q=")).body.results, []);

  const topLevel = await request("/genres");
  assert.equal(topLevel.body.results.length, 20);
  assert.deepEqual(topLevel.body.results[0], { genreId: topLevel.body.results[0].genreId, slug: "african-music", name: "African music" });
  assert.equal(topLevel.body.results.some((genre) => genre.slug === "jazz-rap"), false);
});

integration("genre detail resolves aliases and hides retired genres", async () => {
  const hipHop = await Genre.findOne({ slug: "hip-hop" });
  await AlbumCatalog.create({ albumId: crypto.randomUUID(), title: "Tagged", artistDisplayName: "Artist", genres: [hipHop._id] });

  const detail = await request("/genres/hip-hop");
  assert.equal(detail.status, 200);
  assert.equal(detail.body.canonical, true);
  assert.equal(detail.body.parent, null);
  assert.equal(detail.body.albumCount, 1);
  assert.ok(detail.body.children.some((genre) => genre.slug === "jazz-rap"));
  assert.deepEqual(detail.body.aliases, ["Rap"]);

  const viaAlias = await request("/genres/rnb");
  assert.equal(viaAlias.body.genre.slug, "r-and-b");
  assert.equal(viaAlias.body.canonical, false);

  await Genre.updateOne({ slug: "vaporwave" }, { $set: { status: "retired" } });
  assert.equal((await request("/genres/vaporwave")).body.code, "GENRE_NOT_FOUND");
  assert.equal((await request("/genres/electronic")).body.children.some((genre) => genre.slug === "vaporwave"), false);
});

integration("album detail lists active genres in stored order without internal ids", async () => {
  const [jazz, jazzRap, vaporwave] = await Promise.all(["jazz", "jazz-rap", "vaporwave"].map((slug) => Genre.findOne({ slug })));
  const album = await AlbumCatalog.create({
    albumId: crypto.randomUUID(),
    title: "Ordered",
    artistDisplayName: "Artist",
    genres: [jazzRap._id, vaporwave._id, jazz._id],
    genresRevision: 1,
  });

  const detail = await request(`/albums/album/${album.albumId}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.genres.map((genre) => genre.slug), ["jazz-rap", "jazz"]);
  assert.equal("genresRevision" in detail.body, false);

  const untagged = await AlbumCatalog.create({ albumId: crypto.randomUUID(), title: "Plain", artistDisplayName: "Artist" });
  assert.deepEqual((await request(`/albums/album/${untagged.albumId}`)).body.genres, []);

  process.env.GENRES_ENABLED = "false";
  try {
    assert.equal("genres" in (await request(`/albums/album/${album.albumId}`)).body, false);
  } finally {
    process.env.GENRES_ENABLED = "true";
  }
});
