const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { once } = require("node:events");
const express = require("express");
const { parseLinkQuery, MAX_LINK_IDS } = require("../lib/artists/read");

// The frontend helpers are dependency-free ES modules; load them as written.
const load = (file) => import(`data:text/javascript;base64,${Buffer.from(fs.readFileSync(path.join(__dirname, "../frontend/src/features/artists", file), "utf8")).toString("base64")}`);
const helpers = load("artists.js");
const storeModule = load("artistLinkStore.js");

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

test("link queries accept only well-formed, bounded artist IDs and nothing else", () => {
  assert.deepEqual(parseLinkQuery({}), []);
  assert.deepEqual(parseLinkQuery({ ids: "" }), []);
  assert.deepEqual(parseLinkQuery({ ids: ` ${A.toUpperCase()}, ${B},${A} ` }), [A, B], "trimmed, lowercased, deduplicated, in order");
  const rejected = [{ ids: "jay-z" }, { ids: `${A},nope` }, { ids: [A, B] }, { name: "JAY-Z" }, { ids: A, q: "x" }, { ids: "00000000-0000-0000-0000-000000000000" }];
  for (const query of rejected) {
    assert.throws(() => parseLinkQuery(query), (error) => error.status === 400 && error.code === "INVALID_ARTIST_LINKS", JSON.stringify(query));
  }
  const ids = Array.from({ length: MAX_LINK_IDS + 1 }, (_, index) => `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`);
  assert.equal(parseLinkQuery({ ids: ids.slice(0, MAX_LINK_IDS).join(",") }).length, MAX_LINK_IDS);
  assert.throws(() => parseLinkQuery({ ids: ids.join(",") }), (error) => error.code === "INVALID_ARTIST_LINKS");
});

test("the link route is behind the artist pages flag and validates before reading", async () => {
  const previous = process.env.ARTIST_PAGES_ENABLED;
  const app = express();
  app.use("/artists", require("../routes/artists"));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}/artists/links`;
  try {
    delete process.env.ARTIST_PAGES_ENABLED;
    const disabled = await fetch(`${base}?ids=${A}`);
    assert.equal(disabled.status, 503);
    assert.equal((await disabled.json()).code, "ARTIST_PAGES_DISABLED");
    process.env.ARTIST_PAGES_ENABLED = "true";
    const bad = await fetch(`${base}?ids=jay-z`);
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, "INVALID_ARTIST_LINKS");
    assert.deepEqual(await (await fetch(base)).json(), { artistIds: [] }, "an empty check never reads the registry");
  } finally {
    if (previous === undefined) delete process.env.ARTIST_PAGES_ENABLED;
    else process.env.ARTIST_PAGES_ENABLED = previous;
    server.close();
  }
});

test("credited artistIds are collected from credits only, never from names", async () => {
  const { creditArtistIds } = await helpers;
  assert.deepEqual(creditArtistIds({ artistDisplayName: "JAY-Z", artistCredits: [{ name: "JAY-Z", artistId: A.toUpperCase() }, { name: "Kanye West" }, { name: "Guest", artistId: " " }] }), [A]);
  assert.deepEqual(creditArtistIds([{ artistCredits: [{ name: "x", artistId: A }] }, { artistCredits: [{ name: "y", artistId: A }, { name: "z", artistId: B }] }, null, {}]), [A, B]);
  assert.deepEqual(creditArtistIds([{ artistDisplayName: "JAY-Z" }]), []);
  assert.deepEqual(creditArtistIds(undefined), []);
});

test("artist lines keep the stored wording and link only confirmed credits", async () => {
  const { artistDisplaySegments } = await helpers;
  const text = (segments) => segments.map((segment) => segment.text).join("");
  const linked = (segments) => segments.filter((segment) => segment.artistId).map((segment) => [segment.text, segment.artistId]);
  const album = {
    artistDisplayName: "JAY-Z & Kanye West feat. Guest",
    artistCredits: [{ name: "JAY-Z", artistId: A }, { name: "Kanye West", artistId: B }, { name: "Guest" }],
  };

  // Nothing confirmed: exactly the stored display name, no links.
  assert.deepEqual(artistDisplaySegments(album, new Set()), [{ text: "JAY-Z & Kanye West feat. Guest", artistId: null }]);
  assert.deepEqual(artistDisplaySegments(album, undefined), [{ text: "JAY-Z & Kanye West feat. Guest", artistId: null }]);

  // One credit confirmed: the line reads the same and only that name links.
  const one = artistDisplaySegments(album, new Set([A]));
  assert.equal(text(one), "JAY-Z & Kanye West feat. Guest");
  assert.deepEqual(linked(one), [["JAY-Z", A]]);

  // A predicate works too, and an ID-less credit never links even when its name matches a linked artist.
  const both = artistDisplaySegments(album, (id) => [A, B].includes(id));
  assert.deepEqual(linked(both), [["JAY-Z", A], ["Kanye West", B]]);
  assert.equal(text(both), "JAY-Z & Kanye West feat. Guest");
  const nameOnly = artistDisplaySegments({ artistDisplayName: "JAY-Z", artistCredits: [{ name: "JAY-Z" }] }, new Set([A]));
  assert.deepEqual(nameOnly, [{ text: "JAY-Z", artistId: null }]);
  assert.deepEqual(artistDisplaySegments({ artistDisplayName: "JAY-Z", artistCredits: [{ name: "JAY-Z", artistId: A.toUpperCase() }] }, new Set([A])), [{ text: "JAY-Z", artistId: A }]);
});

test("a credit links only where it appears as a whole name, otherwise credits are listed by name", async () => {
  const { artistDisplaySegments } = await helpers;
  const texts = (segments) => segments.map((segment) => segment.text);

  // "V" is inside "Various", so it cannot anchor there; credits are listed instead.
  const various = artistDisplaySegments({ artistDisplayName: "Various Artists", artistCredits: [{ name: "V", artistId: A }, { name: "Artists" }] }, new Set([A]));
  assert.deepEqual(various, [{ text: "V", artistId: A }, { text: ", ", artistId: null }, { text: "Artists", artistId: null }]);

  // A whole-word match later in the line is still found, and the earlier substring is skipped.
  const later = artistDisplaySegments({ artistDisplayName: "Various & V", artistCredits: [{ name: "Various" }, { name: "V", artistId: A }] }, new Set([A]));
  assert.deepEqual(texts(later), ["Various", " & ", "V"]);
  assert.deepEqual(later.map((segment) => segment.artistId), [null, null, A]);

  // Credits out of display order, or absent from it, fall back to the stored credit order.
  const reordered = artistDisplaySegments({ artistDisplayName: "B and A", artistCredits: [{ name: "A", artistId: A }, { name: "B", artistId: B }] }, new Set([A, B]));
  assert.deepEqual(reordered.map((segment) => segment.text), ["A", ", ", "B"]);
  assert.deepEqual(reordered.filter((segment) => segment.artistId).map((segment) => segment.artistId), [A, B]);
  const missing = artistDisplaySegments({ artistDisplayName: "Duo", artistCredits: [{ name: "Half", artistId: A }, { name: "Other" }] }, new Set([A]));
  assert.deepEqual(texts(missing), ["Half", ", ", "Other"]);

  // Same-named homonyms keep separate identities and only the confirmed one links.
  const homonyms = artistDisplaySegments({ artistDisplayName: "V & V", artistCredits: [{ name: "V", artistId: A }, { name: "V", artistId: B }] }, new Set([B]));
  assert.deepEqual(homonyms.map((segment) => [segment.text, segment.artistId]), [["V", null], [" & ", null], ["V", B]]);

  // A hyphen, apostrophe, or period inside a larger name keeps a short credit from attaching to part of it.
  for (const [display, credit] of [["Wu-Tang Clan", "Wu"], ["O'Brien", "O"], ["Mr.Big", "Mr"], ["Blink-182", "Blink"]]) {
    const joined = artistDisplaySegments({ artistDisplayName: display, artistCredits: [{ name: credit, artistId: A }] }, new Set([A]));
    assert.deepEqual(joined, [{ text: credit, artistId: A }], `${credit} is not a whole name inside ${display}, so the credits are listed by name`);
    assert.equal(joined.length, 1);
  }
  const wu = artistDisplaySegments({ artistDisplayName: "Wu-Tang Clan & Wu", artistCredits: [{ name: "Wu-Tang Clan", artistId: A }, { name: "Wu", artistId: B }] }, new Set([A, B]));
  assert.deepEqual(wu.map((segment) => [segment.text, segment.artistId]), [["Wu-Tang Clan", A], [" & ", null], ["Wu", B]], "each credit links its own whole-name occurrence");
  const trailing = artistDisplaySegments({ artistDisplayName: "A- & B", artistCredits: [{ name: "A-", artistId: A }, { name: "B" }] }, new Set([A]));
  assert.deepEqual(trailing.map((segment) => segment.text), ["A-", " & ", "B"], "punctuation that ends a name does not block it");

  // Names that end in punctuation still match, and non-Latin names compare exactly.
  const punctuation = artistDisplaySegments({ artistDisplayName: "P!nk x 방탄소년단", artistCredits: [{ name: "P!nk", artistId: A }, { name: "방탄소년단", artistId: B }] }, new Set([A, B]));
  assert.deepEqual(punctuation.map((segment) => segment.text), ["P!nk", " x ", "방탄소년단"]);

  // Without a display name the credits stand alone; without anything there is nothing to show.
  assert.deepEqual(artistDisplaySegments({ artistCredits: [{ name: "One", artistId: A }, { name: "Two" }] }, new Set([A])).map((segment) => segment.text), ["One", ", ", "Two"]);
  assert.deepEqual(artistDisplaySegments({ artistCredits: [{ name: "One" }, { name: "Two" }] }, new Set()).map((segment) => segment.text), ["One", ", ", "Two"]);
  assert.deepEqual(artistDisplaySegments({}, new Set([A])), []);
  assert.deepEqual(artistDisplaySegments(null, undefined), []);
});

function fakeClock() {
  let time = 1_000;
  const timers = [];
  return {
    now: () => time,
    schedule: (callback) => { timers.push(callback); return timers.length; },
    advance(ms) { time += ms; },
    async run() { while (timers.length) await timers.shift()(); },
  };
}

test("the link store batches checks, caches answers, and never links an unconfirmed ID", async () => {
  const { createArtistLinkStore } = await storeModule;
  const clock = fakeClock();
  const calls = [];
  const store = createArtistLinkStore({ load: async (ids) => { calls.push(ids); return ids.filter((id) => id === A); }, now: clock.now, schedule: clock.schedule });
  let notified = 0;
  store.subscribe(() => { notified += 1; });

  store.request([A, B]);
  store.request([A.toUpperCase(), "not-an-id", "", null, 42]);
  store.request([B]);
  assert.equal(store.isLinked(A), false, "nothing links before the API answers");
  await clock.run();
  assert.deepEqual(calls, [[A, B]], "one request, deduplicated, malformed IDs dropped");
  assert.deepEqual([store.isLinked(A), store.isLinked(B), store.isLinked(C)], [true, false, false]);
  assert.equal(notified, 1);

  store.request([A, B]);
  await clock.run();
  assert.equal(calls.length, 1, "known answers, including negative ones, are not asked again");

  store.confirm([C.toUpperCase(), "junk"]);
  assert.equal(store.isLinked(C), true, "an ID confirmed by another response links without a request");
  store.request([C]);
  await clock.run();
  assert.equal(calls.length, 1);
});

test("the link store splits large batches and does not retry a failure on its own", async () => {
  const { createArtistLinkStore } = await storeModule;
  const clock = fakeClock();
  const calls = [];
  const ids = Array.from({ length: 5 }, (_, index) => `0000000${index}-1111-4111-8111-111111111111`);
  const store = createArtistLinkStore({ load: async (batch) => { calls.push(batch); return batch; }, batchSize: 2, now: clock.now, schedule: clock.schedule });
  store.request(ids);
  await clock.run();
  assert.deepEqual(calls.map((batch) => batch.length), [2, 2, 1]);
  assert.ok(ids.every((id) => store.isLinked(id)));

  const failures = [];
  const flaky = createArtistLinkStore({ load: async (batch) => { failures.push(batch); throw Object.assign(new Error("down"), { status: 502 }); }, cooldown: 60_000, now: clock.now, schedule: clock.schedule });
  flaky.request([A]);
  await clock.run();
  assert.equal(flaky.isLinked(A), false, "a failed check leaves the credit as plain text");
  flaky.request([A]);
  await clock.run();
  assert.equal(failures.length, 1, "no retry during the cool-down, and nothing retries by itself");
  clock.advance(60_001);
  flaky.request([A]);
  await clock.run();
  assert.equal(failures.length, 2, "a later render may ask again after the cool-down");
});

test("the link store stops asking while the API says artist pages are off", async () => {
  const { createArtistLinkStore, linksUnavailable } = await storeModule;
  assert.equal(linksUnavailable({ status: 503, code: "ARTIST_PAGES_DISABLED" }), true);
  assert.equal(linksUnavailable({ status: 404 }), true, "an API older than the route");
  assert.equal(linksUnavailable({ status: 503 }), true);
  assert.equal(linksUnavailable({ status: 429, code: "RATE_LIMITED" }), false);
  assert.equal(linksUnavailable({ status: 400, code: "INVALID_ARTIST_LINKS" }), false);
  assert.equal(linksUnavailable(null), false);

  const clock = fakeClock();
  let calls = 0;
  const store = createArtistLinkStore({ load: async () => { calls += 1; throw Object.assign(new Error("off"), { status: 503, code: "ARTIST_PAGES_DISABLED" }); }, now: clock.now, schedule: clock.schedule });
  store.request([A]);
  await clock.run();
  store.request([B, C]);
  await clock.run();
  assert.equal(calls, 1, "one failed probe, then no more requests during the cool-down");
  assert.equal(store.isLinked(A), false);

  // The stop is a cool-down, not permanent: a proxy's passing 503 must not disable links for good.
  clock.advance(5 * 60_000 + 1);
  store.request([B]);
  await clock.run();
  assert.equal(calls, 2, "links ask again after the cool-down");
});

// Anchors cannot nest. Source-level guard: no <Link> in the app may contain an
// ArtistCredits, and provider candidates never get artist links.
test("artist credits are never rendered inside another link, and external candidates stay plain", () => {
  const root = path.join(__dirname, "../frontend/src");
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.jsx$/.test(entry.name)) files.push(full);
    }
  };
  walk(root);
  const offenders = [];
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const block of source.match(/<(Link|a)\b[^>]*[^/]>[\s\S]*?<\/\1>/g) || []) {
      if (block.includes("<ArtistCredits")) offenders.push(path.relative(root, file));
    }
  }
  assert.deepEqual(offenders, []);
  const external = fs.readFileSync(path.join(root, "Components/ExternalAlbumCard.jsx"), "utf8");
  assert.equal(/ArtistCredits|\/artist\//.test(external), false);
});
