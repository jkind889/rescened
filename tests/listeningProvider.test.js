const assert = require("node:assert/strict");
const test = require("node:test");
const { MAX_RESPONSE_BYTES, createLastfmProvider, lastfmSourceUrl, retryAfter, signature } = require("../lib/listening/provider");

function response(data, status = 200, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (name) => headers[String(name).toLowerCase()] || null }, async text() { return JSON.stringify(data); } };
}

function provider(fetchImpl, extra = {}) {
  return createLastfmProvider({
    fetchImpl,
    env: { LASTFM_API_KEY: "public-key", LASTFM_API_SECRET: "private-secret", LASTFM_USER_AGENT: "RescenedTests/1" },
    budget: { async acquire() {} }, cache: false, sleep: async () => {}, ...extra,
  });
}

test("authorization URL binds state in the callback without exposing the secret", () => {
  const url = new URL(provider(async () => response({})).authorizationUrl({ state: "one-time-state", callbackUrl: "https://rescened.test/account/lastfm/callback" }));
  assert.equal(url.origin, "https://www.last.fm");
  assert.equal(url.searchParams.get("api_key"), "public-key");
  const callback = new URL(url.searchParams.get("cb"));
  assert.equal(callback.searchParams.get("state"), "one-time-state");
  assert.equal(url.toString().includes("private-secret"), false);
});

test("session exchange returns only the provider username", async () => {
  let requestUrl;
  const result = await provider(async (url) => { requestUrl = new URL(url); return response({ session: { name: "Listener", key: "must-not-escape", subscriber: 0 } }); }).getSession("temporary-token");
  assert.deepEqual(result, { username: "Listener" });
  assert.equal(requestUrl.searchParams.get("method"), "auth.getSession");
  assert.ok(requestUrl.searchParams.get("api_sig"));
  assert.equal(requestUrl.searchParams.get("format"), "json");
});

test("recent tracks normalizes rows, preserves missing album metadata, and flags now-playing", async () => {
  const client = provider(async () => response({ recenttracks: {
    "@attr": { page: "1", totalPages: "1" },
    track: [
      { name: "Current", artist: { "#text": "Artist" }, album: { "#text": "Album" }, "@attr": { nowplaying: "true" } },
      { name: "Played", artist: { "#text": "Artist" }, album: { "#text": "" }, date: { uts: "1790341200" }, mbid: "11111111-1111-4111-8111-111111111111" },
    ],
  } }));
  const result = await client.recentTracks({ username: "Listener", from: new Date("2026-09-25T12:00:00Z"), to: new Date("2026-09-25T14:00:00Z") });
  assert.equal(result.totalPages, 1);
  assert.deepEqual(result.tracks[0], { nowPlaying: true });
  assert.equal(result.tracks[1].album, "");
  assert.equal(result.tracks[1].track, "Played");
});

test("retry controls honor Retry-After and retry only transient responses", async () => {
  const sleeps = [];
  let calls = 0;
  const client = provider(async () => {
    calls += 1;
    return calls === 1 ? response({}, 429, { "retry-after": "2" }) : response({ album: { name: "Album", artist: "Artist", tracks: { track: [] } } });
  }, { sleep: async (ms) => sleeps.push(ms) });
  assert.equal((await client.albumInfo({ artist: "Artist", album: "Album" })).album, "Album");
  assert.deepEqual(sleeps, [2_000]);
  assert.equal(calls, 2);
});

test("signature and Retry-After parsing are deterministic", () => {
  assert.equal(signature({ method: "auth.getSession", token: "token", api_key: "key" }, "secret"), signature({ token: "token", api_key: "key", method: "auth.getSession" }, "secret"));
  assert.equal(retryAfter("3", 0), 3_000);
  assert.equal(retryAfter("Thu, 01 Jan 1970 00:00:05 GMT", 1_000), 4_000);
  assert.equal(retryAfter("invalid", 0), null);
});

test("permanent provider rejections are not retried", async () => {
  let calls = 0;
  const client = provider(async () => { calls += 1; return response({}, 404); });
  await assert.rejects(client.albumInfo({ artist: "Artist", album: "Album" }), (error) => error.code === "lastfm_request_rejected");
  assert.equal(calls, 1);
});

test("one-use session exchange is never retried after an uncertain failure", async () => {
  let calls = 0;
  const client = provider(async () => { calls += 1; return response({}, 503); });
  await assert.rejects(client.getSession("single-use-token"), (error) => error.code === "lastfm_temporarily_unavailable");
  assert.equal(calls, 1);
});

test("recent-track pagination metadata is strict", async () => {
  const client = provider(async () => response({ recenttracks: { "@attr": { page: "1" }, track: [] } }));
  await assert.rejects(
    client.recentTracks({ username: "Listener", from: new Date("2026-09-25T12:00:00Z"), to: new Date("2026-09-25T14:00:00Z") }),
    (error) => error.code === "lastfm_malformed_response",
  );
});

test("album cache stores only normalized bounded metadata", async () => {
  let stored;
  const cache = { async get() { return null; }, async set(_key, value) { stored = value; } };
  const client = provider(async () => response({ album: {
    name: "Album", artist: "Artist", url: "https://www.last.fm/music/Artist/Album",
    image: [{ "#text": "unretained" }], tags: { tag: [{ name: "unretained" }] },
    tracks: { track: [{ name: "One", duration: "100" }] },
  } }), { cache });
  await client.albumInfo({ artist: "Artist", album: "Album" });
  assert.deepEqual(stored, { artist: "Artist", album: "Album", mbid: "", url: "https://www.last.fm/music/Artist/Album", tracks: ["One"], retrievedAt: stored.retrievedAt });
  assert.match(stored.retrievedAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(JSON.stringify(stored).includes("unretained"), false);
});

test("Retry-After beyond the bounded retry budget defers without sleeping", async () => {
  let calls = 0;
  const sleeps = [];
  const client = provider(async () => { calls += 1; return response({}, 429, { "retry-after": "60" }); }, { sleep: async (ms) => sleeps.push(ms) });
  await assert.rejects(client.albumInfo({ artist: "Artist", album: "Album" }), (error) => error.code === "lastfm_rate_limited" && error.retryAfterMs === 60_000);
  assert.equal(calls, 1);
  assert.deepEqual(sleeps, []);
});

test("Retry-After publishes a shared cooldown before retrying", async () => {
  const deferred = [];
  let calls = 0;
  const client = provider(async () => {
    calls += 1;
    return calls === 1
      ? response({}, 429, { "retry-after": "2" })
      : response({ album: { name: "Album", artist: "Artist", tracks: { track: [] } } });
  }, {
    budget: { async acquire() {}, async defer(delayMs) { deferred.push(delayMs); } },
  });
  await client.albumInfo({ artist: "Artist", album: "Album" });
  assert.deepEqual(deferred, [2_000]);
});

test("service Retry-After also publishes a shared cooldown", async () => {
  const deferred = [];
  const client = provider(async () => response({}, 503, { "retry-after": "1" }), {
    budget: { async acquire() {}, async defer(delayMs) { deferred.push(delayMs); } },
  });
  await assert.rejects(client.albumInfo({ artist: "Artist", album: "Album" }), (error) => error.code === "lastfm_temporarily_unavailable");
  assert.deepEqual(deferred, [1_000, 1_000, 1_000]);
});

test("streamed responses are cancelled when they exceed the body limit", async () => {
  let cancelled = false;
  let emitted = false;
  const client = provider(async () => ({
    ok: true,
    status: 200,
    headers: { get() { return null; } },
    body: { getReader() { return {
      async read() {
        if (emitted) return { done: true };
        emitted = true;
        return { done: false, value: Buffer.alloc(MAX_RESPONSE_BYTES + 1) };
      },
      async cancel() { cancelled = true; },
      releaseLock() {},
    }; } },
  }));
  await assert.rejects(client.albumInfo({ artist: "Artist", album: "Album" }), (error) => error.code === "lastfm_response_too_large");
  assert.equal(cancelled, true);
});

test("source URLs reject credentials, queries, and fragments", () => {
  assert.equal(lastfmSourceUrl("https://www.last.fm/music/Artist/Album"), "https://www.last.fm/music/Artist/Album");
  assert.equal(lastfmSourceUrl("https://user:pass@www.last.fm/music/Artist/Album"), "");
  assert.equal(lastfmSourceUrl("https://www.last.fm/music/Artist/Album?token=secret"), "");
  assert.equal(lastfmSourceUrl("https://www.last.fm/music/Artist/Album#secret"), "");
});
