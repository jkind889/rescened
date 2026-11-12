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

const enabled = process.env.RUN_MONGO_INTEGRATION === "true";
const integration = (name, fn) => test(name, { skip: !enabled }, fn);
const BTS_MBID = "0d79fe8e-ba27-4859-bb8c-2f255f346853";
const mbid = () => crypto.randomUUID();
let replSet;
let server;
let baseUrl;
let previousFlag;
let realFetch;
const artists = {};
const albums = {};

async function request(route) {
  const response = await realFetch(`${baseUrl}${route}`);
  return { status: response.status, body: await response.json() };
}

async function artist(key, name, artistMbid = mbid()) {
  artists[key] = await Artist.create(newArtistDocument({ name, artistMbid, source: "import" }));
  return artists[key];
}

function credit(name, key, role = "main") {
  return { name, role, ...(key ? { artistId: artists[key].artistId } : {}) };
}

async function album(key, title, credits, extra = {}) {
  albums[key] = await AlbumCatalog.create({
    albumId: crypto.randomUUID(),
    title,
    artistDisplayName: credits.map((entry) => entry.name).join(" & "),
    artistCredits: credits,
    ...extra,
  });
  return albums[key];
}

async function allReleases(route) {
  const titles = [];
  let cursor = null;
  do {
    const separator = route.includes("?") ? "&" : "?";
    const page = await request(`${route}${separator}limit=2${cursor ? `&cursor=${cursor}` : ""}`);
    assert.equal(page.status, 200, JSON.stringify(page.body));
    assert.ok(page.body.releases.length <= 2);
    titles.push(...page.body.releases.map((row) => row.title));
    cursor = page.body.nextCursor;
  } while (cursor);
  return titles;
}

test.before(async () => {
  if (!enabled) return;
  // Local artist pages must never reach a provider.
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, ...rest) => {
    if (!String(url).startsWith("http://127.0.0.1:")) throw new Error(`Unexpected network request to ${url}`);
    return realFetch(url, ...rest);
  };
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { dbName: "rescened_artist_pages" });
  await Promise.all([AlbumCatalog, Artist].map((model) => model.syncIndexes()));

  await artist("loona", "LOONA");
  await artist("bts", "BTS", BTS_MBID);
  await artist("jay", "JAY-Z");
  await artist("kanye", "Kanye West");
  await artist("vSinger", "V");
  await artist("vBand", "V");
  await artist("quiet", "Quiet Artist");

  await album("loonaKo", "[+ +]", [credit("이달의 소녀", "loona")], { releaseType: "album", releaseYear: 2018, releaseDate: "2018-08-20" });
  await album("loonaEn", "[X X]", [credit("LOONA", "loona")], { releaseType: "album", releaseYear: 2019, releaseDate: "2019-02-19" });
  await album("loonaEp", "Flip That", [credit("LOONA", "loona")], { releaseType: "ep", releaseYear: 2022, releaseDate: "2022-06-20" });
  await album("loonaSingle", "Butterfly", [credit("LOONA", "loona")], { releaseType: "single", releaseYear: 2019, releaseDate: "2019-02-19" });
  await album("loonaUndated", "Undated", [credit("LOONA", "loona")], { releaseType: "mixtape" });
  await album("loonaLive", "Live", [credit("LOONA", "loona")], { releaseType: "live", releaseYear: 2020, releaseDate: "2020" });
  await album("bts", "Map of the Soul: 7", [credit("BTS", "bts")], { releaseYear: 2020 });
  await album("throne", "Watch the Throne", [credit("JAY-Z", "jay"), credit("Kanye West", "kanye")], { releaseYear: 2011 });
  await album("feature", "Guest Spot", [credit("JAY-Z", "jay"), credit("Kanye West", "kanye", "featured")], { releaseYear: 2012 });
  await album("vSolo", "Layover", [credit("V", "vSinger")], { releaseYear: 2023 });
  await album("vBand", "V Band LP", [credit("V", "vBand")], { releaseYear: 1999 });
  // A display string that names Kanye but carries no identity stays unlinked.
  await album("unlinked", "Name Only", [credit("JAY-Z & Kanye West")], { releaseYear: 2013 });
  // An identity the registry does not hold is not linked on the album page.
  await album("orphan", "Orphan Credit", [{ name: "Ghost", role: "main", artistId: crypto.randomUUID() }, credit("JAY-Z", "jay")]);

  previousFlag = process.env.ARTIST_PAGES_ENABLED;
  process.env.ARTIST_PAGES_ENABLED = "true";
  const app = express();
  app.use("/artists", require("../routes/artists"));
  app.use("/search", require("../routes/search"));
  app.use("/albums", require("../routes/album"));
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (!enabled) return;
  if (previousFlag === undefined) delete process.env.ARTIST_PAGES_ENABLED;
  else process.env.ARTIST_PAGES_ENABLED = previousFlag;
  globalThis.fetch = realFetch;
  server?.close();
  await mongoose.disconnect();
  await replSet?.stop();
});

integration("artist header shows the registry name, credited spellings, reviewed aliases, and type counts", async () => {
  const loona = await request(`/artists/${artists.loona.artistId.toUpperCase()}`);
  assert.equal(loona.status, 200, JSON.stringify(loona.body));
  assert.deepEqual(loona.body, {
    artist: {
      artistId: artists.loona.artistId,
      name: "LOONA",
      aliases: [],
      creditedAs: ["이달의 소녀"],
      musicBrainzUrl: `https://musicbrainz.org/artist/${artists.loona.externalReferences[0].externalId}`,
    },
    releaseCounts: { all: 6, album: 2, ep: 1, single: 1, mixtape: 1, other: 1 },
    features: { discography: false },
  });
  const previousDiscography = process.env.ARTIST_DISCOGRAPHY_ENABLED;
  process.env.ARTIST_DISCOGRAPHY_ENABLED = "true";
  try {
    assert.deepEqual((await request(`/artists/${artists.loona.artistId}`)).body.features, { discography: true });
  } finally {
    if (previousDiscography === undefined) delete process.env.ARTIST_DISCOGRAPHY_ENABLED; else process.env.ARTIST_DISCOGRAPHY_ENABLED = previousDiscography;
  }
  assert.equal(JSON.stringify(loona.body).includes(String(artists.loona._id)), false);

  const bts = await request(`/artists/${artists.bts.artistId}`);
  assert.deepEqual(bts.body.artist.aliases, [
    { name: "방탄소년단", locale: "ko" },
    { name: "Bangtan Sonyeondan", locale: "ko-Latn" },
    { name: "Bangtan Boys", locale: "en" },
  ]);

  const quiet = await request(`/artists/${artists.quiet.artistId}`);
  assert.equal(quiet.status, 200);
  assert.equal(quiet.body.releaseCounts.all, 0);
  assert.deepEqual((await request(`/artists/${artists.quiet.artistId}/releases`)).body, {
    artistId: artists.quiet.artistId, type: "all", releases: [], nextCursor: null,
  });

  const missing = await request(`/artists/${crypto.randomUUID()}`);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "ARTIST_NOT_FOUND");
  assert.equal((await request(`/artists/${crypto.randomUUID()}/releases`)).body.code, "ARTIST_NOT_FOUND");
  assert.equal((await request(`/artists/${artists.loona._id}`)).body.code, "INVALID_ARTIST_ID");
});

integration("releases page newest first with stable cursors and type filters", async () => {
  assert.deepEqual(await allReleases(`/artists/${artists.loona.artistId}/releases`), [
    // Same-day releases fall back to title order, then albumId.
    "Flip That", "Live", "Butterfly", "[X X]", "[+ +]", "Undated",
  ]);
  assert.deepEqual(await allReleases(`/artists/${artists.loona.artistId}/releases?type=album`), ["[X X]", "[+ +]"]);
  assert.deepEqual(await allReleases(`/artists/${artists.loona.artistId}/releases?type=other`), ["Live"]);
  assert.deepEqual(await allReleases(`/artists/${artists.loona.artistId}/releases?type=ep`), ["Flip That"]);

  const first = await request(`/artists/${artists.loona.artistId}/releases?limit=1`);
  const card = first.body.releases[0];
  assert.deepEqual(card, {
    albumId: albums.loonaEp.albumId,
    title: "Flip That",
    artistDisplayName: "LOONA",
    artistCredits: [{ name: "LOONA", role: "main", artistId: artists.loona.artistId }],
    releaseType: "ep",
    releaseYear: 2022,
    cover: "",
    creditRoles: ["main"],
    collaboration: false,
  });
  const live = (await request(`/artists/${artists.loona.artistId}/releases?type=other`)).body.releases[0];
  assert.equal(live.releaseYear, 2020, "a year-only release date still supplies the year");
  assert.equal(JSON.stringify(first.body).includes(String(albums.loonaEp._id)), false, "cursors and cards carry no Mongo IDs");
  assert.equal(Buffer.from(first.body.nextCursor, "base64url").toString("utf8").includes(String(albums.loonaEp._id)), false);

  const otherType = await request(`/artists/${artists.loona.artistId}/releases?type=album&cursor=${first.body.nextCursor}`);
  assert.equal(otherType.status, 400);
  assert.equal(otherType.body.code, "INVALID_ARTIST_CURSOR");
  assert.equal((await request(`/artists/${artists.loona.artistId}/releases?cursor=nope`)).body.code, "INVALID_ARTIST_CURSOR");
  assert.equal((await request(`/artists/${artists.loona.artistId}/releases?sort=title`)).body.code, "INVALID_ARTIST_RELEASES");
});

integration("an explicitly multi-credited release appears on each credited artist's page", async () => {
  const jay = (await request(`/artists/${artists.jay.artistId}/releases`)).body.releases;
  const kanye = (await request(`/artists/${artists.kanye.artistId}/releases`)).body.releases;
  assert.deepEqual(jay.map((row) => row.title), ["Guest Spot", "Watch the Throne", "Orphan Credit"]);
  assert.deepEqual(kanye.map((row) => row.title), ["Guest Spot", "Watch the Throne"], "a name-only display string never links");
  assert.equal(kanye[1].collaboration, true);
  assert.deepEqual(kanye[0].creditRoles, ["featured"]);
  assert.deepEqual(kanye[1].artistCredits.map((entry) => entry.name), ["JAY-Z", "Kanye West"], "credit order and wording are kept");
});

integration("homonyms stay separate artists in pages and search", async () => {
  assert.deepEqual((await request(`/artists/${artists.vSinger.artistId}/releases`)).body.releases.map((row) => row.title), ["Layover"]);
  assert.deepEqual((await request(`/artists/${artists.vBand.artistId}/releases`)).body.releases.map((row) => row.title), ["V Band LP"]);
  const search = await request("/artists/search?q=V");
  assert.equal(search.status, 200);
  const exact = search.body.results.filter((row) => row.name === "V");
  assert.deepEqual(new Set(exact.map((row) => row.artistId)), new Set([artists.vSinger.artistId, artists.vBand.artistId]));
  assert.deepEqual(exact.map((row) => row.knownFor[0]).sort(), ["Layover", "V Band LP"], "each homonym is told apart by its own releases");
  assert.deepEqual(search.body.results.slice(0, 2).map((row) => row.name), ["V", "V"], "exact name matches rank first");
});

integration("artist search matches registry names, reviewed aliases, and credited native-script names", async () => {
  const alias = await request(`/artists/search?q=${encodeURIComponent("방탄")}`);
  assert.deepEqual(alias.body.results, [{
    artistId: artists.bts.artistId, name: "BTS", match: { name: "방탄소년단", kind: "alias", locale: "ko" },
    releaseCount: 1, knownFor: ["Map of the Soul: 7"],
  }]);
  const credited = await request(`/artists/search?q=${encodeURIComponent("이달의 소녀")}`);
  assert.deepEqual(credited.body.results.map((row) => [row.artistId, row.match]), [
    [artists.loona.artistId, { name: "이달의 소녀", kind: "credit" }],
  ]);
  assert.equal(credited.body.results[0].releaseCount, 6);
  const name = await request("/artists/search?q=kanye%20west");
  assert.equal(name.body.results[0].artistId, artists.kanye.artistId);
  assert.equal(name.body.results[0].match, null);
  assert.deepEqual((await request("/artists/search?q=zzzz")).body, { results: [] });
});

integration("album search expands exact artist names and aliases by identity only while enabled", async () => {
  const titles = async (q) => (await request(`/search/search?q=${encodeURIComponent(q)}`)).body.map((row) => row.title);
  const byAlias = await titles("방탄소년단");
  assert.deepEqual(byAlias, ["Map of the Soul: 7"]);
  const byName = await titles("LOONA");
  assert.ok(byName.includes("[+ +]"), "the release credited in Hangul is found through the shared artistId");
  assert.equal(new Set(byName).size, byName.length);
  // Partial input never expands by identity.
  assert.equal((await titles("LOON")).includes("[+ +]"), false);

  process.env.ARTIST_PAGES_ENABLED = "false";
  try {
    assert.deepEqual(await titles("방탄소년단"), []);
    assert.equal((await titles("LOONA")).includes("[+ +]"), true, "the existing curated name pair still applies");
    const disabled = await request(`/artists/${artists.loona.artistId}`);
    assert.equal(disabled.status, 503);
  } finally {
    process.env.ARTIST_PAGES_ENABLED = "true";
  }
});

integration("album detail lists only credited artistIds that resolve to an artist page", async () => {
  const orphan = await request(`/albums/album/${albums.orphan.albumId}`);
  assert.equal(orphan.status, 200);
  assert.deepEqual(orphan.body.artistPages, { artistIds: [artists.jay.artistId] });
  assert.equal(orphan.body.artistCredits[0].name, "Ghost", "unresolved credits are still returned as plain credits");
  const unlinked = await request(`/albums/album/${albums.unlinked.albumId}`);
  assert.deepEqual(unlinked.body.artistPages, { artistIds: [] });

  process.env.ARTIST_PAGES_ENABLED = "false";
  try {
    const disabled = await request(`/albums/album/${albums.throne.albumId}`);
    assert.equal("artistPages" in disabled.body, false);
  } finally {
    process.env.ARTIST_PAGES_ENABLED = "true";
  }
});

integration("missing release types count and filter as albums, and equal titles page by albumId", async () => {
  const solo = await artist("legacy", "Legacy Artist");
  const legacy = { albumId: crypto.randomUUID(), title: "Untyped", artistDisplayName: "Legacy Artist", artistCredits: [credit("Legacy Artist", "legacy")], catalogRevision: 1 };
  await AlbumCatalog.collection.insertOne(legacy);
  const twins = [crypto.randomUUID(), crypto.randomUUID()].sort();
  for (const albumId of [...twins].reverse()) {
    await AlbumCatalog.create({ albumId, title: "Twin", artistDisplayName: "Legacy Artist", artistCredits: [credit("Legacy Artist", "legacy")], releaseType: "single", releaseYear: 2001, releaseDate: "2001-01-01" });
  }
  const header = await request(`/artists/${solo.artistId}`);
  assert.deepEqual(header.body.releaseCounts, { all: 3, album: 1, ep: 0, single: 2, mixtape: 0, other: 0 });
  const albumsOnly = (await request(`/artists/${solo.artistId}/releases?type=album`)).body.releases;
  assert.deepEqual(albumsOnly.map((row) => [row.title, row.releaseType]), [["Untyped", "album"]]);
  assert.deepEqual((await request(`/artists/${solo.artistId}/releases?type=other`)).body.releases, []);

  const first = await request(`/artists/${solo.artistId}/releases?type=single&limit=1`);
  const second = await request(`/artists/${solo.artistId}/releases?type=single&limit=1&cursor=${first.body.nextCursor}`);
  assert.deepEqual([first.body.releases[0].albumId, second.body.releases[0].albumId], twins);
  assert.equal(second.body.nextCursor, null);
});

integration("an exactly named artist survives the candidate cap on a common short query", async () => {
  await Artist.create(Array.from({ length: 60 }, (_, index) => newArtistDocument({
    name: `Blair ${String(index).padStart(2, "0")}`, artistMbid: mbid(), source: "import",
  })));
  const air = await artist("air", "Air");
  const results = (await request("/artists/search?q=air&limit=3")).body.results;
  assert.equal(results[0].artistId, air.artistId);
  assert.equal(results[0].match, null);
});
