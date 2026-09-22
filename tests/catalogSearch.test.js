const assert = require("node:assert/strict");
const test = require("node:test");

const AlbumCatalog = require("../models/AlbumCatalog");
const searchRouter = require("../routes/search");
const albumRouter = require("../routes/album");

const ORIGINAL_COUNT_DOCUMENTS = AlbumCatalog.countDocuments;
const ORIGINAL_FIND = AlbumCatalog.find;
const ORIGINAL_AGGREGATE = AlbumCatalog.aggregate;
const { buildRankedSearchPattern } = require("../routes/utils/catalogSearch");
const { preferredArtistsForQuery } = require("../routes/utils/searchArtistAliases");
const ALBUM_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const ENDPOINTS = [
  { name: "/search/search", router: searchRouter, path: "/search", extract: (body) => body },
  { name: "/albums/catalog", router: albumRouter, path: "/catalog", extract: (body) => body.results },
];

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function callRoute(router, method, path, req = {}) {
  const route = router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]);
  assert.ok(route, `${method.toUpperCase()} ${path} should be registered`);
  const res = response();
  for (const handler of route.route.stack.map((layer) => layer.handle)) {
    let nextCalled = false;
    await handler(req, res, () => { nextCalled = true; });
    if (!nextCalled) break;
  }
  return { status: res.statusCode, body: res.body };
}

function fieldValues(album, field) {
  if (field === "artistCredits.name") return album.artistCredits.map((credit) => credit.name);
  return [album[field]];
}

function matchingAlbums(query, albums) {
  function matches(clause, album) {
    if (clause.$or) return clause.$or.some((child) => matches(child, album));
    if (clause.$and) return clause.$and.every((child) => matches(child, album));
    const [field, condition] = Object.entries(clause)[0];
    const regex = new RegExp(condition.$regex, condition.$options);
    return fieldValues(album, field).some((value) => regex.test(String(value || "")));
  }
  return albums.filter((album) => matches(query, album));
}

function installCatalogMock(albums) {
  AlbumCatalog.aggregate = async (pipeline) => matchingAlbums(pipeline[0].$match, albums);
  AlbumCatalog.countDocuments = async (query) => matchingAlbums(query, albums).length;
  AlbumCatalog.find = (query) => {
    let rows = matchingAlbums(query, albums);
    return {
      sort() { return this; },
      skip(value) { rows = rows.slice(value); return this; },
      limit(value) { return Promise.resolve(rows.slice(0, value)); },
    };
  };
}

function albumWithArtist(artistDisplayName) {
  return {
    albumId: ALBUM_ID,
    title: "Appetite for Destruction",
    artistDisplayName,
    artistCredits: [{ name: artistDisplayName, role: "main" }],
    releaseType: "album",
    releaseDate: "1987",
    releaseDatePrecision: "year",
    releaseYear: 1987,
    cover: "",
    tracks: [],
    label: "",
  };
}

test.afterEach(() => {
  AlbumCatalog.countDocuments = ORIGINAL_COUNT_DOCUMENTS;
  AlbumCatalog.find = ORIGINAL_FIND;
  AlbumCatalog.aggregate = ORIGINAL_AGGREGATE;
});

test("ranked patterns fold Latin accents while preserving scripts and literal punctuation", () => {
  for (const [query, matches, misses] of [
    ["bjork", ["Björk", "Bjo\u0308rk"], ["Bjork Tribute!"]],
    ["Björk", ["bjork", "Björk"], ["Bjoerk"]],
    ["Cafe\u0301", ["Café", "Cafe\u0301", "Cafe"], ["Coffee"]],
    ["Signals [Live]", ["Signals [Live]"], ["Signals Live"]],
    [".*", [".*"], ["anything"]],
    ["Daft Punk|Air", ["Daft Punk|Air"], ["Daft Punk", "Air"]],
    ["宇多田ヒカル", ["宇多田ヒカル"], ["Utada Hikaru"]],
  ]) {
    const pattern = new RegExp(`^${buildRankedSearchPattern(query)}$`, "i");
    for (const value of matches) assert.ok(pattern.test(value), `${query} matches ${value}`);
    for (const value of misses) assert.ok(!pattern.test(value), `${query} excludes ${value}`);
  }
});

test("artist aliases normalize whole queries without expanding unrelated words", () => {
  assert.deepEqual(preferredArtistsForQuery("  yE  "), ["Kanye West", "Ye"]);
  assert.deepEqual(preferredArtistsForQuery("PIERRE   BOURNE"), ["Pi'erre Bourne", "Pierre Bourne"]);
  assert.deepEqual(preferredArtistsForQuery("Pi’erre"), ["Pi'erre Bourne", "Pierre Bourne"]);
  assert.deepEqual(preferredArtistsForQuery("Travis"), ["Travis Scott"]);
  for (const query of ["yellow", "yesterday", "ye.*", "Travis Barker", "Pierre Henry", "ye graduation"]) {
    assert.deepEqual(preferredArtistsForQuery(query), [], query);
  }
});

test("ASCII apostrophe queries match typographic apostrophes on both catalog endpoints", async () => {
  installCatalogMock([albumWithArtist("Guns N’ Roses")]);

  for (const endpoint of ENDPOINTS) {
    const result = await callRoute(endpoint.router, "get", endpoint.path, {
      query: { q: "Guns N' Roses" },
    });

    assert.equal(result.status, 200, endpoint.name);
    assert.deepEqual(endpoint.extract(result.body).map((album) => album.albumId), [ALBUM_ID], endpoint.name);
  }
});

test("typographic apostrophe queries match ASCII apostrophes on both catalog endpoints", async () => {
  installCatalogMock([albumWithArtist("Guns N' Roses")]);

  for (const endpoint of ENDPOINTS) {
    const result = await callRoute(endpoint.router, "get", endpoint.path, {
      query: { q: "Guns N’ Roses" },
    });

    assert.equal(result.status, 200, endpoint.name);
    assert.deepEqual(endpoint.extract(result.body).map((album) => album.albumId), [ALBUM_ID], endpoint.name);
  }
});
