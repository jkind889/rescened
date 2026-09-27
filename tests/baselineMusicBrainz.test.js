const assert = require("node:assert/strict");
const test = require("node:test");

const {
  BaselineMusicBrainzError,
  createBaselineMusicBrainz,
  hashCandidateTracklist,
  parseReleaseId,
  validateNormalizedCandidate,
} = require("../lib/baselines/musicBrainz");

const GROUP = "11111111-1111-4111-8111-111111111111";
const RELEASE_ONE = "22222222-2222-4222-8222-222222222222";
const RELEASE_TWO = "33333333-3333-4333-8333-333333333333";
const RELEASE_THREE = "44444444-4444-4444-8444-444444444444";
const RECORDING_ONE = "55555555-5555-4555-8555-555555555555";
const RECORDING_TWO = "66666666-6666-4666-8666-666666666666";
const TRACK_ONE = "77777777-7777-4777-8777-777777777777";
const TRACK_TWO = "88888888-8888-4888-8888-888888888888";

function response(data, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    async json() { return data; },
  };
}

function credits(name = "Artist") {
  return [{ name, joinphrase: "", artist: { name } }];
}

function rawTrack(position, id, recordingId, title = `Track ${position}`) {
  return {
    id,
    position,
    title,
    length: 180_000 + position,
    recording: { id: recordingId, title, length: 180_000 + position },
  };
}

function rawRelease(id = RELEASE_ONE, overrides = {}) {
  return {
    id,
    title: "Album",
    date: "2020-01-01",
    country: "US",
    status: "official",
    disambiguation: "",
    "release-group": { id: GROUP },
    "artist-credit": credits(),
    media: [{ position: 1, format: "CD", "track-count": 2, tracks: [rawTrack(1, TRACK_ONE, RECORDING_ONE), rawTrack(2, TRACK_TWO, RECORDING_TWO)] }],
    ...overrides,
  };
}

function browseRelease(id, overrides = {}) {
  return {
    id,
    title: "Album",
    date: "2020-01-01",
    status: "official",
    "release-group": { id: GROUP },
    "artist-credit": credits(),
    ...overrides,
  };
}

function memoryCache(now = () => 0) {
  const values = new Map();
  return {
    calls: { get: 0, set: 0 },
    async get(key) {
      this.calls.get += 1;
      const row = values.get(key);
      return row && row.expiresAt > now() ? row.value : null;
    },
    async set(key, value, ttl) {
      this.calls.set += 1;
      values.set(key, { value, expiresAt: now() + ttl });
    },
  };
}

function client(fetchFn, options = {}) {
  return createBaselineMusicBrainz({
    fetchFn,
    cache: options.cache ?? false,
    gate: options.gate || (async () => {}),
    clock: options.clock || (() => new Date("2026-09-26T12:00:00.000Z")),
    timeoutMs: 1_000,
    ...options,
  });
}

test("release normalizes complete multi-disc media, preserves repeated recordings, hashes, and caches", async () => {
  const cache = memoryCache(() => 0);
  let calls = 0;
  const fetchFn = async (url) => {
    calls += 1;
    assert.deepEqual(new URL(url).searchParams.get("inc").split(" ").sort(), ["artist-credits", "media", "recordings", "release-groups"].sort());
    assert.match(url, new RegExp(`/release/${RELEASE_ONE}\\?`));
    return response(rawRelease(RELEASE_ONE, {
      media: [
        { position: 1, format: "CD", "track-count": 1, tracks: [rawTrack(1, TRACK_ONE, RECORDING_ONE)] },
        { position: 2, format: "CD", "track-count": 1, tracks: [rawTrack(1, TRACK_TWO, RECORDING_ONE, "Reprise")] },
      ],
    }));
  };
  const api = client(fetchFn, { cache });
  const first = await api.release(`https://musicbrainz.org/release/${RELEASE_ONE}`);
  const second = await api.release(RELEASE_ONE);
  assert.equal(calls, 1);
  assert.equal(first.tracks.length, 2);
  assert.equal(first.tracks[1].discNumber, 2);
  assert.equal(first.tracks[1].recordingMbid, RECORDING_ONE);
  assert.equal(first.license, "CC0");
  assert.equal(first.tracklistHash, hashCandidateTracklist(first));
  assert.deepEqual(second.tracks, first.tracks);
});

test("release rejects malformed, partial, duplicate-position, and mismatched identity responses", async () => {
  const cases = [
    ["partial medium", rawRelease(RELEASE_ONE, { media: [{ position: 1, "track-count": 2, tracks: [rawTrack(1, TRACK_ONE, RECORDING_ONE)] }] }), "MUSICBRAINZ_INCOMPLETE_TRACKLIST"],
    ["duplicate track positions", rawRelease(RELEASE_ONE, { media: [{ position: 1, "track-count": 2, tracks: [rawTrack(1, TRACK_ONE, RECORDING_ONE), rawTrack(1, TRACK_TWO, RECORDING_TWO)] }] }), "MUSICBRAINZ_INCOMPLETE_TRACKLIST"],
    ["mismatched release id", rawRelease(RELEASE_TWO), "MUSICBRAINZ_INVALID_RESPONSE"],
  ];
  for (const [name, payload, code] of cases) {
    const api = client(async () => response(payload));
    await assert.rejects(api.release(RELEASE_ONE), (error) => error instanceof BaselineMusicBrainzError && error.code === code, name);
  }
});

test("release browsing is bounded, reports total pagination, and reuses cache", async () => {
  const cache = memoryCache(() => 0);
  let calls = 0;
  const api = client(async (url) => {
    calls += 1;
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("limit"), "20");
    assert.equal(parsed.searchParams.get("offset"), "0");
    return response({ "release-count": 21, releases: [browseRelease(RELEASE_ONE)] });
  }, { cache });
  const first = await api.browseReleases(GROUP);
  const second = await api.browseReleases(GROUP);
  assert.equal(calls, 1);
  assert.equal(first.total, 21);
  assert.equal(first.nextOffset, 1);
  assert.equal(first.incomplete, true);
  assert.deepEqual(second.items, first.items);
});

test("recommend hydrates candidates and ranks official exact standard metadata without using track count", async () => {
  const releases = [
    browseRelease(RELEASE_ONE, { date: "2020-01-01", title: "Album" }),
    browseRelease(RELEASE_TWO, { date: "2019-01-01", title: "Album (Deluxe Edition)", disambiguation: "deluxe" }),
    browseRelease(RELEASE_THREE, { date: "2018-01-01", title: "Album", status: "promotion" }),
  ];
  const api = client(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/release")) return response({ "release-count": releases.length, releases });
    const id = parsed.pathname.split("/").at(-1);
    return response(rawRelease(id, { title: releases.find((item) => item.id === id).title, date: releases.find((item) => item.id === id).date, status: releases.find((item) => item.id === id).status }));
  });
  const result = await api.recommend(GROUP, { title: "Album" });
  assert.equal(result.candidate.releaseMbid, RELEASE_ONE);
  assert.equal(result.items.length, 3);
  assert.equal(result.incomplete, false);
  assert.equal(result.ambiguous, false);
  assert.match(result.rationale, /official/);
});

test("alternative URL parsing accepts only canonical MusicBrainz release URLs", () => {
  assert.equal(parseReleaseId(RELEASE_ONE), RELEASE_ONE);
  assert.equal(parseReleaseId(`https://musicbrainz.org/release/${RELEASE_ONE}/`), RELEASE_ONE);
  assert.equal(parseReleaseId(`https://evil.example/release/${RELEASE_ONE}`), "");
  assert.equal(parseReleaseId(`https://musicbrainz.org/ws/2/release/${RELEASE_ONE}`), "");
  assert.equal(parseReleaseId(`https://musicbrainz.org/release/${RELEASE_ONE}?redirect=1`), "");
});

test("retry-after is exposed and recorded without unbounded retries", async () => {
  let calls = 0;
  let noted = null;
  const api = client(async () => {
    calls += 1;
    return response({ error: "busy" }, 429, { "retry-after": "3" });
  }, { onRetryAfter: async (delay) => { noted = delay; } });
  await assert.rejects(api.release(RELEASE_ONE), (error) => error.code === "MUSICBRAINZ_RATE_LIMITED" && error.retryAfterMs === 3_000);
  assert.equal(calls, 1);
  assert.equal(noted, 3_000);
});

test("normalized candidate validation detects tampering after hash computation", async () => {
  const candidate = await client(async () => response(rawRelease())).release(RELEASE_ONE);
  assert.equal(validateNormalizedCandidate(candidate), true);
  candidate.tracks[0].title = "Changed";
  assert.throws(() => validateNormalizedCandidate(candidate), { code: "MUSICBRAINZ_CANDIDATE_HASH_MISMATCH" });
});

test('recommendation has a finite interactive lookup budget and exposes remaining alternatives', async () => {
  const releases = Array.from({ length: 20 }, (_, index) => browseRelease(`${String(index + 10).padStart(8, '0')}-1111-4111-8111-111111111111`));
  let calls = 0;
  const api = client(async (url) => {
    calls += 1;
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/release')) return response({ 'release-count': 200, releases });
    return response(rawRelease(parsed.pathname.split('/').at(-1)));
  });
  const result = await api.recommend(GROUP, { title: 'Album' });
  assert.equal(calls, 4);
  assert.equal(result.nextOffset, 20);
  assert.equal(result.incomplete, true);
  assert.equal(result.ambiguous, true);
});

test('invalid complete-release responses are not cached and empty pages cannot loop', async () => {
  const cache = memoryCache(() => 0);
  let calls = 0;
  const api = client(async () => {
    calls += 1;
    return response(calls === 1 ? rawRelease(RELEASE_TWO) : rawRelease(RELEASE_ONE));
  }, { cache });
  await assert.rejects(api.release(RELEASE_ONE), { code: 'MUSICBRAINZ_INVALID_RESPONSE' });
  await api.release(RELEASE_ONE);
  assert.equal(calls, 2);
  const empty = await client(async () => response({ 'release-count': 20, releases: [] })).browseReleases(GROUP);
  assert.equal(empty.nextOffset, null);
  assert.equal(empty.incomplete, true);
});

test('retry-after date is honored without Mongo update-path conflicts', async () => {
  let update;
  const api = client(async () => response({}, 503, { 'retry-after': 'Sat, 26 Sep 2026 12:00:05 GMT' }), { budget: { updateOne: async (_, value) => { update = value; } } });
  await assert.rejects(api.release(RELEASE_ONE), { code: 'MUSICBRAINZ_UNAVAILABLE' });
  assert.equal(update.$max.windowStartedAt.toISOString(), '2026-09-26T12:00:05.000Z');
  assert.equal(Object.keys(update.$setOnInsert).some((key) => key in update.$max), false);
});

test('recommendation preserves malformed-page warnings and rejects invalid calendar dates', async () => {
  const api = client(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/release')) {
      assert.deepEqual(parsed.searchParams.get('inc').split(' ').sort(), ['artist-credits', 'media', 'release-groups'].sort());
      return response({ 'release-count': 30, releases: [browseRelease(RELEASE_ONE, { date: '2020-99-99' }), { title: 'invalid' }] });
    }
    return response(rawRelease(RELEASE_ONE, { date: '2021-02-29' }));
  });
  const result = await api.recommend(GROUP, { title: 'Album' });
  assert.equal(result.incomplete, true);
  assert.equal(result.candidate.date, '');
  assert.equal(result.items[0].date, '');
});
