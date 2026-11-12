const assert = require("node:assert/strict");
const test = require("node:test");
const fixture = require("./fixtures/musicBrainz/browse-radiohead-album-website-default.json");
const {
  MAX_PROVIDER_OFFSET,
  buildArtistDiscographyUrl,
  buildSearchUrl,
  createMusicBrainzSearch,
  readBoundedJson,
} = require("../lib/musicBrainzSearch");
const { artistDiscography, decodeDiscographyCursor, encodeDiscographyCursor } = require("../lib/artists/discography");

const RADIOHEAD = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
const OTHER_ARTIST = "33333333-3333-4333-8333-333333333333";
const ARTIST_ID = "11111111-1111-4111-8111-111111111111";

function response(data, { status = 200, headers = {} } = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (name) => headers[name.toLowerCase()] ?? null }, async json() { return data; } };
}

function group(id, overrides = {}) {
  return {
    id,
    title: `Group ${id.slice(0, 4)}`,
    "primary-type": "Album",
    "secondary-types": [],
    "first-release-date": "2001",
    "artist-credit": [{ name: "Radiohead", joinphrase: "", artist: { id: RADIOHEAD, name: "Radiohead" } }],
    ...overrides,
  };
}

const id = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

function client(pages, extra = {}) {
  const calls = [];
  const instance = createMusicBrainzSearch({
    intervalMs: 0,
    fetchFn: async (url) => {
      calls.push(new URL(url));
      const page = typeof pages === "function" ? pages(new URL(url)) : pages.shift();
      return page instanceof Error ? Promise.reject(page) : response(page);
    },
    ...extra,
  });
  return { instance, calls };
}

test("discography browses the verified artist MBID in the website-default view", () => {
  const album = new URL(buildArtistDiscographyUrl(RADIOHEAD.toUpperCase(), "album"));
  assert.equal(album.pathname, "/ws/2/release-group");
  assert.equal(album.searchParams.get("artist"), RADIOHEAD);
  assert.equal(album.searchParams.get("type"), "album");
  assert.equal(album.searchParams.get("release-group-status"), "website-default");
  assert.equal(album.searchParams.get("inc"), "artist-credits");
  assert.equal(album.searchParams.get("limit"), "100");
  assert.equal(album.searchParams.has("offset"), false);
  for (const filter of ["other", "all"]) {
    const url = new URL(buildArtistDiscographyUrl(RADIOHEAD, filter, undefined, { offset: 200 }));
    assert.equal(url.searchParams.has("type"), false, `${filter} is filtered locally`);
    assert.equal(url.searchParams.get("offset"), "200");
  }
  assert.throws(() => buildArtistDiscographyUrl("radiohead", "album"), { code: "INVALID_EXTERNAL_SEARCH" });
  assert.throws(() => buildArtistDiscographyUrl(RADIOHEAD, "studio"), { code: "INVALID_EXTERNAL_SEARCH" });
  assert.throws(() => buildArtistDiscographyUrl(RADIOHEAD, "all", undefined, { offset: MAX_PROVIDER_OFFSET + 1 }), TypeError);
});

test("the captured Radiohead page keeps only plain album groups, newest first", async () => {
  const { instance, calls } = client([fixture]);
  const page = await instance.browseArtistDiscography(RADIOHEAD, { filter: "album" });
  assert.equal(calls.length, 1);
  assert.equal(page.providerCount, 29);
  assert.equal(page.returned, 29);
  assert.equal(page.filteredOut, 20, "live, compilation, remix, demo, and interview groups are hidden");
  assert.deepEqual(page.candidates.map((row) => row.title), [
    "A Moon Shaped Pool", "The King of Limbs", "In Rainbows", "Hail to the Thief", "Amnesiac", "Kid A", "OK Computer", "The Bends", "Pablo Honey",
  ]);
  assert.equal(page.nextOffset, null);
  assert.ok(page.candidates.every((row) => row.kind === "external" && !("albumId" in row)));
});

test("rows whose artist credit does not name the requested MBID are never accepted", async () => {
  const wrong = group(id(2), { "artist-credit": [{ name: "Radiohead", artist: { id: OTHER_ARTIST, name: "Radiohead" } }] });
  const noCredit = group(id(3), { "artist-credit": [] });
  const collaboration = group(id(4), { "artist-credit": [
    { name: "Thom Yorke", joinphrase: " & ", artist: { id: OTHER_ARTIST, name: "Thom Yorke" } },
    { name: "Radiohead", joinphrase: "", artist: { id: RADIOHEAD, name: "Radiohead" } },
  ] });
  const { instance } = client([{ "release-group-count": 4, "release-groups": [group(id(1)), wrong, noCredit, collaboration] }]);
  const page = await instance.browseArtistDiscography(RADIOHEAD, { filter: "all" });
  assert.deepEqual(page.candidates.map((row) => row.externalId).sort(), [id(1), id(4)]);
  assert.equal(page.filteredOut, 2);
});

test("paging advances the raw offset, survives empty filtered pages, and stops at the end", async () => {
  const live = (n) => group(id(n), { "secondary-types": ["Live"] });
  const pages = [
    { "release-group-count": 230, "release-group-offset": 0, "release-groups": Array.from({ length: 100 }, (_, n) => live(n)) },
    { "release-group-count": 230, "release-group-offset": 100, "release-groups": [group(id(500)), group(id(500)), ...Array.from({ length: 98 }, (_, n) => live(100 + n))] },
    { "release-group-count": 230, "release-group-offset": 200, "release-groups": Array.from({ length: 30 }, (_, n) => live(300 + n)) },
  ];
  const { instance, calls } = client(pages);
  const first = await instance.browseArtistDiscography(RADIOHEAD, { filter: "album" });
  assert.deepEqual([first.candidates.length, first.filteredOut, first.nextOffset], [0, 100, 100], "an empty filtered page still has a next page");
  const second = await instance.browseArtistDiscography(RADIOHEAD, { filter: "album", offset: first.nextOffset });
  assert.deepEqual([second.candidates.length, second.returned, second.nextOffset], [1, 100, 200], "duplicates within a page collapse; offset advances by rows returned");
  const third = await instance.browseArtistDiscography(RADIOHEAD, { filter: "album", offset: second.nextOffset });
  assert.equal(third.nextOffset, null);
  assert.deepEqual(calls.map((url) => url.searchParams.get("offset")), [null, "100", "200"]);

  const { instance: emptyClient } = client([{ "release-group-count": 500, "release-groups": [] }]);
  assert.equal((await emptyClient.browseArtistDiscography(RADIOHEAD, { filter: "all", offset: 300 })).nextOffset, null, "no rows means no further paging");

  const { instance: capped } = client([{ "release-group-count": 5000, "release-groups": Array.from({ length: 100 }, (_, n) => group(id(n))) }]);
  const deep = await capped.browseArtistDiscography(RADIOHEAD, { filter: "all", offset: MAX_PROVIDER_OFFSET });
  assert.deepEqual([deep.nextOffset, deep.truncatedAtOffsetCap], [null, true]);
});

test("discography pages are cached and concurrent requests share one provider call", async () => {
  const { instance, calls } = client(() => fixture);
  const [a, b] = await Promise.all([
    instance.browseArtistDiscography(RADIOHEAD, { filter: "album" }),
    instance.browseArtistDiscography(RADIOHEAD, { filter: "album" }),
  ]);
  await instance.browseArtistDiscography(RADIOHEAD, { filter: "album" });
  assert.equal(calls.length, 1);
  assert.deepEqual(a, b);
  await instance.browseArtistDiscography(RADIOHEAD, { filter: "ep" });
  assert.equal(calls.length, 2, "another filter is another page");
});

test("text search and discography share one rate gate", async () => {
  let gateCalls = 0;
  const { instance } = client((url) => (url.searchParams.has("query") ? { count: 0, "release-groups": [] } : fixture), {
    rateGate: async () => { gateCalls += 1; },
  });
  await instance.searchReleaseGroupPage("radiohead");
  await instance.browseArtistDiscography(RADIOHEAD, { filter: "album" });
  assert.equal(gateCalls, 2);
});

test("search pages expose raw provider paging without extra requests", async () => {
  const rows = Array.from({ length: 50 }, (_, n) => group(id(n), { title: `Radiohead ${n}` }));
  const { instance, calls } = client(() => ({ count: 120, "release-groups": rows }));
  const page = await instance.searchReleaseGroupPage("radiohead");
  assert.deepEqual([page.providerCount, page.returned, page.nextOffset, page.candidates.length], [120, 50, 50, 50]);
  await instance.searchReleaseGroupPage("Radiohead");
  assert.equal(calls.length, 1, "the same normalized query reuses the cached page");
  await instance.searchReleaseGroupPage("radiohead", { offset: 50 });
  assert.equal(calls[1].searchParams.get("offset"), "50");
  assert.equal(new URL(buildSearchUrl("air", undefined, { limit: 100 })).searchParams.get("limit"), "100");
  assert.throws(() => buildSearchUrl("air", undefined, { limit: 101 }), TypeError);
});

test("response size is bounded while reading the decoded body, even without Content-Length", async () => {
  async function* chunks() { for (let n = 0; n < 5; n += 1) yield new Uint8Array(1024); }
  let cancelled = false;
  const streamed = { body: Object.assign(chunks(), { cancel: async () => { cancelled = true; } }) };
  await assert.rejects(readBoundedJson(streamed, 3000), { code: "MUSICBRAINZ_RESPONSE_TOO_LARGE" });
  assert.equal(cancelled, true);
  await assert.rejects(readBoundedJson({ text: async () => "x".repeat(4000) }, 3000), { code: "MUSICBRAINZ_RESPONSE_TOO_LARGE" });
  async function* small() { yield Buffer.from('{"release-groups":[]}'); }
  assert.deepEqual(await readBoundedJson({ body: small() }, 3000), { "release-groups": [] });

  const big = JSON.stringify({ "release-group-count": 1, "release-groups": [group(id(1), { title: "x".repeat(4000) })] });
  const instance = createMusicBrainzSearch({
    intervalMs: 0,
    maxResponseBytes: 2000,
    // No Content-Length header: only the streaming bound can stop this.
    fetchFn: async () => ({ ok: true, status: 200, headers: { get: () => null }, body: (async function* () { yield Buffer.from(big); })() }),
  });
  await assert.rejects(instance.browseArtistDiscography(RADIOHEAD, { filter: "all" }), (error) => {
    assert.equal(error.diagnostics.category, "invalid_response");
    return true;
  });
  const declared = createMusicBrainzSearch({ intervalMs: 0, maxResponseBytes: 2000, fetchFn: async () => response({}, { headers: { "content-length": "999999" } }) });
  await assert.rejects(declared.browseArtistDiscography(RADIOHEAD, { filter: "all" }), (error) => {
    assert.equal(error.diagnostics.category, "invalid_response", "a declared oversized body is an invalid response, not a network failure");
    return true;
  });
  const busy = createMusicBrainzSearch({ intervalMs: 0, maxResponseBytes: 2000, fetchFn: async () => response({}, { status: 503, headers: { "content-length": "999999" } }) });
  await assert.rejects(busy.browseArtistDiscography(RADIOHEAD, { filter: "all" }), (error) => {
    assert.deepEqual([error.diagnostics.category, error.diagnostics.upstreamStatus], ["upstream_http", 503]);
    return true;
  });
});

test("discography cursors are bound to artist, filter, and offset bounds", () => {
  const cursor = encodeDiscographyCursor(ARTIST_ID, "album", 100);
  assert.equal(decodeDiscographyCursor(ARTIST_ID, "album", cursor), 100);
  assert.equal(decodeDiscographyCursor(ARTIST_ID, "album", null), 0);
  for (const [artist, filter, value] of [
    ["22222222-2222-4222-8222-222222222222", "album", cursor],
    [ARTIST_ID, "ep", cursor],
    [ARTIST_ID, "album", encodeDiscographyCursor(ARTIST_ID, "album", MAX_PROVIDER_OFFSET + 1)],
    [ARTIST_ID, "album", encodeDiscographyCursor(ARTIST_ID, "album", 0)],
    [ARTIST_ID, "album", "not-a-cursor"],
  ]) {
    assert.throws(() => decodeDiscographyCursor(artist, filter, value), { code: "INVALID_DISCOGRAPHY_CURSOR", status: 400 });
  }
});

function artistModel(artist) {
  return { findOne: () => ({ select: () => ({ lean: async () => artist }) }) };
}

test("discography reconciles known release groups to catalog albums without provider IDs as albumIds", async () => {
  const previous = process.env.EXTERNAL_ALBUM_SEARCH_ENABLED;
  const known = id(1);
  const browse = async (mbid, options) => {
    assert.equal(mbid, RADIOHEAD);
    assert.deepEqual(options, { filter: "album", offset: 100 });
    return { candidates: [
      { kind: "external", externalId: known, title: "Provider Title", artistDisplayName: "Radiohead", releaseType: "album", releaseYear: 2000, cover: "c", sourceUrl: "s" },
      { kind: "external", externalId: id(2), title: "New", artistDisplayName: "Radiohead", releaseType: "album", releaseYear: 2001, cover: "c2", sourceUrl: "s2" },
    ], providerCount: 230, offset: 100, returned: 100, filteredOut: 98, nextOffset: 200, truncatedAtOffsetCap: false };
  };
  const findCatalog = async (mbids) => new Map([[known, { albumId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "Catalog Title", artistDisplayName: "Radiohead", releaseType: "album", releaseYear: 2000, cover: "" }]].filter(([key]) => mbids.includes(key)));
  try {
    process.env.EXTERNAL_ALBUM_SEARCH_ENABLED = "false";
    const result = await artistDiscography(ARTIST_ID.toUpperCase(), { cursor: encodeDiscographyCursor(ARTIST_ID, "album", 100) }, {
      browse, findCatalog, ArtistModel: artistModel({ artistId: ARTIST_ID, externalReferences: [{ provider: "musicbrainz", entityType: "artist", externalId: RADIOHEAD }] }),
    });
    assert.equal(result.releases[0].kind, "catalog");
    assert.equal(result.releases[0].albumId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    assert.equal(result.releases[0].title, "Catalog Title", "local catalog metadata wins");
    assert.equal(result.releases[1].kind, "external");
    assert.equal("albumId" in result.releases[1], false);
    assert.equal(result.suggestionsAvailable, false, "no suggestion action without the prefill lookup");
    assert.deepEqual([result.providerCount, result.offset, result.returned, result.filteredOut], [230, 100, 100, 98]);
    assert.equal(decodeDiscographyCursor(ARTIST_ID, "album", result.nextCursor), 200);
    assert.equal(result.source.view, "website-default");
    assert.deepEqual(result.providerScope, { status: "website-default", primaryType: "album" }, "providerCount is the raw album-type browse total");
    process.env.EXTERNAL_ALBUM_SEARCH_ENABLED = "true";
    const enabled = await artistDiscography(ARTIST_ID, { cursor: encodeDiscographyCursor(ARTIST_ID, "album", 100) }, {
      browse, findCatalog, ArtistModel: artistModel({ artistId: ARTIST_ID, externalReferences: [{ provider: "musicbrainz", entityType: "artist", externalId: RADIOHEAD }] }),
    });
    assert.equal(enabled.suggestionsAvailable, true);
  } finally {
    if (previous === undefined) delete process.env.EXTERNAL_ALBUM_SEARCH_ENABLED; else process.env.EXTERNAL_ALBUM_SEARCH_ENABLED = previous;
  }
});

test("discography rejects bad input before any provider call", async () => {
  let browsed = 0;
  const deps = { browse: async () => { browsed += 1; }, findCatalog: async () => new Map(), ArtistModel: artistModel(null) };
  await assert.rejects(artistDiscography("nope", {}, deps), { code: "INVALID_ARTIST_ID" });
  await assert.rejects(artistDiscography(ARTIST_ID, { type: "studio" }, deps), { code: "INVALID_ARTIST_DISCOGRAPHY" });
  await assert.rejects(artistDiscography(ARTIST_ID, { sort: "date" }, deps), { code: "INVALID_ARTIST_DISCOGRAPHY" });
  await assert.rejects(artistDiscography(ARTIST_ID, { cursor: "bad" }, deps), { code: "INVALID_DISCOGRAPHY_CURSOR" });
  await assert.rejects(artistDiscography(ARTIST_ID, {}, deps), { code: "ARTIST_NOT_FOUND", status: 404 });
  await assert.rejects(artistDiscography(ARTIST_ID, {}, { ...deps, ArtistModel: artistModel({ artistId: ARTIST_ID, externalReferences: [] }) }), { code: "ARTIST_DISCOGRAPHY_NOT_AVAILABLE", status: 404 });
  assert.equal(browsed, 0);
});
