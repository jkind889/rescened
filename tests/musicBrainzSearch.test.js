const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MusicBrainzSearchError,
  buildSearchUrl,
  createMusicBrainzSearch,
  mapReleaseGroupToCandidate,
  mapReleaseGroupToSuggestionDraft,
} = require("../lib/musicBrainzSearch");

const GROUP = "11111111-1111-4111-8111-111111111111";
const GROUP_TWO = "22222222-2222-4222-8222-222222222222";
const ARTIST = "33333333-3333-4333-8333-333333333333";

function response(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async json() { return data; },
  };
}

function releaseGroup(id = GROUP, overrides = {}) {
  return {
    id,
    title: "Imaginal Disk",
    "artist-credit": [{
      name: "Magdalena Bay",
      joinphrase: "",
      artist: { id: ARTIST, name: "Magdalena Bay" },
    }],
    "primary-type": "Album",
    "secondary-types": [],
    "first-release-date": "2024-08-23",
    ...overrides,
  };
}

test("MusicBrainz search URL normalizes whitespace and escapes Lucene syntax", () => {
  const url = new URL(buildSearchUrl("  A+B:  title  "));

  assert.ok(url.searchParams.get("query").startsWith('(releasegroup:"A\\+B\\: title"^8 OR artistname:"A\\+B\\: title"^4 OR artist:"A\\+B\\: title"^4 OR alias:"A\\+B\\: title"^2 OR '));
  assert.equal(url.searchParams.get("limit"), "50");
  assert.equal(url.searchParams.get("fmt"), "json");
});

test("search mapping ranks by upstream score and deduplicates release groups", async () => {
  const calls = [];
  const client = createMusicBrainzSearch({
    intervalMs: 0,
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      return response({
        "release-groups": [
          { ...releaseGroup(GROUP), score: 65 },
          { ...releaseGroup(GROUP_TWO, { title: "Second Record" }), score: 90 },
          { ...releaseGroup(GROUP), score: 100 },
        ],
      });
    },
  });

  const candidates = await client.searchReleaseGroups("imaginal disk", 12);

  assert.deepEqual(candidates.map((candidate) => candidate.externalId), [GROUP, GROUP_TWO]);
  assert.equal(candidates[0].kind, "external");
  assert.equal(candidates[0].provider, "musicbrainz");
  assert.equal(candidates[0].entityType, "release-group");
  assert.equal(candidates[0].albumId, undefined);
  assert.equal(candidates[0].cover, `https://coverartarchive.org/release-group/${GROUP}/front-250`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers["User-Agent"].includes("Rescened"), true);
});

test("normalized concurrent queries share a request and later queries use the bounded cache", async () => {
  let resolveRequest;
  let calls = 0;
  const client = createMusicBrainzSearch({
    intervalMs: 0,
    fetchFn: async () => {
      calls += 1;
      return new Promise((resolve) => { resolveRequest = resolve; });
    },
  });

  const first = client.searchReleaseGroups("  Imaginal   Disk ", 12);
  const second = client.searchReleaseGroups("imaginal disk", 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);

  resolveRequest(response({ "release-groups": [releaseGroup(), releaseGroup(GROUP_TWO), releaseGroup(ARTIST)] }));
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.length, 3);
  assert.equal(secondResult.length, 2);

  const cached = await client.searchReleaseGroups("IMAGINAL DISK", 12);
  assert.equal(cached.length, 3);
  assert.equal(calls, 1);
  assert.equal(client.stats.networkRequests, 1);
  assert.equal(client.stats.cacheHits, 1);
});

test("exact lookup maps core metadata into the existing suggestion input shape", () => {
  const draft = mapReleaseGroupToSuggestionDraft(releaseGroup());
  const candidate = mapReleaseGroupToCandidate(releaseGroup());

  assert.equal(draft.proposedMetadata.title, "Imaginal Disk");
  assert.equal(draft.proposedMetadata.releaseDatePrecision, "day");
  assert.equal(draft.proposedMetadata.releaseYear, 2024);
  assert.deepEqual(draft.proposedMetadata.artistCredits, [{ name: "Magdalena Bay", role: "main" }]);
  assert.deepEqual(draft.proposedMetadata.tracks, []);
  assert.equal(draft.proposedMetadata.coverSourceUrl, "");
  assert.deepEqual(draft.supportingSources, [{
    type: "musicbrainz",
    url: `https://musicbrainz.org/release-group/${GROUP}`,
  }]);
  assert.deepEqual(draft.externalReferences, [{
    provider: "musicbrainz",
    entityType: "release-group",
    externalId: GROUP,
    url: `https://musicbrainz.org/release-group/${GROUP}`,
  }]);
  assert.equal(candidate.releaseType, "album");
});

test("provider timeout becomes a typed adapter error without retries", async () => {
  let calls = 0;
  const client = createMusicBrainzSearch({
    intervalMs: 0,
    timeoutMs: 5,
    fetchFn: async (url, options) => {
      calls += 1;
      await new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return response({});
    },
  });

  await assert.rejects(
    () => client.searchReleaseGroups("timeout"),
    (error) => error instanceof MusicBrainzSearchError && error.code === "MUSICBRAINZ_REQUEST_FAILED",
  );
  assert.equal(calls, 1);
});

test("MusicBrainz request starts are separated by the configured gate", async () => {
  let now = 0;
  const starts = [];
  const client = createMusicBrainzSearch({
    intervalMs: 1_100,
    nowMs: () => now,
    sleepFn: async (milliseconds) => { now += milliseconds; },
    fetchFn: async () => {
      starts.push(now);
      return response({ "release-groups": [releaseGroup()] });
    },
  });

  await client.searchReleaseGroups("one");
  await client.searchReleaseGroups("two");

  assert.deepEqual(starts, [0, 1_100]);
});

// Synthetic provider-shaped rows: no live provider data or calls required.
function groupId(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

async function rank(query, rows, limit = 12) {
  const client = createMusicBrainzSearch({
    intervalMs: 0,
    fetchFn: async (url) => {
      assert.equal(new URL(url).searchParams.get("limit"), "50");
      return response({ "release-groups": rows });
    },
  });
  return client.searchReleaseGroups(query, limit);
}

test("mixed queries require each token across title/artist/alias fields without guessing a split", () => {
  const query = new URL(buildSearchUrl("Magdalena Bay Imaginal Disk")).searchParams.get("query");
  assert.ok(query.includes('releasegroup:"Magdalena Bay Imaginal Disk"^8'));
  assert.ok(query.includes('(releasegroup:"magdalena" OR artistname:"magdalena" OR artist:"magdalena" OR alias:"magdalena") AND (releasegroup:"bay"'));
  assert.ok(query.includes('AND (releasegroup:"imaginal"'));
  assert.ok(query.includes('AND (releasegroup:"disk"'));
  assert.equal(query.includes("arid:"), false);
});

test("user operators and field syntax remain quoted literal text", () => {
  const query = new URL(buildSearchUrl('AND OR NOT "x" artist:evil^99 \\ /')).searchParams.get("query");
  assert.ok(query.includes('releasegroup:"AND OR NOT \\"x\\" artist\\:evil\\^99 \\\\ \\/"^8'));
  assert.ok(query.includes('releasegroup:"and"'));
  assert.ok(query.includes('artistname:"or"'));
  assert.equal(query.includes("artist:evil^99"), false);
  assert.throws(() => buildSearchUrl("a".repeat(201)), { code: "INVALID_EXTERNAL_SEARCH" });
});

test("exact titles outrank exact artists, token coverage, and alias-only matches", async () => {
  const rows = [
    releaseGroup(groupId(1), { title: "Alias match", score: 100 }),
    releaseGroup(groupId(2), { title: "Blue Sky Sessions", score: 100 }),
    releaseGroup(groupId(3), { title: "Another Album", "artist-credit": [{ name: "Blue Sky" }], score: 90 }),
    releaseGroup(groupId(4), { title: "Blue Sky", score: 1 }),
  ];
  const results = await rank("blue sky", rows);
  assert.deepEqual(results.map((item) => item.externalId), [4, 3, 2, 1].map(groupId));
});

test("credited, canonical, and combined artist names participate without leaking ranking inputs", async () => {
  const credited = releaseGroup(groupId(1), { "artist-credit": [
    { name: "Stage Name", joinphrase: " feat. ", artist: { name: "Canonical Name" } },
    { name: "Guest", artist: { name: "Guest" } },
  ], score: 1 });
  const unrelated = releaseGroup(groupId(2), { score: 100 });
  for (const query of ["Stage Name", "Canonical Name", "Stage Name feat. Guest", "Guest"]) {
    const results = await rank(query, [unrelated, credited]);
    assert.equal(results[0].externalId, groupId(1));
    assert.deepEqual(results[0], mapReleaseGroupToCandidate(credited));
    assert.equal(JSON.stringify(results[0]).includes("Canonical Name"), false);
  }
});

test("mixed token coverage works in either order and requires whole tokens", async () => {
  const intended = releaseGroup(groupId(1), { score: 1 });
  const partial = releaseGroup(groupId(2), { title: "Imaginal", score: 100 });
  const substring = releaseGroup(groupId(3), { title: "Imaginal Diskette", score: 100 });
  for (const query of ["Magdalena Bay Imaginal Disk", "Imaginal Disk Magdalena Bay"]) {
    const results = await rank(query, [partial, substring, intended]);
    assert.equal(results[0].externalId, groupId(1));
    assert.equal(results.length, 3);
  }
});

test("comparison normalization preserves display text and handles non-Latin titles", async () => {
  for (const [query, title] of [["  L'ETE -- BLEU ", "L’été: Bleu"], ["東京 夜", "東京・夜"]]) {
    const exact = releaseGroup(groupId(1), { title, score: 1 });
    const results = await rank(query, [releaseGroup(groupId(2), { score: 100 }), exact]);
    assert.equal(results[0].externalId, groupId(1));
    assert.equal(results[0].title, title);
  }
  const punctuation = await rank("!!!", [
    releaseGroup(groupId(1), { title: "Other", score: 100 }),
    releaseGroup(groupId(2), { title: "???", score: 1 }),
  ]);
  assert.deepEqual(punctuation.map((item) => item.externalId), [1, 2].map(groupId));
});

test("ranking uses valid scores and stable provider order within tiers", async () => {
  const scores = [undefined, "invalid", Infinity, -1, 101, true, [99], {}, "80", 80, "", null];
  const rows = scores.map((score, index) => releaseGroup(groupId(index), { score }));
  const results = await rank("imaginal disk", rows);
  assert.deepEqual(results.map((item) => item.externalId), [8, 9, 0, 1, 2, 3, 4, 5, 6, 7, 10, 11].map(groupId));
});

test("the complete pool is validated, ranked, and deduplicated before applying the public limit", async () => {
  const rows = Array.from({ length: 48 }, (_, index) => releaseGroup(groupId(index), { title: "Broad match", score: 100 }));
  rows.splice(0, 1, null);
  rows.splice(1, 1, { id: "malformed", title: "Imaginal Disk" });
  rows.push(releaseGroup(groupId(47), { title: "Imaginal Disk", score: 1 }));
  rows.push(releaseGroup(groupId(49), { title: "Imaginal Disk", score: 2 }));
  const results = await rank("imaginal disk", rows, 100);
  assert.equal(results.length, 12);
  assert.deepEqual(results.slice(0, 2).map((item) => item.externalId), [49, 47].map(groupId));
  assert.equal(results[1].title, "Imaginal Disk");
  assert.equal(new Set(results.map((item) => item.externalId)).size, 12);
  assert.equal((await rank("imaginal disk", rows, 2)).length, 2);
});

test("empty and malformed response contracts remain distinct", async () => {
  assert.deepEqual(await rank("empty", []), []);
  await assert.rejects(() => rank("invalid", [null, {}]), { code: "MUSICBRAINZ_INVALID_SEARCH_RESPONSE" });
  for (const payload of [null, {}, { "release-groups": {} }]) {
    const client = createMusicBrainzSearch({ intervalMs: 0, fetchFn: async () => response(payload) });
    await assert.rejects(() => client.searchReleaseGroups("invalid"), { code: "MUSICBRAINZ_INVALID_SEARCH_RESPONSE" });
  }
});

test("ranked search cache expires and evicts entries at its configured bound", async () => {
  let now = 0;
  let calls = 0;
  const client = createMusicBrainzSearch({
    intervalMs: 0, nowMs: () => now, cacheTtlMs: 100, cacheMaxEntries: 1,
    fetchFn: async () => { calls += 1; return response({ "release-groups": [releaseGroup()] }); },
  });
  await client.searchReleaseGroups("first");
  await client.searchReleaseGroups("first", 1);
  assert.equal(calls, 1);
  now = 100;
  await client.searchReleaseGroups("first");
  assert.equal(calls, 2);
  await client.searchReleaseGroups("second");
  await client.searchReleaseGroups("first");
  assert.equal(calls, 4);
});


test("failure diagnostics separate gate and fetch timing across provider failure categories", async () => {
  for (const [category, fetchResult, status] of [
    ["network", () => { throw new Error("secret URL"); }, undefined],
    ["upstream_http", () => response(null, 503), 503],
    ["invalid_response", () => response({ unexpected: "secret" }), 200],
    ["invalid_response", () => ({ ...response(null), json: async () => { throw new SyntaxError("secret"); } }), 200],
  ]) {
    let now = 0;
    const client = createMusicBrainzSearch({
      nowMs: () => now,
      rateGate: async () => { now += 850; },
      fetchFn: async () => { now += 120; return fetchResult(); },
    });
    await assert.rejects(() => client.searchReleaseGroups("secret"), (error) => {
      assert.deepEqual(error.diagnostics, {
        category, ...(status ? { upstreamStatus: status } : {}), gateWaitMs: 850, fetchDurationMs: 120,
      });
      assert.equal(JSON.stringify(error.diagnostics).includes("secret"), false);
      return true;
    });
    assert.equal(client.stats.networkRequests, 1);
  }
});

test("abort during response-body reading is diagnosed as timeout", async () => {
  const client = createMusicBrainzSearch({
    timeoutMs: 5, intervalMs: 0,
    fetchFn: async (url, { signal }) => ({
      ...response(null),
      json: () => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("body aborted")), { once: true });
      }),
    }),
  });
  await assert.rejects(() => client.searchReleaseGroups("secret"), (error) => {
    assert.equal(error.diagnostics.category, "timeout");
    assert.equal(error.diagnostics.upstreamStatus, 200);
    assert.ok(error.diagnostics.fetchDurationMs >= 0);
    return true;
  });
});
