const test = require('node:test');
const assert = require('node:assert/strict');
const { rows, PRESETS, activityAlbum } = require('../benchmarks/fixtures.cjs');
const { cases, validateBody } = require('../benchmarks/workload.cjs');
const { assertLocalUri } = require('../benchmarks/server.cjs');
const { options, samplingGap } = require('../benchmarks/run.cjs');
const { digest, summarize, compare, median } = require('../benchmarks/report.cjs');
test('fixtures are deterministic, have valid IDs and exercise duplicate saves', () => {
  const a = [...rows('albums', 'smoke')];
  assert.equal(digest(a), digest([...rows('albums', 'smoke')]));
  assert.equal(new Set(a.map((r) => r.albumId)).size, 100);
  assert.ok(a.every((r) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/.test(r.albumId)));
  const saves = [...rows('memberships', 'smoke')];
  assert.equal(saves[0].userId, saves[1].userId);
  assert.equal(String(saves[0].albumCatalogId), String(saves[1].albumCatalogId));
  assert.notEqual(String(saves[0].boardId), String(saves[1].boardId));
  for (const preset of Object.values(PRESETS)) {
    const hot = Array.from({ length: 100 }, (_, i) => activityAlbum(i, preset.albums)).filter((i) => i < preset.albums / 5);
    assert.equal(hot.length, 80);
  }
});
test('runner cannot select a production database or an invalid workload', () => {
  assertLocalUri('mongodb://127.0.0.1:27017/rescened_bench_ab12?replicaSet=test');
  for (const uri of ['mongodb://localhost:27017/production', 'mongodb://127.0.0.1:27017/test', 'mongodb+srv://host/rescened_bench_a', 'mongodb://127.0.0.1:27017/rescened_bench_a/../../production']) {
    assert.throws(() => assertLocalUri(uri));
  }
  assert.throws(() => options(['--uri', 'mongodb://production']));
  assert.throws(() => options(['--duration', 'NaN']));
  assert.throws(() => options(['--rates', '10,5']));
  assert.throws(() => options(['--datasets', 'production']));
});
test('response validation rejects malformed, empty, and internal-ID-bearing data', () => {
  assert.equal(cases('main').detail.length, 40);
  assert.throws(() => validateBody('search', {}));
  assert.throws(() => validateBody('catalog', { results: [] }));
  assert.throws(() => validateBody('search', [{ _id: 'internal' }]));
  validateBody('search', []);
});
test('suspended sampling and backwards clock adjustments invalidate a measurement', () => {
  assert.equal(samplingGap(1000, 2000), false);
  assert.equal(samplingGap(1000, 25000), true);
  assert.equal(samplingGap(1000, 0), true);
});
function summary({ requests = 100, success = 100, p95 = 50, dropped = 0 } = {}) {
  return { metrics: {
    requests_search: { values: { count: requests } }, success_search: { values: { count: success } },
    latency_search: { values: { med: 20, 'p(95)': p95, 'p(99)': p95 * 2 } },
    dropped_iterations: { values: { count: dropped } },
  } };
}
test('qualification counts response failures, dropped load, missing endpoints and threshold exits', () => {
  assert.equal(summarize(summary(), ['search'], 10).successfulRps, 10);
  assert.equal(summarize(summary(), ['search'], 10).qualified, true);
  for (const input of [{ success: 90 }, { dropped: 1 }, { p95: 700 }, { requests: 0, success: 0 }]) {
    assert.equal(summarize(summary(input), ['search'], 10).qualified, false);
  }
  assert.equal(summarize(summary(), ['search', 'detail'], 10).qualified, false);
  assert.equal(summarize(summary(), ['search'], 10, 99).qualified, false);
});
test('comparison requires three compatible pairs and reports uncertainty conservatively', () => {
  const runs = [];
  for (const variant of ['baseline', 'current']) for (let i = 0; i < 3; i++) runs.push({
    phase: 'confirm', dataset: 'main', focus: 'search', rate: 5, duration: 300, variant,
    compatibility: 'same', exitCode: 0,
    metrics: summarize(summary({ p95: (variant === 'baseline' ? 100 : 50) + i }), ['search'], 300),
  });
  assert.equal(compare({ runs }).length, 1);
  assert.equal(compare({ runs })[0].repeatable, true);
  assert.equal(compare({ runs: runs.slice(1) }).length, 0);
  runs[0].compatibility = 'different';
  assert.throws(() => compare({ runs }), /Incompatible/);
  assert.equal(median([1, 4, 2, 3]), 2.5);
});
test('real production limiter emits 429 and Retry-After after exhausting a budget', async () => {
  const { createRateLimiter, createRateLimitMiddleware } = require('../routes/utils/rateLimit');
  const middleware = createRateLimitMiddleware(createRateLimiter({ points: 1, duration: 60, keyPrefix: 'benchmark-regression' }));
  const req = { ip: '127.0.0.9' };
  const res = { headers: {}, status(n) { this.statusCode = n; return this; }, set(k, v) { this.headers[k] = v; }, json(v) { this.body = v; } };
  let allowed = 0;
  await middleware(req, res, () => { allowed++; });
  await middleware(req, res, () => { allowed++; });
  assert.equal(allowed, 1);
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.code, 'RATE_LIMITED');
  assert.ok(Number(res.headers['Retry-After']) > 0);
});
