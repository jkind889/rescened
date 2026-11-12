const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { once } = require("node:events");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const AlbumCatalog = require("../models/AlbumCatalog");
const Artist = require("../models/Artist");
const { newArtistDocument } = require("../lib/artists/identity");
const fixture = require("./fixtures/musicBrainz/browse-radiohead-album-website-default.json");

const enabled = process.env.RUN_MONGO_INTEGRATION === "true";
const integration = (name, fn) => test(name, { skip: !enabled }, fn);
const RADIOHEAD = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
const OK_COMPUTER = "b1392450-e666-3926-a536-22c65f834433";
const saved = {};
let replSet;
let server;
let baseUrl;
let artist;
let album;
const providerCalls = [];

async function request(route) {
  const response = await saved.fetch(`${baseUrl}${route}`);
  return { status: response.status, body: await response.json() };
}

test.before(async () => {
  if (!enabled) return;
  // MusicBrainz is served from the captured fixture; anything else that is
  // not this test server fails, so no live provider can be reached.
  saved.fetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const text = String(url);
    if (text.startsWith("http://127.0.0.1:")) return saved.fetch(url, init);
    if (text.startsWith("https://musicbrainz.org/ws/2/release-group?")) {
      providerCalls.push(new URL(text));
      return new Response(JSON.stringify(fixture), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`Unexpected network request to ${text}`);
  };
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: "rescened_artist_discography" });
  await Promise.all([AlbumCatalog, Artist].map((model) => model.syncIndexes()));
  artist = await Artist.create(newArtistDocument({ name: "Radiohead", artistMbid: RADIOHEAD, source: "import" }));
  album = await AlbumCatalog.create({
    albumId: crypto.randomUUID(), title: "OK Computer (catalog)", artistDisplayName: "Radiohead",
    artistCredits: [{ name: "Radiohead", role: "main", artistId: artist.artistId, artistMbid: RADIOHEAD }],
    releaseType: "album", releaseYear: 1997,
    externalReferences: [{ provider: "musicbrainz", entityType: "release-group", externalId: OK_COMPUTER.toUpperCase() }],
  });
  for (const key of ["ARTIST_PAGES_ENABLED", "ARTIST_DISCOGRAPHY_ENABLED", "EXTERNAL_ALBUM_SEARCH_ENABLED"]) saved[key] = process.env[key];
  process.env.ARTIST_PAGES_ENABLED = "true";
  process.env.ARTIST_DISCOGRAPHY_ENABLED = "true";
  delete process.env.EXTERNAL_ALBUM_SEARCH_ENABLED;
  const app = express();
  app.use("/artists", require("../routes/artists"));
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (!enabled) return;
  for (const key of ["ARTIST_PAGES_ENABLED", "ARTIST_DISCOGRAPHY_ENABLED", "EXTERNAL_ALBUM_SEARCH_ENABLED"]) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
  globalThis.fetch = saved.fetch;
  server?.close();
  await mongoose.disconnect();
  await replSet?.stop();
});

integration("discography reconciles a known release group to its catalog album and writes nothing", async () => {
  const before = { albums: await AlbumCatalog.countDocuments(), artists: await Artist.countDocuments(), revision: (await AlbumCatalog.findById(album._id).lean()).catalogRevision };
  const result = await request(`/artists/${artist.artistId}/discography`);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const body = result.body;
  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].searchParams.get("artist"), RADIOHEAD);
  assert.equal(providerCalls[0].searchParams.get("release-group-status"), "website-default");
  assert.deepEqual([body.type, body.providerCount, body.returned, body.filteredOut, body.nextCursor], ["album", 29, 29, 20, null]);
  assert.deepEqual(body.providerScope, { status: "website-default", primaryType: "album" });
  assert.equal(body.suggestionsAvailable, false);
  assert.equal(body.releases.length, 9);
  const known = body.releases.find((row) => row.externalId === OK_COMPUTER);
  assert.deepEqual([known.kind, known.albumId, known.title], ["catalog", album.albumId, "OK Computer (catalog)"]);
  const external = body.releases.filter((row) => row.kind === "external");
  assert.equal(external.length, 8);
  assert.equal(external.some((row) => "albumId" in row), false, "provider IDs never become albumIds");
  assert.equal(JSON.stringify(body).includes(String(album._id)), false);

  const again = await request(`/artists/${artist.artistId}/discography`);
  assert.equal(again.status, 200);
  assert.equal(providerCalls.length, 1, "the cached page is reused");
  const after = { albums: await AlbumCatalog.countDocuments(), artists: await Artist.countDocuments(), revision: (await AlbumCatalog.findById(album._id).lean()).catalogRevision };
  assert.deepEqual(after, before);
});

integration("discography input errors and an artist without MusicBrainz identity never reach the provider", async () => {
  const calls = providerCalls.length;
  assert.equal((await request(`/artists/${crypto.randomUUID()}/discography`)).body.code, "ARTIST_NOT_FOUND");
  assert.equal((await request(`/artists/${artist.artistId}/discography?type=studio`)).body.code, "INVALID_ARTIST_DISCOGRAPHY");
  const otherArtist = crypto.randomUUID();
  const foreignCursor = Buffer.from(JSON.stringify({ v: 1, a: otherArtist, t: "album", o: 100 })).toString("base64url");
  assert.equal((await request(`/artists/${artist.artistId}/discography?cursor=${foreignCursor}`)).body.code, "INVALID_DISCOGRAPHY_CURSOR");
  await Artist.collection.insertOne({ artistId: crypto.randomUUID(), name: "No MBID", externalReferences: [], fieldProvenance: {}, artistSource: "manual" });
  const noMbid = await Artist.findOne({ name: "No MBID" }).lean();
  const missing = await request(`/artists/${noMbid.artistId}/discography`);
  assert.deepEqual([missing.status, missing.body.code], [404, "ARTIST_DISCOGRAPHY_NOT_AVAILABLE"]);
  assert.deepEqual((await request(`/artists/${noMbid.artistId}`)).body.features, { discography: false }, "no MBID: the page does not mount the section");
  assert.deepEqual((await request(`/artists/${artist.artistId}`)).body.features, { discography: true });
  assert.equal(providerCalls.length, calls);
});
