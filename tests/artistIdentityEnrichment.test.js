const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const okComputer = require("./fixtures/catalogImport/musicbrainz-ok-computer-release-group.json");
const {
  CACHE_TTL_MS,
  COOLDOWN_FILE,
  LOCK_FILE,
  MAX_RESPONSE_BYTES,
  acquireCacheLock,
  createReleaseGroupCreditFetcher,
  normalizeReleaseGroupPayload,
  processRateGate,
  readCacheEntry,
  runReleaseGroupEnrichment,
  writeCacheEntry,
} = require("../lib/artists/releaseGroupCredits");
const { readEvidenceFile, validateEvidence } = require("../lib/artists/enrichmentEvidence");
const { createRateGate } = require("../lib/catalogImport/listenBrainz");
const cli = require("../scripts/enrichArtistIdentities");

const OK = okComputer.id;
const RADIOHEAD = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
const RG1 = "11111111-1111-4111-8111-111111111111";
const RG2 = "22222222-2222-4222-8222-222222222222";
const RG3 = "33333333-3333-4333-8333-333333333333";
const A1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const A2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = Date.parse("2026-11-12T10:00:00.000Z");
const ids = (count) => Array.from({ length: count }, (_, index) => `${String(index + 1).padStart(8, "0")}-0000-4000-8000-000000000000`);

function clock(start = NOW) {
  let now = start;
  const sleeps = [];
  const sleepFn = async (ms) => { sleeps.push(ms); now += ms; };
  const nowMs = () => now;
  return { nowMs, sleepFn, sleeps, advance: (ms) => { now += ms; }, gate: createRateGate({ intervalMs: 1100, nowMs, sleepFn }) };
}

const json = (body, init = {}) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, ...init });

function releaseGroup(id, credits = [{ name: "Alpha", joinphrase: " & ", artist: { id: A1, name: "Alpha" } }, { name: "B.", joinphrase: "", artist: { id: A2, name: "Beta" } }], title = "Record") {
  return { id, title, "artist-credit": credits };
}

// Serves release groups from a map; a function value decides per call.
function server(time, routes) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init, at: time.nowMs() });
    const id = /release-group\/([^?]+)/.exec(url)[1];
    const route = routes[id];
    if (typeof route === "function") return route(calls.filter((call) => call.url === url).length, init);
    if (route) return json(route);
    return json({ error: "Not Found" }, { status: 404 });
  };
  return { fetchFn, calls };
}

function tempDir(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "identity-enrichment-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function stalledBody() {
  return new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); } });
}

test("payloads use the importer's credit normalization and require canonical artist names", () => {
  const at = new Date(NOW).toISOString();
  const radiohead = normalizeReleaseGroupPayload(okComputer, OK, at);
  assert.deepEqual(radiohead, {
    releaseGroupMbid: OK, status: "resolved", observedAt: at, title: "OK Computer",
    credits: [{ name: "Radiohead", joinPhrase: "", artistMbid: RADIOHEAD, artistName: "Radiohead" }],
  });
  const credited = normalizeReleaseGroupPayload(releaseGroup(RG1, [
    { name: "  Jorge   Rivera-Herrans ", joinphrase: "  feat.  ", artist: { id: A1.toUpperCase(), name: "Jorge Rivera-Herrans" } },
    { name: "Cast of EPIC", joinphrase: "", artist: { id: A2, name: "Various Cast" } },
  ], "  EPIC:   The Musical "), RG1, at);
  assert.equal(credited.status, "resolved");
  assert.equal(credited.title, "EPIC: The Musical");
  assert.deepEqual(credited.credits, [
    { name: "Jorge Rivera-Herrans", joinPhrase: " feat. ", artistMbid: A1, artistName: "Jorge Rivera-Herrans" },
    { name: "Cast of EPIC", joinPhrase: "", artistMbid: A2, artistName: "Various Cast" },
  ]);
  assert.deepEqual(normalizeReleaseGroupPayload({ ...okComputer, id: RG2 }, OK, at), { releaseGroupMbid: OK, status: "unresolved", observedAt: at, reason: "ID_MISMATCH", destinationReleaseGroupMbid: RG2 });
  assert.equal(normalizeReleaseGroupPayload({ ...okComputer, id: "x" }, OK, at).reason, "INVALID_RESPONSE");
  assert.equal(normalizeReleaseGroupPayload([], OK, at).reason, "INVALID_RESPONSE");
  assert.equal(normalizeReleaseGroupPayload({ ...okComputer, title: "" }, OK, at).reason, "INVALID_RESPONSE");
  assert.equal(normalizeReleaseGroupPayload({ ...okComputer, "artist-credit": [] }, OK, at).reason, "INVALID_CREDITS");
  assert.equal(normalizeReleaseGroupPayload(releaseGroup(RG1, [{ name: "Alpha", joinphrase: "", artist: { id: A1 } }]), RG1, at).reason, "INVALID_CREDITS");
  assert.equal(normalizeReleaseGroupPayload(releaseGroup(RG1, [{ name: "Alpha", joinphrase: "", artist: { id: "nope", name: "Alpha" } }]), RG1, at).reason, "INVALID_CREDITS");
  assert.equal(normalizeReleaseGroupPayload(releaseGroup(RG1, [{ name: "Alpha", joinphrase: "", artist: { id: A1, name: "bad\u0007name" } }]), RG1, at).reason, "INVALID_CREDITS");
});

test("requests use the exact release-group endpoint, identify the client, never follow redirects, and share one pace", async () => {
  const time = clock();
  const { fetchFn, calls } = server(time, { [RG1]: releaseGroup(RG1), [RG2]: releaseGroup(RG2) });
  const fetcher = createReleaseGroupCreditFetcher({ fetchFn, nowMs: time.nowMs, sleepFn: time.sleepFn, rateGate: time.gate });
  assert.equal((await fetcher.fetchOne(RG1)).row.status, "resolved");
  assert.equal((await fetcher.fetchOne(RG2.toUpperCase())).row.status, "resolved");
  assert.equal(calls[0].url, `https://musicbrainz.org/ws/2/release-group/${RG1}?inc=artist-credits&fmt=json`);
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.method, "GET");
  assert.match(calls[0].init.headers["User-Agent"], /Rescened.*https:\/\/github.com\/jkind889\/rescened/);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.ok(calls[1].at - calls[0].at >= 1100);
  // Without an injected gate, every fetcher in the process shares one gate.
  const first = createReleaseGroupCreditFetcher({ fetchFn });
  const second = createReleaseGroupCreditFetcher({ fetchFn });
  assert.equal(first.gate, second.gate);
  assert.equal(first.gate, processRateGate());
  assert.throws(() => createReleaseGroupCreditFetcher({ fetchFn, userAgent: "anonymous" }), TypeError);
});

test("transient failures retry at most three times with pacing, then defer", async () => {
  const time = clock();
  let attempts = 0;
  const { fetchFn, calls } = server(time, { [RG1]: () => { attempts += 1; return attempts < 3 ? json({}, { status: 503 }) : json(releaseGroup(RG1)); } });
  const fetcher = createReleaseGroupCreditFetcher({ fetchFn, nowMs: time.nowMs, sleepFn: time.sleepFn, rateGate: time.gate });
  const recovered = await fetcher.fetchOne(RG1);
  assert.equal(recovered.row.status, "resolved");
  assert.equal(recovered.attempts, 3);
  for (let index = 1; index < calls.length; index += 1) assert.ok(calls[index].at - calls[index - 1].at >= 1100);

  const offline = createReleaseGroupCreditFetcher({ fetchFn: async () => { throw new TypeError("fetch failed"); }, nowMs: time.nowMs, sleepFn: time.sleepFn, rateGate: time.gate });
  const deferred = await offline.fetchOne(RG2);
  assert.deepEqual({ ...deferred.row, observedAt: undefined }, { releaseGroupMbid: RG2, status: "deferred", observedAt: undefined, reason: "TRANSIENT_FAILURE", attempts: 3, lastFailure: "NETWORK_ERROR" });

  for (const status of [408, 425, 429, 500, 502, 504]) {
    let count = 0;
    const always = createReleaseGroupCreditFetcher({ fetchFn: async () => { count += 1; return json({}, { status }); }, nowMs: time.nowMs, sleepFn: time.sleepFn, rateGate: time.gate });
    assert.equal((await always.fetchOne(RG3)).row.lastFailure, `HTTP_${status}`);
    assert.equal(count, 3, String(status));
  }
});

test("permanent outcomes, malformed bodies, and redirects are recorded without retrying", async () => {
  const time = clock();
  const cases = [
    [() => json({}, { status: 400 }), { reason: "HTTP_ERROR", httpStatus: 400 }],
    [() => json({}, { status: 403 }), { reason: "HTTP_ERROR", httpStatus: 403 }],
    [() => json({}, { status: 501 }), { reason: "HTTP_ERROR", httpStatus: 501 }],
    [() => json({}, { status: 404 }), { reason: "NOT_FOUND", httpStatus: 404 }],
    [() => new Response("not json", { status: 200 }), { reason: "INVALID_RESPONSE" }],
    [() => json({ ...releaseGroup(RG2), id: RG3 }), { reason: "ID_MISMATCH", destinationReleaseGroupMbid: RG3 }],
    [() => new Response(null, { status: 301, headers: { Location: `https://musicbrainz.org/ws/2/release-group/${RG3}?inc=artist-credits&fmt=json` } }), { reason: "REDIRECTED", httpStatus: 301, destinationReleaseGroupMbid: RG3 }],
    [() => new Response(null, { status: 307, headers: { Location: `/release-group/${RG3}` } }), { reason: "REDIRECTED", httpStatus: 307, destinationReleaseGroupMbid: RG3 }],
    [() => new Response(null, { status: 302, headers: { Location: `https://evil.example/release-group/${RG3}` } }), { reason: "REDIRECTED", httpStatus: 302 }],
    [() => new Response(null, { status: 308 }), { reason: "REDIRECTED", httpStatus: 308 }],
    [() => new Response("x".repeat(10), { status: 200, headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } }), { reason: "INVALID_RESPONSE" }],
    [() => new Response(new ReadableStream({ start(controller) { for (let i = 0; i < 5; i += 1) controller.enqueue(new Uint8Array(64 * 1024)); controller.close(); } }), { status: 200 }), { reason: "INVALID_RESPONSE" }],
  ];
  for (const [respond, expected] of cases) {
    let count = 0;
    const fetcher = createReleaseGroupCreditFetcher({ fetchFn: async () => { count += 1; return respond(); }, nowMs: time.nowMs, sleepFn: time.sleepFn, rateGate: time.gate });
    const { row } = await fetcher.fetchOne(RG2);
    const { releaseGroupMbid, status, observedAt: _at, ...rest } = row;
    assert.equal(releaseGroupMbid, RG2);
    assert.equal(status, "unresolved");
    assert.deepEqual(rest, expected);
    assert.equal(count, 1, JSON.stringify(expected));
  }
});

test("Retry-After is honored in both formats, and long throttles stop the run", async () => {
  for (const header of ["2", new Date(NOW + 5000).toUTCString()]) {
    const time = clock();
    let count = 0;
    const fetcher = createReleaseGroupCreditFetcher({
      fetchFn: async () => { count += 1; return count === 1 ? json({}, { status: 429, headers: { "Retry-After": header } }) : json(releaseGroup(RG1)); },
      nowMs: time.nowMs, sleepFn: time.sleepFn, rateGate: time.gate,
    });
    assert.equal((await fetcher.fetchOne(RG1)).row.status, "resolved");
    assert.ok(time.sleeps.some((ms) => ms >= (header === "2" ? 2000 : 5000)), `${header}: ${time.sleeps}`);
  }
  // A short Retry-After on the final attempt still delays the next ID.
  const time = clock();
  const calls = [];
  const fetcher = createReleaseGroupCreditFetcher({
    fetchFn: async (url) => { calls.push(time.nowMs()); return url.includes(RG1) ? json({}, { status: 503, headers: { "Retry-After": "20" } }) : json(releaseGroup(RG2)); },
    nowMs: time.nowMs, sleepFn: time.sleepFn, rateGate: time.gate,
  });
  assert.equal((await fetcher.fetchOne(RG1)).row.status, "deferred");
  await fetcher.fetchOne(RG2);
  assert.ok(calls[3] - calls[2] >= 20_000);

  const longTime = clock();
  const throttled = createReleaseGroupCreditFetcher({ fetchFn: async () => json({}, { status: 503, headers: { "Retry-After": "31" } }), nowMs: longTime.nowMs, sleepFn: longTime.sleepFn, rateGate: longTime.gate });
  await assert.rejects(throttled.fetchOne(RG1), (error) => error.code === "RETRY_AFTER_EXCEEDED" && error.notBefore === new Date(NOW + 31_000).toISOString());
});

test("the request timeout covers a stalled response body", async () => {
  let count = 0;
  const fetcher = createReleaseGroupCreditFetcher({
    fetchFn: async () => { count += 1; return new Response(stalledBody(), { status: 200 }); },
    rateGate: async () => {}, sleepFn: async () => {}, timeoutMs: 20,
  });
  const { row } = await fetcher.fetchOne(RG1);
  assert.equal(row.status, "deferred");
  assert.equal(row.lastFailure, "TIMEOUT");
  assert.equal(count, 3);
});

test("the run budget and interruption stop before further requests", async () => {
  const time = clock();
  const fetcher = createReleaseGroupCreditFetcher({ fetchFn: async () => json({}, { status: 503 }), nowMs: time.nowMs, sleepFn: time.sleepFn, rateGate: time.gate, deadlineMs: NOW + 1500 });
  await assert.rejects(fetcher.fetchOne(RG1), { code: "BUDGET_EXHAUSTED" });
  const controller = new AbortController();
  controller.abort();
  const stopped = createReleaseGroupCreditFetcher({ fetchFn: async () => json(releaseGroup(RG1)), nowMs: time.nowMs, sleepFn: time.sleepFn, rateGate: time.gate, signal: controller.signal });
  await assert.rejects(stopped.fetchOne(RG1), { code: "INTERRUPTED" });
  // Interrupting during a stalled body aborts the request as an interruption, not a timeout.
  const live = new AbortController();
  const hanging = createReleaseGroupCreditFetcher({ fetchFn: async () => new Response(stalledBody(), { status: 200 }), rateGate: async () => {}, sleepFn: async () => {}, signal: live.signal });
  const pending = hanging.fetchOne(RG1);
  setTimeout(() => live.abort(), 10);
  await assert.rejects(pending, { code: "INTERRUPTED" });
});

test("the cache keeps only validated, unexpired successes for their own ID", async (context) => {
  const directory = tempDir(context);
  const at = new Date(NOW).toISOString();
  const row = normalizeReleaseGroupPayload(releaseGroup(RG1), RG1, at);
  await writeCacheEntry(directory, row);
  assert.equal(fs.statSync(path.join(directory, `${RG1}.json`)).mode & 0o777, 0o600);
  assert.deepEqual(await readCacheEntry(directory, RG1, () => NOW + 1000), row);
  assert.equal(await readCacheEntry(directory, RG1, () => NOW + CACHE_TTL_MS + 1), null, "expired");
  assert.equal(await readCacheEntry(directory, RG1, () => NOW - 1), null, "observed in the future");
  assert.equal(await readCacheEntry(directory, RG2, () => NOW), null, "missing");
  const file = path.join(directory, `${RG2}.json`);
  const write = (value) => fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  const valid = { kind: "rescened-musicbrainz-release-group-credits-cache", cacheVersion: 1, row: { ...row, releaseGroupMbid: RG2 } };
  write(valid);
  assert.equal((await readCacheEntry(directory, RG2, () => NOW)).releaseGroupMbid, RG2);
  for (const corrupt of ["{", { ...valid, cacheVersion: 2 }, { ...valid, extra: 1 }, { ...valid, row: row }, { ...valid, row: { ...valid.row, credits: [] } }, { ...valid, row: { ...valid.row, status: "unresolved" } }, "x".repeat(MAX_RESPONSE_BYTES + 1)]) {
    write(corrupt);
    assert.equal(await readCacheEntry(directory, RG2, () => NOW), null, String(corrupt).slice(0, 40));
  }
  await assert.rejects(writeCacheEntry(directory, { ...row, status: "unresolved" }), TypeError);
});

test("the cache lock is exclusive and only a dead local owner's lock is removed", async (context) => {
  const directory = tempDir(context);
  const release = await acquireCacheLock(directory, { pid: 100, hostname: "here", isProcessAlive: () => true });
  await assert.rejects(acquireCacheLock(directory, { pid: 200, hostname: "here", isProcessAlive: () => true }), { code: "CACHE_LOCKED" });
  await assert.rejects(acquireCacheLock(directory, { pid: 200, hostname: "elsewhere", isProcessAlive: () => false }), { code: "CACHE_LOCKED" });
  const stale = await acquireCacheLock(directory, { pid: 200, hostname: "here", isProcessAlive: (pid) => pid !== 100 });
  await release();
  assert.ok(fs.existsSync(path.join(directory, LOCK_FILE)), "a released stale owner does not remove the new owner's lock");
  await stale();
  assert.equal(fs.existsSync(path.join(directory, LOCK_FILE)), false);
  fs.writeFileSync(path.join(directory, LOCK_FILE), "garbage");
  await assert.rejects(acquireCacheLock(directory, { pid: 300, hostname: "here", isProcessAlive: () => false }), { code: "CACHE_LOCKED" });
});

function runOptions(time, directory, fetchFn, extra = {}) {
  return {
    cacheDir: path.join(directory, "cache"),
    outPath: path.join(directory, "evidence.json"),
    fetchFn, nowMs: time.nowMs, sleepFn: time.sleepFn, rateGate: time.gate,
    isProcessAlive: () => true,
    ...extra,
  };
}

test("a run publishes sealed evidence with one result per ID and resumes from the cache", async (context) => {
  const directory = tempDir(context);
  const time = clock();
  const { fetchFn, calls } = server(time, { [RG1]: releaseGroup(RG1), [RG3]: () => json({}, { status: 503 }) });
  const result = await runReleaseGroupEnrichment({ ...runOptions(time, directory, fetchFn), ids: [RG1, RG2, RG3], originPlanSha256: "a".repeat(64) });
  const evidence = readEvidenceFile(result.outPath, result.evidence.evidenceSha256).evidence;
  assert.deepEqual(evidence.counts, { requested: 3, resolved: 1, unresolved: 1, deferred: 1 });
  assert.deepEqual(evidence.results.map((row) => [row.releaseGroupMbid, row.status, row.reason || null]), [[RG1, "resolved", null], [RG2, "unresolved", "NOT_FOUND"], [RG3, "deferred", "TRANSIENT_FAILURE"]]);
  assert.equal(evidence.request.originPlanSha256, "a".repeat(64));
  assert.equal(fs.statSync(path.join(directory, "cache")).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(path.join(directory, "cache", LOCK_FILE)), false);
  assert.equal(calls.length, 5);

  // A rerun reuses the cached success and refetches only unsuccessful IDs.
  time.advance(60_000);
  calls.length = 0;
  const rerun = await runReleaseGroupEnrichment({ ...runOptions(time, directory, fetchFn), outPath: path.join(directory, "second.json"), ids: [RG1, RG2, RG3] });
  assert.equal(rerun.progress.cached, 1);
  assert.deepEqual([...new Set(calls.map((call) => /release-group\/([^?]+)/.exec(call.url)[1]))], [RG2, RG3]);
  assert.equal(rerun.evidence.results[0].observedAt, evidence.results[0].observedAt);
  await assert.rejects(runReleaseGroupEnrichment({ ...runOptions(time, directory, fetchFn), ids: [RG1] }), { code: "ARTIFACT_EXISTS" });
  await assert.rejects(runReleaseGroupEnrichment({ ...runOptions(time, directory, fetchFn), outPath: path.join(directory, "cache", "x.json"), ids: [RG1] }), { code: "INVALID_ARGUMENTS" });
});

test("an interrupted run publishes nothing and the rerun resumes without refetching", async (context) => {
  const directory = tempDir(context);
  const time = clock();
  const controller = new AbortController();
  const all = ids(4);
  const routes = Object.fromEntries(all.map((id) => [id, releaseGroup(id)]));
  const { fetchFn, calls } = server(time, routes);
  await assert.rejects(runReleaseGroupEnrichment({
    ...runOptions(time, directory, fetchFn), ids: all, signal: controller.signal,
    onProgress: (progress) => { if (progress.completed === 2) controller.abort(); },
  }), (error) => error.code === "INTERRUPTED" && error.progress.completed === 2);
  assert.equal(fs.existsSync(path.join(directory, "evidence.json")), false);
  assert.equal(fs.existsSync(path.join(directory, "cache", LOCK_FILE)), false);
  calls.length = 0;
  const resumed = await runReleaseGroupEnrichment({ ...runOptions(time, directory, fetchFn), ids: all });
  assert.equal(resumed.progress.cached, 2);
  assert.equal(calls.length, 2);
  assert.equal(validateEvidence(resumed.evidence).counts.resolved, 4);
});

test("five consecutive transient failures trip the breaker; a success in between resets it", async (context) => {
  const directory = tempDir(context);
  const time = clock();
  const all = ids(7);
  const failing = server(time, Object.fromEntries(all.map((id) => [id, () => json({}, { status: 502 })])));
  await assert.rejects(runReleaseGroupEnrichment({ ...runOptions(time, directory, failing.fetchFn), ids: all }), (error) => error.code === "TRANSIENT_BREAKER" && error.progress.deferred === 4);
  assert.equal(fs.existsSync(path.join(directory, "evidence.json")), false);
  assert.equal(failing.calls.length, 15);

  const mixedRoutes = Object.fromEntries(all.map((id) => [id, () => json({}, { status: 502 })]));
  mixedRoutes[all[4]] = releaseGroup(all[4]);
  const mixed = server(time, mixedRoutes);
  const result = await runReleaseGroupEnrichment({ ...runOptions(time, directory, mixed.fetchFn), ids: all });
  assert.deepEqual(result.evidence.counts, { requested: 7, resolved: 1, unresolved: 0, deferred: 6 });
});

test("budget exhaustion keeps the cache and publishes nothing", async (context) => {
  const directory = tempDir(context);
  const time = clock();
  const all = ids(80);
  const { fetchFn } = server(time, Object.fromEntries(all.map((id) => [id, releaseGroup(id)])));
  await assert.rejects(runReleaseGroupEnrichment({ ...runOptions(time, directory, fetchFn), ids: all, budgetMinutes: 1 }), (error) => error.code === "BUDGET_EXHAUSTED" && error.progress.completed > 0 && error.progress.completed < 80);
  assert.equal(fs.existsSync(path.join(directory, "evidence.json")), false);
  const cached = fs.readdirSync(path.join(directory, "cache")).filter((name) => name.endsWith(".json"));
  assert.ok(cached.length > 40);
  await assert.rejects(runReleaseGroupEnrichment({ ...runOptions(time, directory, fetchFn), ids: all, budgetMinutes: 0 }), { code: "INVALID_ARGUMENTS" });
});

test("a long throttle persists a cooldown that later runs respect", async (context) => {
  const directory = tempDir(context);
  const time = clock();
  const throttled = server(time, { [RG1]: () => json({}, { status: 429, headers: { "Retry-After": "120" } }) });
  await assert.rejects(runReleaseGroupEnrichment({ ...runOptions(time, directory, throttled.fetchFn), ids: [RG1] }), { code: "RETRY_AFTER_EXCEEDED" });
  const cooldown = JSON.parse(fs.readFileSync(path.join(directory, "cache", COOLDOWN_FILE), "utf8"));
  assert.equal(cooldown.notBefore, new Date(NOW + 120_000).toISOString());
  const healthy = server(time, { [RG1]: releaseGroup(RG1) });
  await assert.rejects(runReleaseGroupEnrichment({ ...runOptions(time, directory, healthy.fetchFn), ids: [RG1] }), (error) => error.code === "COOLDOWN_ACTIVE" && error.notBefore === cooldown.notBefore);
  assert.equal(healthy.calls.length, 0);
  time.advance(120_000);
  const result = await runReleaseGroupEnrichment({ ...runOptions(time, directory, healthy.fetchFn), ids: [RG1] });
  assert.equal(result.evidence.counts.resolved, 1);
  assert.equal(fs.existsSync(path.join(directory, "cache", COOLDOWN_FILE)), false);
  fs.writeFileSync(path.join(directory, "cache", COOLDOWN_FILE), "{");
  await assert.rejects(runReleaseGroupEnrichment({ ...runOptions(time, directory, healthy.fetchFn), outPath: path.join(directory, "x.json"), ids: [RG1] }), { code: "COOLDOWN_UNREADABLE" });
});

test("a run refuses a locked cache without fetching", async (context) => {
  const directory = tempDir(context);
  const time = clock();
  fs.mkdirSync(path.join(directory, "cache"));
  fs.writeFileSync(path.join(directory, "cache", LOCK_FILE), JSON.stringify({ pid: 4242, hostname: os.hostname(), token: "t" }));
  const { fetchFn, calls } = server(time, { [RG1]: releaseGroup(RG1) });
  await assert.rejects(runReleaseGroupEnrichment({ ...runOptions(time, directory, fetchFn), ids: [RG1] }), { code: "CACHE_LOCKED" });
  assert.equal(calls.length, 0);
  assert.ok(fs.existsSync(path.join(directory, "cache", LOCK_FILE)));
});

test("CLI validates options and IDs before any request and maps outcomes to exit codes", async (context) => {
  const directory = tempDir(context);
  const base = ["--cache-dir", path.join(directory, "cache"), "--out", path.join(directory, "out.json")];
  assert.throws(() => cli.parseArgs(base), { code: "INVALID_ARGUMENTS" });
  assert.throws(() => cli.parseArgs([...base, "--ids-file", "a", "--from-plan", "b", "--plan-sha256", "a".repeat(64)]), { code: "INVALID_ARGUMENTS" });
  assert.throws(() => cli.parseArgs([...base, "--from-plan", "b"]), { code: "INVALID_ARGUMENTS" });
  assert.throws(() => cli.parseArgs([...base, "--ids-file", "a", "--plan-sha256", "a".repeat(64)]), { code: "INVALID_ARGUMENTS" });
  assert.throws(() => cli.parseArgs([...base, "--ids-file", "a", "--budget-minutes", "241"]), { code: "INVALID_ARGUMENTS" });
  assert.throws(() => cli.parseArgs([...base, "--ids-file", "a", "--ids-file", "b"]), { code: "INVALID_ARGUMENTS" });
  assert.throws(() => cli.parseArgs(["--ids-file", path.join(directory, "out.json"), ...base]), { code: "INVALID_ARGUMENTS" });
  assert.throws(() => cli.parseArgs([...base, "--ids-file", "a", "--surprise"]), { code: "INVALID_ARGUMENTS" });
  assert.equal(cli.parseArgs([...base, "--ids-file", "a"]).budgetMinutes, 30);

  const logs = [];
  const output = { log: (line) => logs.push(line), error: (line) => logs.push(line) };
  const fakeProcess = { on() {}, off() {}, exit() { throw new Error("exit"); } };
  const idsFile = path.join(directory, "ids.json");
  fs.writeFileSync(idsFile, JSON.stringify([RG1, "bad"]));
  let ran = 0;
  const run = async () => { ran += 1; throw new Error("should not run"); };
  assert.equal(await cli.main(["--ids-file", idsFile, ...base], { output, process: fakeProcess, runReleaseGroupEnrichment: run }), 1);
  assert.equal(ran, 0);

  fs.writeFileSync(idsFile, JSON.stringify([RG2, RG1]));
  const time = clock();
  const { fetchFn } = server(time, { [RG1]: releaseGroup(RG1) });
  const runOptionsForCli = { fetchFn, nowMs: time.nowMs, sleepFn: time.sleepFn, rateGate: time.gate, isProcessAlive: () => true };
  assert.equal(await cli.main(["--ids-file", idsFile, ...base], { output, process: fakeProcess, runOptions: runOptionsForCli }), 2);
  assert.equal(readEvidenceFile(path.join(directory, "out.json")).evidence.counts.unresolved, 1);
  fs.writeFileSync(idsFile, JSON.stringify([RG1]));
  assert.equal(await cli.main(["--ids-file", idsFile, "--cache-dir", path.join(directory, "cache"), "--out", path.join(directory, "all.json")], { output, process: fakeProcess, runOptions: runOptionsForCli }), 0);
  assert.equal(await cli.main(["--ids-file", idsFile, ...base], { output, process: fakeProcess, runOptions: runOptionsForCli }), 1, "existing evidence is never overwritten");
});

test("an absurd Retry-After stops the run with a clamped cooldown instead of retrying", async () => {
  const time = clock();
  let count = 0;
  const fetcher = createReleaseGroupCreditFetcher({ fetchFn: async () => { count += 1; return json({}, { status: 503, headers: { "Retry-After": "1e15" } }); }, nowMs: time.nowMs, sleepFn: time.sleepFn, rateGate: time.gate });
  await assert.rejects(fetcher.fetchOne(RG1), (error) => error.code === "RETRY_AFTER_EXCEEDED" && error.notBefore === new Date(8.64e15).toISOString());
  assert.equal(count, 1);
});

test("a short Retry-After still in force is persisted when the breaker stops the run", async (context) => {
  const directory = tempDir(context);
  const time = clock();
  const all = ids(5);
  const { fetchFn } = server(time, Object.fromEntries(all.map((id) => [id, () => json({}, { status: 503, headers: { "Retry-After": "25" } })])));
  await assert.rejects(runReleaseGroupEnrichment({ ...runOptions(time, directory, fetchFn), ids: all }), (error) => error.code === "TRANSIENT_BREAKER" && Boolean(error.notBefore));
  const cooldown = JSON.parse(fs.readFileSync(path.join(directory, "cache", COOLDOWN_FILE), "utf8"));
  assert.equal(cooldown.reason, "RETRY_AFTER_PENDING");
  assert.ok(Date.parse(cooldown.notBefore) > time.nowMs());
  const healthy = server(time, { [all[0]]: releaseGroup(all[0]) });
  await assert.rejects(runReleaseGroupEnrichment({ ...runOptions(time, directory, healthy.fetchFn), ids: [all[0]] }), { code: "COOLDOWN_ACTIVE" });
  assert.equal(healthy.calls.length, 0);
});

test("interrupting during a backoff wait stops promptly", async () => {
  const controller = new AbortController();
  const fetcher = createReleaseGroupCreditFetcher({
    fetchFn: async () => json({}, { status: 503, headers: { "Retry-After": "25" } }),
    rateGate: async () => {}, signal: controller.signal,
  });
  const started = Date.now();
  const pending = fetcher.fetchOne(RG1);
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, { code: "INTERRUPTED" });
  assert.ok(Date.now() - started < 2000);
});

test("the run normalizes IDs before any request and rejects invalid ones", async (context) => {
  const directory = tempDir(context);
  const time = clock();
  const { fetchFn, calls } = server(time, { [RG1]: releaseGroup(RG1) });
  const result = await runReleaseGroupEnrichment({ ...runOptions(time, directory, fetchFn), ids: [RG1.toUpperCase(), RG1] });
  assert.equal(result.evidence.counts.requested, 1);
  assert.equal(calls.length, 1);
  await assert.rejects(runReleaseGroupEnrichment({ ...runOptions(time, directory, fetchFn), outPath: path.join(directory, "x.json"), ids: ["../escape"] }), { code: "INVALID_ID_LIST" });
  assert.equal(calls.length, 1);
});

test("non-HTTP statuses and non-text credit fields are recorded per ID, not fatal", async () => {
  const time = clock();
  const odd = createReleaseGroupCreditFetcher({ fetchFn: async () => ({ status: 600, ok: false, headers: new Headers(), body: null }), nowMs: time.nowMs, sleepFn: time.sleepFn, rateGate: time.gate });
  const { row } = await odd.fetchOne(RG1);
  assert.equal(row.reason, "INVALID_RESPONSE");
  assert.equal(row.httpStatus, undefined);
  const at = new Date(NOW).toISOString();
  assert.equal(normalizeReleaseGroupPayload(releaseGroup(RG1, [{ name: {}, joinphrase: "", artist: { id: A1, name: "Alpha" } }]), RG1, at).reason, "INVALID_CREDITS");
  assert.equal(normalizeReleaseGroupPayload(releaseGroup(RG1, [{ name: "Alpha", joinphrase: 7, artist: { id: A1, name: "Alpha" } }]), RG1, at).reason, "INVALID_CREDITS");
  assert.equal(normalizeReleaseGroupPayload(releaseGroup(RG1, [null]), RG1, at).reason, "INVALID_CREDITS");
});

test("symlinked cache entries are ignored and a symlinked cache directory is refused", async (context) => {
  const directory = tempDir(context);
  const time = clock();
  const real = path.join(directory, "real");
  fs.mkdirSync(real);
  await writeCacheEntry(real, normalizeReleaseGroupPayload(releaseGroup(RG1), RG1, new Date(NOW).toISOString()));
  const cache = path.join(directory, "cache");
  fs.mkdirSync(cache);
  fs.symlinkSync(path.join(real, `${RG1}.json`), path.join(cache, `${RG1}.json`));
  assert.equal(await readCacheEntry(cache, RG1, () => NOW), null);
  const linkedDir = path.join(directory, "linked");
  fs.symlinkSync(real, linkedDir);
  const { fetchFn, calls } = server(time, { [RG1]: releaseGroup(RG1) });
  await assert.rejects(runReleaseGroupEnrichment({ ...runOptions(time, directory, fetchFn), cacheDir: linkedDir, ids: [RG1] }), { code: "INVALID_ARGUMENTS" });
  assert.equal(calls.length, 0);
});

test("CLI exits 2 for deferred-only evidence, 1 for a mismatched plan digest, and handles signals", async (context) => {
  const directory = tempDir(context);
  const handlers = {};
  let exited = null;
  const fakeProcess = {
    on(name, handler) { handlers[name] = handler; },
    off(name, handler) { if (handlers[name] === handler) delete handlers[name]; },
    exit(code) { exited = code; },
  };
  const output = { log() {}, error() {} };
  const idsFile = path.join(directory, "ids.json");
  fs.writeFileSync(idsFile, JSON.stringify([RG1]));
  const time = clock();
  const run = { fetchFn: async () => json({}, { status: 503 }), nowMs: time.nowMs, sleepFn: time.sleepFn, rateGate: time.gate, isProcessAlive: () => true };
  assert.equal(await cli.main(["--ids-file", idsFile, "--cache-dir", path.join(directory, "cache"), "--out", path.join(directory, "deferred.json")], { output, process: fakeProcess, runOptions: run }), 2);
  assert.deepEqual(Object.keys(handlers), [], "signal handlers are removed after the run");

  const { sealPlan } = require("../lib/artists/backfill");
  const plan = sealPlan({ kind: "rescened-artist-identity-backfill", planVersion: "1.0.0", target: { databaseName: "t" }, noSource: [{ releaseGroupMbid: RG1 }] });
  const planFile = path.join(directory, "plan.json");
  fs.writeFileSync(planFile, JSON.stringify(plan));
  assert.equal(await cli.main(["--from-plan", planFile, "--plan-sha256", "0".repeat(64), "--cache-dir", path.join(directory, "cache"), "--out", path.join(directory, "p.json")], { output, process: fakeProcess }), 1);

  let signalOf = null;
  const blocking = async (options) => {
    signalOf = options.signal;
    handlers.SIGINT();
    assert.equal(options.signal.aborted, true);
    assert.equal(exited, null);
    handlers.SIGTERM();
    assert.equal(exited, 130);
    throw Object.assign(new Error("The run was interrupted"), { code: "INTERRUPTED" });
  };
  assert.equal(await cli.main(["--ids-file", idsFile, "--cache-dir", path.join(directory, "cache"), "--out", path.join(directory, "sig.json")], { output, process: fakeProcess, runReleaseGroupEnrichment: blocking }), 1);
  assert.ok(signalOf);
});
