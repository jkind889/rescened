const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { once } = require("node:events");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const AlbumCatalog = require("../models/AlbumCatalog");
const Review = require("../models/Reviews");
const { Genre } = require("../models/Genre");
const { validateGenreName } = require("../lib/genres/vocabulary");
const { topGenres } = require("../routes/utils/listeningStats");

const enabled = process.env.RUN_MONGO_INTEGRATION === "true";
const integration = (name, fn) => test(name, { skip: !enabled }, fn);
let replSet;
let server;
let baseUrl;
let previousFlag;
const genres = {};
const albums = {};

async function request(route) {
  const response = await fetch(`${baseUrl}${route}`);
  return { status: response.status, body: await response.json() };
}

async function album(key, title, genreSlugs, ratings = [], reviewedAt = null) {
  const row = await AlbumCatalog.create({
    albumId: crypto.randomUUID(), title, artistDisplayName: `${title} Artist`,
    genres: genreSlugs.map((slug) => genres[slug]._id), genresRevision: 1,
  });
  await Promise.all(ratings.map((rating, index) => Review.create({
    reviewId: crypto.randomUUID(),
    userId: `reviewer-${index}`,
    albumCatalogId: row._id,
    rating,
    reviewText: "Fixture review",
    date: reviewedAt ? new Date(reviewedAt.getTime() + index) : new Date(),
  })));
  albums[key] = row;
  return row;
}

async function pages(route) {
  const titles = [];
  let cursor = null;
  do {
    const separator = route.includes("?") ? "&" : "?";
    const page = await request(`${route}${separator}limit=2${cursor ? `&cursor=${cursor}` : ""}`);
    assert.equal(page.status, 200, JSON.stringify(page.body));
    titles.push(...page.body.albums.map((row) => row.title));
    cursor = page.body.nextCursor;
  } while (cursor);
  return titles;
}

test.before(async () => {
  if (!enabled) return;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: "rescened_genre_browse" });
  await Promise.all([AlbumCatalog, Review, Genre].map((model) => model.syncIndexes()));
  const hipHop = await Genre.create({ genreId: crypto.randomUUID(), ...validateGenreName("Hip hop"), aliases: [{ name: "Rap", ...validateGenreName("Rap") }], origin: { source: "seed" } });
  genres["hip-hop"] = hipHop;
  genres["jazz-rap"] = await Genre.create({ genreId: crypto.randomUUID(), ...validateGenreName("Jazz rap"), parent: hipHop._id, origin: { source: "seed" } });
  genres.jazz = await Genre.create({ genreId: crypto.randomUUID(), ...validateGenreName("Jazz"), origin: { source: "seed" } });

  const day = (n) => new Date(Date.UTC(2026, 8, n));
  await album("classic", "Classic", ["hip-hop"], [5, 4.5, 4.5], day(1));
  await album("solid", "Solid", ["hip-hop", "jazz"], [4, 4, 4, 3.5], day(5));
  await album("fewButHigh", "Few But High", ["hip-hop"], [5], day(9));
  await album("unreviewed", "Unreviewed", ["hip-hop"]);
  await album("childOnly", "Child Only", ["jazz-rap"], [3, 3, 3], day(3));
  await album("jazzOnly", "Jazz Only", ["jazz"], [5, 5, 5], day(2));

  previousFlag = process.env.GENRES_ENABLED;
  process.env.GENRES_ENABLED = "true";
  const app = express();
  app.use("/genres", require("../routes/genres"));
  app.use("/search", require("../routes/search"));
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
});

integration("rating order puts well-reviewed albums first and includes sub-genres", async () => {
  const first = await request("/genres/hip-hop/albums");
  assert.equal(first.status, 200);
  assert.equal(first.body.minimumReviews, 3);
  assert.equal(first.body.includeChildren, true);
  assert.deepEqual(first.body.albums.map((row) => row.title), ["Classic", "Solid", "Child Only", "Few But High", "Unreviewed"]);
  assert.deepEqual(first.body.albums[0], {
    albumId: albums.classic.albumId, title: "Classic", artistDisplayName: "Classic Artist", releaseYear: null,
    releaseType: "album", cover: "", reviewCount: 3, averageRating: 4.7,
  });
  assert.equal(first.body.albums.at(-1).averageRating, null);
  assert.equal(JSON.stringify(first.body).includes(String(albums.classic._id)), false);

  const parentOnly = await request("/genres/hip-hop/albums?includeChildren=false");
  assert.equal(parentOnly.body.albums.some((row) => row.title === "Child Only"), false);
  assert.deepEqual((await request("/genres/jazz-rap/albums")).body.albums.map((row) => row.title), ["Child Only"]);
});

integration("both orders page with stable cursors", async () => {
  assert.deepEqual(await pages("/genres/hip-hop/albums"), ["Classic", "Solid", "Child Only", "Few But High", "Unreviewed"]);
  assert.deepEqual(await pages("/genres/hip-hop/albums?sort=recent"), ["Few But High", "Solid", "Child Only", "Classic", "Unreviewed"]);
  const viaAlias = await request("/genres/rap/albums?sort=recent&limit=1");
  assert.equal(viaAlias.body.genre.slug, "hip-hop");
  assert.equal(viaAlias.body.canonical, false);

  const ratingPage = await request("/genres/hip-hop/albums?limit=1");
  const crossed = await request(`/genres/hip-hop/albums?sort=recent&cursor=${ratingPage.body.nextCursor}`);
  assert.equal(crossed.status, 400);
  assert.equal(crossed.body.code, "INVALID_GENRE_CURSOR");
  assert.equal((await request("/genres/hip-hop/albums?cursor=nonsense")).body.code, "INVALID_GENRE_CURSOR");
  assert.equal((await request("/genres/hip-hop/albums?sort=popular")).body.code, "INVALID_GENRE_BROWSE");
  assert.equal((await request("/genres/hip-hop/albums?limit=500")).status, 400);
  assert.equal((await request("/genres/polka/albums")).body.code, "GENRE_NOT_FOUND");
});

integration("local search can be filtered to a genre and its sub-genres", async () => {
  const all = await request("/search/search?q=only&page=1");
  assert.deepEqual(all.body.results.map((row) => row.title).sort(), ["Child Only", "Jazz Only"]);
  const filtered = await request("/search/search?q=only&genre=hip-hop&page=1");
  assert.deepEqual(filtered.body.results.map((row) => row.title), ["Child Only"]);
  assert.equal(filtered.body.genre.slug, "hip-hop");
  const plain = await request("/search/search?q=only&genre=jazz");
  assert.deepEqual(plain.body.map((row) => row.title), ["Jazz Only"]);
  assert.equal((await request("/search/search?q=only&genre=polka")).body.code, "GENRE_NOT_FOUND");

  process.env.GENRES_ENABLED = "false";
  try {
    assert.equal((await request("/search/search?q=only&genre=jazz")).body.code, "GENRES_DISABLED");
    assert.equal((await request("/search/search?q=only")).status, 200, "unfiltered search is unaffected");
  } finally {
    process.env.GENRES_ENABLED = "true";
  }
});

integration("top genres weight each genre by its albums' listens", async () => {
  const rows = [
    { listenCount: 5, lastListenedOn: "2026-09-02", album: { genres: [genres["hip-hop"]._id, genres.jazz._id] } },
    { listenCount: 2, lastListenedOn: "2026-09-08", album: { genres: [genres.jazz._id] } },
    { listenCount: 1, lastListenedOn: "2026-09-09", album: { genres: [genres["jazz-rap"]._id] } },
    { listenCount: 4, lastListenedOn: "2026-09-01", album: {} },
  ];
  assert.deepEqual((await topGenres(rows)).map((row) => [row.genre.slug, row.listenCount, row.albumCount]), [
    ["jazz", 7, 2], ["hip-hop", 5, 1], ["jazz-rap", 1, 1],
  ]);
  await Genre.updateOne({ _id: genres["jazz-rap"]._id }, { $set: { status: "retired" } });
  try {
    assert.equal((await topGenres(rows)).some((row) => row.genre.slug === "jazz-rap"), false);
  } finally {
    await Genre.updateOne({ _id: genres["jazz-rap"]._id }, { $set: { status: "active" } });
  }
  assert.deepEqual(await topGenres([{ listenCount: 1, lastListenedOn: "2026-09-01", album: {} }]), []);
});
