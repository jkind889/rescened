const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { once } = require("node:events");
const express = require("express");
const mongoose = require("mongoose");
const AlbumCatalog = require("../models/AlbumCatalog");
const {
  MAX_ALBUM_GENRES,
  genreMatchKey,
  genreSlug,
  validateGenreName,
} = require("../lib/genres/vocabulary");
const {
  planGenreSeed,
  readGenreDataset,
  sha256,
  validateGenreDataset,
} = require("../lib/genres/seed");
const { parseArgs } = require("../scripts/importGenres");

const DATASET_PATH = path.join(__dirname, "..", "data", "genres", "genres-v1.json");

function dataset(genres) {
  return { schemaVersion: "1.0.0", datasetId: "test-genres", genres };
}

function existingGenre(name, overrides = {}) {
  const identity = validateGenreName(name);
  return {
    _id: new mongoose.Types.ObjectId(),
    genreId: crypto.randomUUID(),
    ...identity,
    aliases: [],
    parent: null,
    status: "active",
    ...overrides,
  };
}

function detailsOf(fn) {
  try {
    fn();
  } catch (error) {
    return error.details.map((detail) => `${detail.pointer} ${detail.message}`);
  }
  throw new Error("expected a validation error");
}

test("spelling variants share one matching key while slugs stay URL-safe", () => {
  assert.equal(genreMatchKey("Hip-Hop"), genreMatchKey("hip  hop"));
  assert.equal(genreMatchKey(" Hip_hop "), "hip hop");
  assert.notEqual(genreMatchKey("Drum & bass"), genreMatchKey("Drum and bass"));
  assert.equal(genreSlug("R&B"), "r-and-b");
  assert.equal(genreSlug("Drum & bass"), genreSlug("Drum and bass"));
  assert.equal(genreSlug("Reguetón"), "regueton");
  assert.equal(genreSlug("Post-rock"), "post-rock");
});

test("genre names are normalized and limited to the allowlist", () => {
  assert.deepEqual(validateGenreName("  Jazz   rap "), { name: "Jazz rap", normalizedName: "jazz rap", slug: "jazz-rap" });
  assert.throws(() => validateGenreName("a"), /2-40 characters/);
  assert.throws(() => validateGenreName("x".repeat(41)), /2-40 characters/);
  assert.throws(() => validateGenreName("<script>"), /may contain/);
  assert.throws(() => validateGenreName("--"), /at least two letters/);
});

test("the album model caps genres at five distinct entries", () => {
  const base = { albumId: crypto.randomUUID(), title: "T", artistDisplayName: "A" };
  const ids = Array.from({ length: MAX_ALBUM_GENRES + 1 }, () => new mongoose.Types.ObjectId());
  assert.equal(new AlbumCatalog({ ...base, genres: ids.slice(0, MAX_ALBUM_GENRES) }).validateSync(), undefined);
  assert.ok(new AlbumCatalog({ ...base, genres: ids }).validateSync()?.errors.genres);
  assert.ok(new AlbumCatalog({ ...base, genres: [ids[0], ids[0]] }).validateSync()?.errors.genres);
  // Albums without genres keep no genre fields, so import inserts are unchanged.
  const plain = new AlbumCatalog(base).toObject();
  assert.equal("genres" in plain, false);
  assert.equal("genresRevision" in plain, false);
});

test("the checked-in seed dataset is valid and matches its checksum", () => {
  const validation = readGenreDataset(DATASET_PATH);
  assert.equal(validation.datasetId, "rescened-genres-v1");
  assert.ok(validation.rows.length >= 100);
  assert.ok(validation.rows.every((row) => !row.parentKey || validation.rows.some((parent) => parent.normalizedName === row.parentKey && !parent.parentKey)));
});

test("a dataset changed after review fails its checksum", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "genres-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "genres.json");
  const text = `${JSON.stringify(dataset([{ name: "Rock" }]))}\n`;
  fs.writeFileSync(file, text);
  assert.throws(() => readGenreDataset(file), { code: "GENRE_DATASET_CHECKSUM_MISSING" });
  fs.writeFileSync(`${file}.sha256`, `${sha256(text)}  genres.json\n`);
  assert.equal(readGenreDataset(file).rows.length, 1);
  fs.writeFileSync(file, text.replace("Rock", "Pop"));
  assert.throws(() => readGenreDataset(file), { code: "GENRE_DATASET_CHECKSUM_MISMATCH" });
});

test("dataset validation rejects duplicates, bad parents, and unknown fields", () => {
  assert.deepEqual(detailsOf(() => validateGenreDataset(dataset([
    { name: "Hip hop" },
    { name: "Hip-Hop" },
  ]))), ['/genres/1/name name "hip hop" is already used at /genres/0/name', '/genres/1/name slug "hip-hop" is already used at /genres/0/name']);

  const problems = detailsOf(() => validateGenreDataset({ ...dataset([
    { name: "Rock", colour: "red" },
    { name: "Indie rock", parent: "Rock" },
    { name: "Slacker rock", parent: "Indie rock" },
    { name: "Ghost", parent: "Missing" },
    { name: "Loop", parent: "loop" },
    { name: "Pop", aliases: ["Rock"] },
  ]), extra: true }));
  assert.ok(problems.includes("/extra unknown field"));
  assert.ok(problems.includes("/genres/0/colour unknown field"));
  assert.ok(problems.some((line) => line.startsWith("/genres/2/parent") && line.includes("one level only")));
  assert.ok(problems.includes("/genres/3/parent must name another genre in this dataset"));
  assert.ok(problems.includes("/genres/4/parent a genre cannot be its own parent"));
  assert.ok(problems.some((line) => line.startsWith("/genres/5/aliases/0")));
});

test("aliases may share their own genre's slug but not another genre's", () => {
  const ok = validateGenreDataset(dataset([{ name: "Drum and bass", aliases: ["Drum & bass", "DnB"] }]));
  assert.equal(ok.rows[0].aliases.length, 2);
  const problems = detailsOf(() => validateGenreDataset(dataset([
    { name: "Drum and bass" },
    { name: "Jungle", aliases: ["Drum & bass"] },
  ])));
  assert.deepEqual(problems, ['/genres/1/aliases/0 slug "drum-and-bass" is already used at /genres/0/name']);
});

test("the seed plan creates new genres and never edits existing ones", () => {
  const validation = validateGenreDataset(dataset([
    { name: "Rock" },
    { name: "Indie rock", parent: "Rock", aliases: ["Indie"] },
    { name: "Hip hop", aliases: ["Rap"] },
    { name: "Jazz rap", parent: "Hip hop" },
    { name: "Jazz" },
  ]));
  const rock = existingGenre("Rock");
  const jazz = existingGenre("Jazz", { name: "jazz" });
  const rap = existingGenre("Rap");
  const plan = planGenreSeed(validation, [rock, jazz, rap]);

  assert.deepEqual(plan.unchanged.map((entry) => entry.name), ["Rock"]);
  assert.deepEqual(plan.drift, [{ rowIndex: 4, name: "Jazz", genreId: jazz.genreId, slug: "jazz", differences: [{ field: "name", current: "jazz", dataset: "Jazz" }] }]);
  assert.deepEqual(plan.create.map((row) => row.name), ["Indie rock"]);
  // "Hip hop" claims the existing "Rap" as an alias, so it and its child wait.
  assert.deepEqual(plan.conflicts.map((entry) => [entry.name, entry.problems[0]]), [
    ["Hip hop", 'alias "Rap" belongs to existing genre "Rap"'],
    ["Jazz rap", "parent genre is blocked by a conflict"],
  ]);
});

test("the seed CLI refuses an apply without the reviewed checksum", () => {
  assert.throws(() => parseArgs(["--input", "x.json", "--apply"]), { code: "INVALID_ARGUMENTS" });
  assert.throws(() => parseArgs(["--input", "x.json", "--expect-sha256", "a".repeat(64)]), { code: "INVALID_ARGUMENTS" });
  assert.throws(() => parseArgs(["--input", "x.json", "--apply", "--dry-run"]), { code: "INVALID_ARGUMENTS" });
  assert.deepEqual(parseArgs(["--input", "x.json", "--apply", "--expect-sha256", "A".repeat(64)]), {
    input: "x.json", report: "", apply: true, expectSha256: "a".repeat(64), help: false,
  });
});

test("genre routes return GENRES_DISABLED while the flag is off", async (t) => {
  const previous = process.env.GENRES_ENABLED;
  delete process.env.GENRES_ENABLED;
  t.after(() => {
    if (previous === undefined) delete process.env.GENRES_ENABLED;
    else process.env.GENRES_ENABLED = previous;
  });
  const app = express();
  app.use("/genres", require("../routes/genres"));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const route of ["/genres/search?q=rock", "/genres/rock"]) {
    const response = await fetch(`${base}${route}`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "GENRES_DISABLED");
  }
});
