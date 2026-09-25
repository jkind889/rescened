const test = require("node:test");
const assert = require("node:assert/strict");
const { createClient, retryAfter, referenceFromRelease } = require("../lib/listeningStudy/provider");
const { album, recent } = require("./fixtures/listeningStudy/synthetic");
const response = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
function harness(fetchFn) {
  let now = 0; const sleeps = [];
  return { sleeps, client: createClient({ apiKey: "test-secret", fetchFn, now: () => now, sleepFn: async (ms) => { sleeps.push(ms); now += ms; } }) };
}
test("provider sends identifying UA, disables autocorrect, and paces concurrent requests", async () => {
  const urls = []; const { client, sleeps } = harness(async (url, options) => {
    urls.push(url); assert.match(options.headers["User-Agent"], /Rescened/); return response(album("X", 1));
  });
  await Promise.all([client.album("Artist", "X"), client.album("Artist", "X")]);
  assert.equal(urls[0].searchParams.get("autocorrect"), "0"); assert.ok(sleeps.includes(1100));
});
test("retry-after seconds and date parsing; over-budget throttle stops", async () => {
  assert.equal(retryAfter("3", 0), 3000); assert.equal(retryAfter("Thu, 01 Jan 1970 00:00:05 GMT", 0), 5000);
  let calls = 0; const { client } = harness(async () => { calls++; return response({}, 429, { "retry-after": "60" }); });
  await assert.rejects(client.album("A", "B"), /provider_unavailable/); assert.equal(calls, 1);
});
test("bounded transient retries; no retry on permanent authentication errors", async () => {
  let calls = 0; const { client } = harness(async () => { calls++; return response({ error: 16 }); });
  await assert.rejects(client.album("A", "B"), /provider_unavailable/); assert.equal(calls, 3);
  calls = 0; const auth = harness(async () => { calls++; return response({ error: 10, message: "test-secret" }); });
  await assert.rejects(auth.client.album("A", "B"), (error) => !error.message.includes("test-secret")); assert.equal(calls, 1);
});
test("malformed JSON does not retry or leak payload", async () => {
  let calls = 0; const { client } = harness(async () => { calls++; return new Response("private invalid payload"); });
  await assert.rejects(client.album("A", "B"), /malformed_json/); assert.equal(calls, 1);
});
test("network failures are bounded and sanitize request URLs", async () => {
  let calls = 0; const { client } = harness(async (url) => { calls++; throw new Error(String(url)); });
  await assert.rejects(client.album("A", "B"), (e) => e.message === "network_or_timeout"); assert.equal(calls, 3);
});
test("recent tracks reads all pages of a fixed window", async () => {
  let calls = 0; const { client } = harness(async (url) => {
    calls++; const data = recent("X", [calls]); data.recenttracks["@attr"].totalPages = "2";
    assert.equal(url.searchParams.get("from"), "999"); assert.equal(url.searchParams.get("to"), "2001"); return response(data);
  });
  const result = await client.recent("fixture_user", 1000, 2000);
  assert.equal(result.complete, true); assert.equal(result.pages.length, 2);
});
test("changing pagination and page-budget overflow cannot produce complete evidence", async () => {
  let calls = 0; const { client } = harness(async () => {
    const data = recent("X", [1]); data.recenttracks["@attr"].totalPages = String(++calls + 1); return response(data);
  });
  await assert.rejects(client.recent("fixture_user", 1000, 2000), /pagination_changed/);
  const budget = harness(async () => { const data = recent("X", [1]); data.recenttracks["@attr"].totalPages = "21"; return response(data); });
  await assert.rejects(budget.client.recent("fixture_user", 1000, 2000), /page_budget/);
});
test("invalid windows and missing key fail before requesting", async () => {
  const client = createClient({ fetchFn: () => assert.fail("unexpected request") });
  await assert.rejects(client.recent("fixture_user", 0, 999), /invalid_capture/);
  assert.throws(() => client.album("A", "B"), /LASTFM_API_KEY_required/);
});
test("MusicBrainz reference requires complete media and distinct typed track IDs", () => {
  const id = "11111111-1111-1111-1111-111111111111";
  const payload = { id, title: "Album", "release-group": { id }, "artist-credit": [{ name: "Artist" }], media: [{ position: 1, "track-count": 1, tracks: [{ id, position: 1, title: "Song", recording: { id } }] }] };
  const ref = referenceFromRelease(payload, { artist: "Artist", queryTitle: "Album" }, "reviewer", new Date().toISOString());
  assert.equal(ref.tracks.length, 1); assert.equal(ref.tracks[0].recordingMbid, id);
  payload.media[0]["track-count"] = 2;
  assert.throws(() => referenceFromRelease(payload, { artist: "Artist" }, "reviewer", "date"), /Incomplete/);
});

test("release browsing paginates and rejects a changing candidate population", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const offsets = [];
  const { client } = harness(async (url) => {
    const offset = Number(url.searchParams.get("offset")); offsets.push(offset);
    return response({ "release-count": 101, releases: Array.from({ length: offset ? 1 : 100 }, (_, i) => ({ id: String(offset + i) })) });
  });
  const result = await client.browseReleases(id);
  assert.equal(result.complete, true); assert.equal(result.releases.length, 101); assert.deepEqual(offsets, [0, 100]);
  let calls = 0;
  const changed = harness(async () => response({ "release-count": ++calls === 1 ? 101 : 102, releases: Array.from({ length: 100 }, () => ({})) }));
  await assert.rejects(changed.client.browseReleases(id), /release_browse_changed/);
});

test("reference artist credits preserve source join phrases", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const payload = { id, title: "Album", "release-group": { id }, "artist-credit": [{ name: "Artist" }], media: [{ position: 1, "track-count": 1, tracks: [{ id, position: 1, title: "Song", recording: { id }, "artist-credit": [{ name: "Artist", joinphrase: " feat. " }, { name: "Guest" }] }] }] };
  const ref = referenceFromRelease(payload, { artist: "Artist", queryTitle: "Album" }, "reviewer", new Date().toISOString());
  assert.equal(ref.tracks[0].artist, "Artist feat. Guest");
});
