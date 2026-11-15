const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const express = require("express");

const { newArtistDocument } = require("../lib/artists/identity");
const { normalizeArtistProposals, prepareArtistProposals } = require("../lib/artists/proposals");
const {
  ARTIST_MAX_PENDING,
  buildArtistLookupUrl,
  buildArtistSearchUrl,
  createMusicBrainzSearch,
  mapArtistRecord,
} = require("../lib/musicBrainzSearch");
const { createArtistDiscoveryRouter } = require("../routes/artistDiscovery");
const { isArtistSuggestionsEnabled } = require("../routes/utils/serverConfig");

const MBID_A = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
const MBID_B = "83096042-3785-481e-8843-dee69f1aad12";
const MBID_C = "e941e097-0f9e-496d-a381-dd74a953682c";

function response(data, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    async json() { return data; },
  };
}

function artistRow(id, name, extra = {}) {
  return { id, name, "sort-name": name, type: "Group", country: "GB", disambiguation: "", score: 100, ...extra };
}

function client({ fetchFn, clock, ...options }) {
  const time = clock || { now: 0 };
  return {
    time,
    search: createMusicBrainzSearch({ intervalMs: 0, fetchFn, nowMs: () => time.now, sleepFn: async () => {}, ...options }),
  };
}

// ---------------------------------------------------------------------------
// Provider adapter

test("artist search URLs escape the typed name and ask for a bounded page", () => {
  const url = new URL(buildArtistSearchUrl('AC/DC "live"', "https://mb.test/ws/2"));
  assert.equal(url.origin + url.pathname, "https://mb.test/ws/2/artist");
  assert.equal(url.searchParams.get("limit"), "10");
  assert.equal(url.searchParams.get("fmt"), "json");
  const query = url.searchParams.get("query");
  assert.match(query, /artist:"AC\\\/DC \\"live\\""\^4/);
  assert.match(query, /alias:/);
  assert.throws(() => buildArtistSearchUrl("   "), (error) => error.code === "INVALID_EXTERNAL_SEARCH");
  assert.throws(() => buildArtistSearchUrl("x".repeat(201)), (error) => error.code === "INVALID_EXTERNAL_SEARCH");
  assert.equal(buildArtistLookupUrl(MBID_A.toUpperCase(), "https://mb.test/ws/2"), `https://mb.test/ws/2/artist/${MBID_A}?fmt=json`);
  assert.throws(() => buildArtistLookupUrl("nope"), (error) => error.code === "INVALID_EXTERNAL_SEARCH");
});

test("artist records keep bounded descriptive fields and drop unusable rows", () => {
  assert.deepEqual(mapArtistRecord(artistRow(MBID_A.toUpperCase(), "  Nova ", { disambiguation: "x".repeat(800), type: "t".repeat(90), country: "GBRGBRGBRGBR", extra: 1 })), {
    artistMbid: MBID_A, name: "Nova", sortName: "Nova", disambiguation: "x".repeat(500), type: "t".repeat(50), country: "GBRGBRGB",
  });
  assert.equal(mapArtistRecord({ id: "bad", name: "X" }), null);
  assert.equal(mapArtistRecord({ id: MBID_A, name: "" }), null);
  assert.equal(mapArtistRecord({ id: MBID_A, name: 7 }), null);
  assert.equal(mapArtistRecord(null), null);
});

test("artist search identifies itself, maps candidates in provider order, and de-duplicates", async () => {
  const calls = [];
  const { search } = client({
    userAgent: "Rescened-Test/1.0 (test@example.invalid)",
    fetchFn: async (url, init) => {
      calls.push({ url, init });
      return response({ artists: [artistRow(MBID_B, "Nova", { disambiguation: "UK band" }), { id: "bad" }, artistRow(MBID_A, "Nova"), artistRow(MBID_B, "Nova again")] });
    },
  });
  const candidates = await search.searchArtists(" Nova ");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers["User-Agent"], "Rescened-Test/1.0 (test@example.invalid)");
  assert.deepEqual(candidates.map((candidate) => [candidate.artistMbid, candidate.name]), [[MBID_B, "Nova"], [MBID_A, "Nova"]]);
  assert.equal(candidates[0].disambiguation, "UK band");
});

test("empty and malformed artist responses are distinguished", async () => {
  const empty = client({ fetchFn: async () => response({ artists: [] }) }).search;
  assert.deepEqual(await empty.searchArtists("Nobody"), []);
  const malformed = client({ fetchFn: async () => response({ releases: [] }) }).search;
  await assert.rejects(malformed.searchArtists("Nova"), (error) => error.code === "MUSICBRAINZ_INVALID_SEARCH_RESPONSE" && error.diagnostics.category === "invalid_response");
  const allInvalid = client({ fetchFn: async () => response({ artists: [{ id: "bad", name: "X" }] }) }).search;
  await assert.rejects(allInvalid.searchArtists("Nova"), (error) => error.code === "MUSICBRAINZ_INVALID_SEARCH_RESPONSE");
  const oversized = client({ maxResponseBytes: 100, fetchFn: async () => response({}, { headers: { "content-length": "5000" } }) }).search;
  await assert.rejects(oversized.searchArtists("Nova"), (error) => error.diagnostics.category === "invalid_response");
});

test("a slow provider times out once with no automatic retry", async () => {
  let calls = 0;
  const { search } = client({
    timeoutMs: 20,
    fetchFn: (url, init) => {
      calls += 1;
      return new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    },
  });
  await assert.rejects(search.searchArtists("Slow"), (error) => error.diagnostics.category === "timeout");
  assert.equal(calls, 1);
  let failing = 0;
  const flaky = client({ fetchFn: async () => { failing += 1; return response({}, { status: 500 }); } }).search;
  await assert.rejects(flaky.searchArtists("Flaky"), (error) => error.diagnostics.category === "upstream_http" && error.diagnostics.upstreamStatus === 500);
  assert.equal(failing, 1, "server errors are not retried");
});

test("an upstream throttle starts a bounded cooldown that refuses artist requests locally", async () => {
  let calls = 0;
  let mode = "throttle";
  const clock = { now: 1_000_000 };
  const { search } = client({
    clock,
    fetchFn: async () => {
      calls += 1;
      if (mode === "throttle") return response({}, { status: 503, headers: { "retry-after": "7" } });
      return response({ artists: [artistRow(MBID_A, "Nova")] });
    },
  });
  await assert.rejects(search.searchArtists("Nova"), (error) => error.code === "MUSICBRAINZ_THROTTLED" && error.retryAfterSeconds === 7 && error.status === 503);
  clock.now += 3_000;
  mode = "ok";
  await assert.rejects(search.searchArtists("Other"), (error) => error.code === "MUSICBRAINZ_THROTTLED" && error.retryAfterSeconds === 4);
  await assert.rejects(search.lookupArtist(MBID_B), (error) => error.code === "MUSICBRAINZ_THROTTLED");
  assert.equal(calls, 1, "no provider request during the cooldown");
  clock.now += 4_001;
  assert.equal((await search.searchArtists("Other")).length, 1);
  assert.equal(calls, 2);

  const huge = client({ clock: { now: 0 }, fetchFn: async () => response({}, { status: 429, headers: { "retry-after": "99999" } }) }).search;
  await assert.rejects(huge.searchArtists("Nova"), (error) => error.retryAfterSeconds === 120, "cooldowns are capped");
  const noHeader = client({ clock: { now: 0 }, fetchFn: async () => response({}, { status: 429 }) }).search;
  await assert.rejects(noHeader.searchArtists("Nova"), (error) => error.retryAfterSeconds === 10);
});

test("a burst beyond the pending bound is refused instead of queued", async () => {
  const releases = [];
  let calls = 0;
  let hold = true;
  const { search } = client({
    fetchFn: () => {
      calls += 1;
      if (!hold) return Promise.resolve(response({ artists: [] }));
      return new Promise((resolve) => releases.push(() => resolve(response({ artists: [] }))));
    },
  });
  const pending = Array.from({ length: ARTIST_MAX_PENDING }, (_, index) => search.searchArtists(`Artist ${index}`));
  for (let turn = 0; releases.length < ARTIST_MAX_PENDING && turn < 1000; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases.length, ARTIST_MAX_PENDING);
  await assert.rejects(search.searchArtists("One too many"), (error) => error.code === "MUSICBRAINZ_BUSY" && error.retryAfterSeconds === 2);
  const coalesced = search.searchArtists("artist 0");
  hold = false;
  releases.forEach((release) => release());
  await Promise.all([...pending, coalesced]);
  assert.equal(calls, ARTIST_MAX_PENDING, "the coalesced duplicate shares the in-flight request");
  assert.deepEqual(await search.searchArtists("Afterwards"), []);
});

test("artist searches use the bounded cache and expire", async () => {
  let calls = 0;
  const clock = { now: 0 };
  const { search } = client({
    clock,
    cacheTtlMs: 1_000,
    cacheMaxEntries: 2,
    fetchFn: async () => { calls += 1; return response({ artists: [artistRow(MBID_A, "Nova")] }); },
  });
  await search.searchArtists("Nova");
  await search.searchArtists("nova");
  assert.equal(calls, 1, "case-insensitive cache hit");
  clock.now += 1_001;
  await search.searchArtists("Nova");
  assert.equal(calls, 2, "expired entries are fetched again");
  await search.searchArtists("Two");
  await search.searchArtists("Three");
  await search.searchArtists("Nova");
  assert.equal(calls, 5, "the oldest entry was evicted at the bound");
});

test("exact artist lookup returns the served record, null for unknown MBIDs, and feeds proposal preparation", async () => {
  let calls = 0;
  const { search } = client({
    fetchFn: async (url) => {
      calls += 1;
      if (url.includes(MBID_C)) return response({ error: "Not Found" }, { status: 404 });
      if (url.includes(MBID_B)) return response(artistRow(MBID_A, "Merged Target"));
      return response(artistRow(MBID_A, "Canonical Nova", { disambiguation: "UK band" }));
    },
  });
  assert.deepEqual(await search.lookupArtist(MBID_A), {
    artistMbid: MBID_A, name: "Canonical Nova", sortName: "Canonical Nova", disambiguation: "UK band", type: "Group", country: "GB",
  });
  assert.equal(await search.lookupArtist(MBID_C), null);
  assert.equal(await search.lookupArtist(MBID_C), null);
  assert.equal(calls, 2, "a not-found answer is cached too");

  const prepared = await prepareArtistProposals(
    normalizeArtistProposals([{ proposalKey: "mb", kind: "musicbrainz", artistMbid: MBID_A }]),
    { lookupMusicBrainzArtist: search.lookupArtist, now: () => new Date("2026-11-15T00:00:00Z") },
  );
  assert.equal(prepared[0].observation.name, "Canonical Nova");
  await assert.rejects(
    prepareArtistProposals(normalizeArtistProposals([{ proposalKey: "mb", kind: "musicbrainz", artistMbid: MBID_B }]), { lookupMusicBrainzArtist: search.lookupArtist }),
    (error) => error.code === "ARTIST_MBID_REDIRECTED",
  );
  await assert.rejects(
    prepareArtistProposals(normalizeArtistProposals([{ proposalKey: "mb", kind: "musicbrainz", artistMbid: MBID_C }]), { lookupMusicBrainzArtist: search.lookupArtist }),
    (error) => error.code === "ARTIST_MBID_NOT_FOUND",
  );
  const broken = client({ fetchFn: async () => response({ id: MBID_A }) }).search;
  await assert.rejects(broken.lookupArtist(MBID_A), (error) => error.code === "MUSICBRAINZ_INVALID_ARTIST");
});

// ---------------------------------------------------------------------------
// Picker routes

function fakeArtistModel(rows) {
  return {
    find(query) {
      let result = rows;
      if (query.artistId) result = rows.filter((row) => query.artistId.$in.includes(row.artistId));
      if (query.externalReferences) {
        const wanted = query.externalReferences.$elemMatch.externalId.$in;
        result = rows.filter((row) => row.externalReferences.some((reference) => wanted.includes(reference.externalId)));
      }
      return { lean() { return this; }, exec: async () => JSON.parse(JSON.stringify(result)) };
    },
  };
}

const passThrough = (req, res, next) => next();
const silent = { error() {}, warn() {} };

async function withRouter(options, run) {
  const app = express();
  app.use("/artist-discovery", createArtistDiscoveryRouter({ localRateLimit: passThrough, providerRateLimit: passThrough, log: silent, ...options }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/artist-discovery`;
  try {
    await run(async (path) => {
      const result = await fetch(`${base}${path}`);
      return { status: result.status, headers: result.headers, body: await result.json() };
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const registered = newArtistDocument({ artistId: crypto.randomUUID(), name: "Nova", artistMbid: MBID_A, source: "import" });
const communityArtist = { artistId: crypto.randomUUID(), name: "Nova", externalReferences: [], artistSource: "community" };

test("the flag is off by default and independent of artist pages", () => {
  assert.equal(isArtistSuggestionsEnabled({}), false);
  assert.equal(isArtistSuggestionsEnabled({ ARTIST_PAGES_ENABLED: "true" }), false);
  assert.equal(isArtistSuggestionsEnabled({ ARTIST_SUGGESTIONS_ENABLED: " TRUE " }), true);
});

test("discovery requires sign-in, then the artist-suggestions flag", async () => {
  let providerCalls = 0;
  const searchProvider = async () => { providerCalls += 1; return []; };
  await withRouter({ viewer: () => "", enabled: () => true, searchProvider }, async (get) => {
    const anonymous = await get("/local?q=Nova");
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.code, "UNAUTHORIZED");
  });
  await withRouter({ viewer: () => "user_1", enabled: () => false, searchProvider }, async (get) => {
    for (const path of ["/local?q=Nova", "/musicbrainz?q=Nova"]) {
      const off = await get(path);
      assert.equal(off.status, 503);
      assert.equal(off.body.code, "ARTIST_SUGGESTIONS_DISABLED");
    }
  });
  assert.equal(providerCalls, 0);
});

test("local discovery returns registry identities and keeps same-name artists distinct", async () => {
  const searchLocal = async ({ q, limit }) => {
    assert.equal(q, "Nova");
    assert.equal(limit, "8");
    return { results: [
      { artistId: registered.artistId, name: "Nova", match: null, releaseCount: 3, knownFor: ["First", "Second"] },
      { artistId: communityArtist.artistId, name: "Nova", match: { name: "NOVA", kind: "credit" }, releaseCount: 0, knownFor: [] },
    ] };
  };
  await withRouter({ viewer: () => "user_1", enabled: () => true, searchLocal, ArtistModel: fakeArtistModel([registered, communityArtist]) }, async (get) => {
    const result = await get("/local?q=%20Nova%20&limit=8");
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.results.map((row) => [row.artistId, row.artistMbid]), [[registered.artistId, MBID_A], [communityArtist.artistId, ""]]);
    assert.deepEqual((await get("/local?q=")).body, { query: "", results: [] });
    const invalid = await get("/local?q=Nova&limit=99");
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, "INVALID_ARTIST_DISCOVERY");
    assert.equal((await get("/local?q=Nova&extra=1")).status, 400);
  });
});

test("MusicBrainz discovery marks exact registered MBIDs and stays external", async () => {
  const searchProvider = async (query) => {
    assert.equal(query, "Nova");
    return [
      { artistMbid: MBID_A, name: "Nova", sortName: "Nova", disambiguation: "UK band", type: "Group", country: "GB" },
      { artistMbid: MBID_B, name: "Nova", sortName: "Nova", disambiguation: "US rapper", type: "Person", country: "US" },
    ];
  };
  await withRouter({ viewer: () => "user_1", enabled: () => true, searchProvider, ArtistModel: fakeArtistModel([registered, communityArtist]) }, async (get) => {
    const result = await get("/musicbrainz?q=Nova");
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.candidates.map((row) => [row.kind, row.artistMbid, row.registeredArtistId]), [
      ["external", MBID_A, registered.artistId],
      ["external", MBID_B, null],
    ], "the same-name community artist is never matched by name");
    assert.equal(result.body.candidates[0].sourceUrl, `https://musicbrainz.org/artist/${MBID_A}`);
    assert.equal((await get("/musicbrainz")).status, 400);
    assert.equal((await get("/musicbrainz?q=%20")).status, 400);
    assert.equal((await get("/musicbrainz?q=Nova&limit=3")).status, 400);
  });
});

test("provider throttling and outages are actionable and leave local discovery working", async () => {
  const throttle = Object.assign(new Error("slow down"), { code: "MUSICBRAINZ_THROTTLED", retryAfterSeconds: 9 });
  const outage = Object.assign(new Error(`failed https://musicbrainz.org/ws/2/artist?query=secret`), { code: "MUSICBRAINZ_REQUEST_FAILED", diagnostics: { category: "timeout", upstreamStatus: 504 } });
  let failure = throttle;
  const options = {
    viewer: () => "user_1",
    enabled: () => true,
    searchProvider: async () => { throw failure; },
    searchLocal: async () => ({ results: [{ artistId: registered.artistId, name: "Nova", releaseCount: 1, knownFor: [] }] }),
    ArtistModel: fakeArtistModel([registered]),
  };
  await withRouter(options, async (get) => {
    const throttled = await get("/musicbrainz?q=Nova");
    assert.equal(throttled.status, 503);
    assert.equal(throttled.body.code, "ARTIST_DISCOVERY_THROTTLED");
    assert.equal(throttled.body.retryAfterSeconds, 9);
    assert.equal(throttled.headers.get("retry-after"), "9");
    assert.ok(throttled.headers.get("x-request-id"));

    failure = outage;
    const down = await get("/musicbrainz?q=Nova");
    assert.equal(down.status, 502);
    assert.equal(down.body.code, "ARTIST_DISCOVERY_UNAVAILABLE");
    assert.equal(down.body.category, "timeout");
    assert.equal(down.body.upstreamStatus, 504);
    assert.equal(JSON.stringify(down.body).includes("secret"), false, "provider URLs never reach the client");

    const local = await get("/local?q=Nova");
    assert.equal(local.status, 200);
    assert.equal(local.body.results[0].artistId, registered.artistId);
  });
});
