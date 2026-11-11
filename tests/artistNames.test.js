const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createArtistNameLookup, normalizeNameRecord, resolvePlanArtistNames, CACHE_TTL_MS, MAX_RESPONSE_BYTES } = require("../lib/artists/names");
const { newArtistDocument } = require("../lib/artists/identity");
const { sealPlan, verifySealedPlan } = require("../lib/artists/backfill");

const A = "7c12b436-0fa3-473a-b908-6b7c1c9a5f24";
const B = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
const credited = "Jorge Rivera-Herrans, Luke Holt, Anna Lea, Armando Julián, Cast of EPIC";
const NOW = Date.parse("2026-11-11T00:00:00.000Z");
const record = (id = A, name = "Jorge Rivera-Herrans") => normalizeNameRecord({ id, name }, id, new Date(NOW).toISOString());
const response = (body, init) => new Response(JSON.stringify(body), init);
function timing() {
  let now = NOW;
  const waits = [];
  return { nowMs: () => now, waits, sleepFn: async (ms) => { waits.push(ms); now += ms; } };
}
function plan(names = [[A, credited]]) {
  return sealPlan({ kind: "rescened-artist-identity-backfill", planVersion: "1.0.0", target: { databaseName: "rescened_test" },
    artistRegistrations: names.map(([artistMbid, name]) => newArtistDocument({ name, artistMbid, source: "import" })),
    albumUpdates: [{ beforeCredits: [{ name: credited, role: "main" }], afterCredits: [{ name: credited, role: "main", artistMbid: A }] }],
  });
}
async function cacheDirectory(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "artist-name-test-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("canonical names are verified by MBID and never split credited strings", () => {
  assert.equal(record().name, "Jorge Rivera-Herrans");
  assert.throws(() => normalizeNameRecord({ id: B, name: "Wrong" }, A, new Date(NOW).toISOString()), { code: "ARTIST_NAME_ID_MISMATCH" });
  for (const name of ["", " ", "bad\nname", "x".repeat(501), null, {}]) {
    assert.throws(() => normalizeNameRecord({ id: A, name }, A, new Date(NOW).toISOString()), { code: "ARTIST_NAME_INVALID_RESPONSE" });
  }
  const canonical = newArtistDocument({ name: credited, artistName: "Jorge Rivera-Herrans", artistMbid: A, source: "import" });
  assert.equal(canonical.name, "Jorge Rivera-Herrans");
  assert.equal(canonical.fieldProvenance.name.nameSource, "musicbrainz-artist");
  assert.equal(newArtistDocument({ name: credited, artistMbid: A, source: "community" }).fieldProvenance.name.nameSource, "artist-credit");
});

test("lookup uses an exact MusicBrainz endpoint, identifying headers, no redirects, and one-second pacing", async () => {
  const clock = timing();
  const calls = [];
  const lookup = createArtistNameLookup({ ...clock, fetchFn: async (url, init) => {
    calls.push({ url, init, at: clock.nowMs() });
    return response({ id: url.includes(A) ? A : B, name: url.includes(A) ? "Jorge Rivera-Herrans" : "Radiohead" });
  } });
  assert.equal((await lookup(A)).name, "Jorge Rivera-Herrans");
  await lookup(B);
  assert.equal(calls[0].url, `https://musicbrainz.org/ws/2/artist/${A}?fmt=json`);
  assert.equal(calls[0].init.redirect, "error");
  assert.match(calls[0].init.headers["User-Agent"], /Rescened.*https:\/\/github.com\/jkind889\/rescened/);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.ok(calls[1].at - calls[0].at >= 1100);
});

test("lookup respects Retry-After and caps requests at three attempts", async () => {
  const clock = timing();
  let calls = 0;
  const lookup = createArtistNameLookup({ ...clock, fetchFn: async () => {
    calls += 1;
    return calls < 3 ? response({}, { status: 429, headers: { "Retry-After": "2" } }) : response({ id: A, name: "Jorge Rivera-Herrans" });
  } });
  await lookup(A);
  assert.equal(calls, 3);
  assert.deepEqual(clock.waits, [2000, 2000]);
  let failures = 0;
  const failing = createArtistNameLookup({ ...timing(), fetchFn: async () => { failures += 1; throw new Error("offline"); } });
  await assert.rejects(failing(A), { code: "ARTIST_NAME_LOOKUP_FAILED" });
  assert.equal(failures, 3);
});

test("over-budget throttles stop rather than retry early", async () => {
  let calls = 0;
  const lookup = createArtistNameLookup({ ...timing(), fetchFn: async () => {
    calls += 1;
    return response({}, { status: 503, headers: { "Retry-After": "60" } });
  } });
  await assert.rejects(lookup(A), { code: "ARTIST_NAME_RETRY_AFTER" });
  assert.equal(calls, 1);
});

test("mismatched identities, malformed JSON, oversized bodies, and 404s do not retry", async () => {
  const cases = [
    [() => response({ id: B, name: "Wrong" }), "ARTIST_NAME_ID_MISMATCH"],
    [() => new Response("not json"), "ARTIST_NAME_INVALID_RESPONSE"],
    [() => new Response("x".repeat(MAX_RESPONSE_BYTES + 1)), "ARTIST_NAME_INVALID_RESPONSE"],
    [() => response({ id: A, name: "Jorge" }, { headers: { "Content-Length": String(MAX_RESPONSE_BYTES + 1) } }), "ARTIST_NAME_INVALID_RESPONSE"],
    [() => response({}, { status: 404 }), "ARTIST_NAME_HTTP_ERROR"],
  ];
  for (const [makeResponse, code] of cases) {
    let calls = 0;
    const lookup = createArtistNameLookup({ ...timing(), fetchFn: async () => { calls += 1; return makeResponse(); } });
    await assert.rejects(lookup(A), { code });
    assert.equal(calls, 1);
  }
});

test("timeouts abort requests and the overall time budget is bounded", async () => {
  let calls = 0;
  const lookup = createArtistNameLookup({ ...timing(), timeoutMs: 2, fetchFn: (_url, { signal }) => new Promise((_resolve, reject) => {
    calls += 1;
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }) });
  await assert.rejects(lookup(A), { code: "ARTIST_NAME_LOOKUP_FAILED" });
  assert.equal(calls, 3);
  const bounded = createArtistNameLookup({ ...timing(), budgetMs: 1000, fetchFn: async () => response({}, { status: 429, headers: { "Retry-After": "2" } }) });
  await assert.rejects(bounded(A), { code: "ARTIST_NAME_BUDGET_EXHAUSTED" });
});

test("enrichment changes only new registry names and seals the verified provenance", async (context) => {
  const cacheDir = await cacheDirectory(context);
  const original = plan();
  const before = structuredClone(original);
  let calls = 0;
  const options = { cacheDir, nowMs: () => NOW, lookup: async () => { calls += 1; return record(); } };
  const resolved = await resolvePlanArtistNames(original, options);
  assert.deepEqual(original, before, "the original sealed plan is not mutated");
  assert.deepEqual(resolved.albumUpdates, original.albumUpdates, "credited display stays unchanged");
  assert.equal(resolved.artistRegistrations[0].name, "Jorge Rivera-Herrans");
  assert.equal(resolved.artistRegistrations[0].artistId, original.artistRegistrations[0].artistId);
  assert.equal(resolved.artistRegistrations[0].fieldProvenance.name.nameSource, "musicbrainz-artist");
  assert.equal(resolved.artistRegistrations[0].fieldProvenance.name.retrievedAt, new Date(NOW).toISOString());
  assert.equal(resolved.artistNameResolution.changedNames[0].creditedName, credited);
  assert.notEqual(resolved.planSha256, original.planSha256);
  assert.equal(verifySealedPlan(resolved, resolved.planSha256), resolved.planSha256);
  const reused = await resolvePlanArtistNames(original, options);
  assert.equal(calls, 1, "fresh cache avoids additional provider requests");
  assert.equal(reused.artistNameResolution.cached, 1);
  const stale = await resolvePlanArtistNames(original, { ...options, nowMs: () => NOW + CACHE_TTL_MS + 1, lookup: async () => { calls += 1; return { ...record(), retrievedAt: new Date(NOW + CACHE_TTL_MS + 1).toISOString() }; } });
  assert.equal(calls, 2);
  assert.equal(stale.artistNameResolution.cached, 0);
});

test("failed resolution preserves completed cache entries and releases its lock", async (context) => {
  const cacheDir = await cacheDirectory(context);
  const original = plan([[A, credited], [B, "Radiohead credit"]]);
  await assert.rejects(resolvePlanArtistNames(original, { cacheDir, nowMs: () => NOW, lookup: async (mbid) => {
    if (mbid === B) throw new Error("unavailable");
    return record();
  } }), /unavailable/);
  const calls = [];
  const retried = await resolvePlanArtistNames(original, { cacheDir, nowMs: () => NOW, lookup: async (mbid) => { calls.push(mbid); return record(B, "Radiohead"); } });
  assert.deepEqual(calls, [B]);
  assert.equal(retried.artistNameResolution.resolved, 2);
  assert.equal(original.artistRegistrations[0].name, credited);
});

test("concurrent cache users fail closed", async (context) => {
  const cacheDir = await cacheDirectory(context);
  await fs.writeFile(path.join(cacheDir, ".artist-name-fetch.lock"), "active test operator");
  await assert.rejects(resolvePlanArtistNames(plan(), { cacheDir, lookup: () => assert.fail("locked cache must not fetch") }), { code: "ARTIST_NAME_CACHE_LOCKED" });
});
