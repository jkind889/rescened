const assert = require("node:assert/strict");
const test = require("node:test");

const adapterPath = require.resolve("../lib/musicBrainzSearch");
const rateLimitPath = require.resolve("../routes/utils/rateLimit");
const searchPath = require.resolve("../routes/search");
const AlbumCatalog = require("../models/AlbumCatalog");
const realAdapter = require("../lib/musicBrainzSearch");

const ORIGINAL_FIND = AlbumCatalog.find;

const GROUP = "11111111-1111-4111-8111-111111111111";
const GROUP_TWO = "22222222-2222-4222-8222-222222222222";

function candidate(externalId = GROUP, title = "Known Album") {
  return {
    kind: "external",
    provider: "musicbrainz",
    entityType: "release-group",
    externalId,
    title,
    artistDisplayName: "An Artist",
    artistCredits: [{ name: "An Artist", role: "main" }],
    releaseType: "album",
    releaseDate: "2024",
    releaseDatePrecision: "year",
    releaseYear: 2024,
    cover: `https://coverartarchive.org/release-group/${externalId}/front-250`,
    sourceUrl: `https://musicbrainz.org/release-group/${externalId}`,
  };
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function callRoute(router, method, path, req = {}) {
  const route = router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]);
  assert.ok(route, `${method.toUpperCase()} ${path} should be registered`);
  const res = response();
  return (async () => {
    for (const handler of route.route.stack.map((layer) => layer.handle)) {
      let nextCalled = false;
      await handler(req, res, () => { nextCalled = true; });
      if (!nextCalled) break;
    }
    return { status: res.statusCode, body: res.body, headers: res.headers };
  })();
}

function query(rows) {
  return {
    lean() { return this; },
    exec() { return Promise.resolve(rows); },
  };
}

function install({ searchResults = [], draft = null, catalogs = [], searchError = null, providerSearch = null } = {}) {
  let searchCalls = 0;
  let draftCalls = 0;
  AlbumCatalog.find = () => query(catalogs);
  require.cache[rateLimitPath] = {
    id: rateLimitPath,
    filename: rateLimitPath,
    loaded: true,
    exports: {
      externalSearchRateLimit: (req, res, next) => next(),
      searchRateLimit: (req, res, next) => next(),
    },
  };
  require.cache[adapterPath] = {
    id: adapterPath,
    filename: adapterPath,
    loaded: true,
    exports: {
      MusicBrainzSearchError: realAdapter.MusicBrainzSearchError,
      normalizeLimit: realAdapter.normalizeLimit,
      normalizeSearchQuery: realAdapter.normalizeSearchQuery,
      searchReleaseGroups: async (queryValue, limit) => {
        searchCalls += 1;
        if (searchError) throw searchError;
        if (providerSearch) return providerSearch(queryValue, limit);
        assert.equal(queryValue, "imaginal disk");
        assert.equal(limit, 12);
        return searchResults;
      },
      getSuggestionDraft: async () => {
        draftCalls += 1;
        return draft;
      },
    },
  };
  delete require.cache[searchPath];
  const router = require("../routes/search");
  return { router, get searchCalls() { return searchCalls; }, get draftCalls() { return draftCalls; } };
}

test.afterEach(() => {
  AlbumCatalog.find = ORIGINAL_FIND;
  delete require.cache[adapterPath];
  delete require.cache[rateLimitPath];
  delete require.cache[searchPath];
  delete process.env.EXTERNAL_ALBUM_SEARCH_ENABLED;
});

test("external search reconciles known MBIDs into normal catalog matches", async () => {
  process.env.EXTERNAL_ALBUM_SEARCH_ENABLED = "true";
  const known = {
    albumId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    title: "Known Album",
    artistDisplayName: "An Artist",
    artistCredits: [{ name: "An Artist", role: "main" }],
    releaseType: "album",
    releaseDate: "2024",
    releaseYear: 2024,
    externalReferences: [{ provider: "musicbrainz", entityType: "release-group", externalId: GROUP.toUpperCase() }],
  };
  const installed = install({ searchResults: [candidate(GROUP), candidate(GROUP_TWO, "New Album")], catalogs: [known] });

  const result = await callRoute(installed.router, "get", "/external", { query: { q: "  imaginal   disk  " } });

  assert.equal(result.status, 200);
  assert.equal(result.body.query, "imaginal disk");
  assert.deepEqual(result.body.catalogMatches.map((album) => album.albumId), [known.albumId]);
  assert.deepEqual(result.body.candidates.map((item) => item.externalId), [GROUP_TWO]);
  assert.equal(installed.searchCalls, 1);
});

test("external endpoints are optional and disabled by default", async () => {
  const installed = install({ searchResults: [candidate()] });

  const result = await callRoute(installed.router, "get", "/external", { query: { q: "imaginal disk" } });

  assert.equal(result.status, 503);
  assert.equal(result.body.code, "EXTERNAL_SEARCH_DISABLED");
  assert.equal(installed.searchCalls, 0);
});

test("invalid MBIDs are rejected before catalog or provider lookup", async () => {
  process.env.EXTERNAL_ALBUM_SEARCH_ENABLED = "true";
  const installed = install({ draft: {} });

  const result = await callRoute(installed.router, "get", "/musicbrainz/release-group/:mbid", { params: { mbid: "not-an-mbid" } });

  assert.equal(result.status, 400);
  assert.equal(result.body.code, "INVALID_EXTERNAL_SEARCH");
  assert.equal(installed.draftCalls, 0);
});

test("provider failures are isolated behind the external unavailable contract", async () => {
  process.env.EXTERNAL_ALBUM_SEARCH_ENABLED = "true";
  const installed = install({ searchError: new Error("provider down") });

  const result = await callRoute(installed.router, "get", "/external", { query: { q: "imaginal disk" } });

  assert.equal(result.status, 502);
  assert.equal(result.body.code, "EXTERNAL_SEARCH_UNAVAILABLE");
});

test("exact lookup returns the suggestion draft and never creates catalog data", async () => {
  process.env.EXTERNAL_ALBUM_SEARCH_ENABLED = "true";
  const draft = {
    proposedMetadata: { title: "New Album" },
    supportingSources: [{ type: "musicbrainz", url: "https://musicbrainz.org/release-group/22222222-2222-4222-8222-222222222222" }],
    externalReferences: [{ provider: "musicbrainz", entityType: "release-group", externalId: GROUP_TWO }],
  };
  const installed = install({ draft });
  const result = await callRoute(installed.router, "get", "/musicbrainz/release-group/:mbid", { params: { mbid: GROUP_TWO } });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, draft);
  assert.equal(installed.draftCalls, 1);
});

test("ranked provider pool shares the public limit across catalog matches and external candidates", async () => {
  process.env.EXTERNAL_ALBUM_SEARCH_ENABLED = "true";
  const mbid = (index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  const rows = Array.from({ length: 50 }, (_, index) => ({
    id: mbid(index), title: index === 49 ? "Imaginal Disk" : `Broad Match ${index}`,
    "artist-credit": [{ name: "An Artist" }], "primary-type": "Album", score: 100 - index,
  }));
  let networkCalls = 0;
  const client = realAdapter.createMusicBrainzSearch({
    intervalMs: 0,
    fetchFn: async (url) => {
      networkCalls += 1;
      assert.equal(new URL(url).searchParams.get("limit"), "50");
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ "release-groups": rows }) };
    },
  });
  const known = {
    _id: "507f1f77bcf86cd799439011", albumId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    title: "Current Catalog Title", artistDisplayName: "An Artist",
    externalReferences: [{ provider: "musicbrainz", entityType: "release-group", externalId: mbid(49) }],
  };
  const installed = install({ providerSearch: client.searchReleaseGroups, catalogs: [known] });
  for (const [limit, expected] of [[undefined, 12], [100, 12], [2, 2], [1, 1]]) {
    const result = await callRoute(installed.router, "get", "/external", { query: { q: "imaginal disk", limit } });
    assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(result.body).sort(), ["candidates", "catalogMatches", "provider", "query"]);
    assert.equal(result.body.provider, "musicbrainz");
    assert.equal(result.body.catalogMatches.length + result.body.candidates.length, expected);
    assert.equal(result.body.catalogMatches[0].albumId, known.albumId);
    assert.equal(result.body.catalogMatches[0].title, known.title);
    assert.deepEqual(result.body.candidates.map((item) => item.externalId), rows.slice(0, expected - 1).map((row) => row.id));
    assert.equal(result.body.candidates.some((item) => "albumId" in item || "score" in item || "tier" in item), false);
    assert.equal(JSON.stringify(result.body).includes(known._id), false);
  }
  assert.equal(networkCalls, 1);
});

test("invalid external queries and limits retain the 400 contract without provider calls", async () => {
  process.env.EXTERNAL_ALBUM_SEARCH_ENABLED = "true";
  const installed = install();
  for (const query of [{ q: "" }, { q: "a".repeat(201) }, { q: ["x"] }, { q: "x", limit: 0 }, { q: "x", limit: "invalid" }]) {
    const result = await callRoute(installed.router, "get", "/external", { query });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, "INVALID_EXTERNAL_SEARCH");
  }
  assert.equal(installed.searchCalls, 0);
});


test("external failure logs only safe diagnostic fields and a server-generated correlation ID", async (t) => {
  process.env.EXTERNAL_ALBUM_SEARCH_ENABLED = "true";
  const logs = [];
  t.mock.method(console, "warn", (line) => logs.push(JSON.parse(line)));
  const error = new realAdapter.MusicBrainzSearchError("secret query https://provider/?token=secret");
  error.diagnostics = { category: "timeout", gateWaitMs: 850, fetchDurationMs: 3003, query: "secret" };
  const installed = install({ searchError: error });
  const result = await callRoute(installed.router, "get", "/external", {
    query: { q: "imaginal disk" }, headers: { "x-request-id": "secret" },
  });
  assert.equal(result.status, 502);
  assert.deepEqual(result.body, {
    error: "External album search is temporarily unavailable", code: "EXTERNAL_SEARCH_UNAVAILABLE",
    category: "timeout", upstreamStatus: null, requestId: result.headers["X-Request-ID"],
  });
  assert.equal(logs.length, 1);
  assert.deepEqual(Object.keys(logs[0]).sort(), ["event", "timestamp", "requestId", "provider", "operation",
    "category", "upstreamStatus", "gateWaitMs", "fetchDurationMs"].sort());
  assert.equal(logs[0].requestId, result.headers["X-Request-ID"]);
  assert.match(logs[0].requestId, /^[0-9a-f-]{36}$/u);
  assert.ok(Number.isFinite(Date.parse(logs[0].timestamp)));
  assert.equal(logs[0].gateWaitMs, 850);
  assert.equal(logs[0].fetchDurationMs, 3003);
  assert.equal(JSON.stringify(logs).includes("secret"), false);
});


test("external 502 exposes only allowlisted diagnostics and never invents an upstream status", async (t) => {
  process.env.EXTERNAL_ALBUM_SEARCH_ENABLED = "true";
  const logs = [];
  t.mock.method(console, "warn", (line) => logs.push(JSON.parse(line)));
  for (const [diagnostics, category, upstreamStatus] of [
    [{ category: "upstream_http", upstreamStatus: 503 }, "upstream_http", 503],
    [{ category: "network" }, "network", null],
    [{ category: "network", upstreamStatus: 200 }, "network", 200],
    [{ category: "timeout" }, "timeout", null],
    [{ category: "timeout", upstreamStatus: 200 }, "timeout", 200],
    [{ category: "invalid_response", upstreamStatus: 200 }, "invalid_response", 200],
    [{ category: "secret", upstreamStatus: "503" }, "unknown", null],
    [{ category: "network", upstreamStatus: 600 }, "network", null],
    [{ category: "network", upstreamStatus: 99 }, "network", null],
    [undefined, "unknown", null],
  ]) {
    const error = new Error("secret exception https://provider/?token=secret");
    error.status = 502;
    error.body = "secret provider body";
    error.diagnostics = diagnostics && {
      ...diagnostics, gateWaitMs: 850, fetchDurationMs: 3003,
      query: "secret", url: "https://secret", credentials: "secret",
    };
    const installed = install({ searchError: error });
    const result = await callRoute(installed.router, "get", "/external", { query: { q: "imaginal disk" } });
    assert.equal(result.status, 502);
    assert.deepEqual(result.body, {
      error: "External album search is temporarily unavailable", code: "EXTERNAL_SEARCH_UNAVAILABLE",
      category, upstreamStatus, requestId: result.headers["X-Request-ID"],
    });
    assert.equal(JSON.stringify(result.body).includes("secret"), false);
    assert.equal(result.body.requestId, logs.at(-1).requestId);
    assert.equal(result.body.category, logs.at(-1).category);
    assert.equal(result.body.upstreamStatus, logs.at(-1).upstreamStatus);
    if (diagnostics) assert.equal(logs.at(-1).fetchDurationMs, 3003);
  }
});
