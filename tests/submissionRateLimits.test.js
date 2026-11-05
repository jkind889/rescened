const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");
const {
  RATE_LIMITS,
  correctionCreateRateLimit,
  submissionCreateRateLimit,
} = require("../routes/utils/rateLimit");
const router = require("../routes/suggestions");

function response() {
  return {
    headers: {},
    statusCode: 200,
    set(name, value) { this.headers[name] = value; return this; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

async function attempt(middleware, userId) {
  const res = response();
  let passed = false;
  await middleware({ userId }, res, () => { passed = true; });
  return { res, passed };
}

function assertBlocked(result, seconds, message) {
  assert.equal(result.passed, false);
  assert.equal(result.res.statusCode, 429);
  assert.equal(result.res.body.code, "RATE_LIMITED");
  assert.equal(result.res.body.error, message);
  assert.ok(result.res.body.retryAfterSeconds > 0);
  assert.ok(result.res.body.retryAfterSeconds <= seconds);
  assert.equal(result.res.headers["Retry-After"], String(result.res.body.retryAfterSeconds));
}

test("creation routes use distinct limiters after authentication and feature checks", () => {
  for (const [path, middleware] of [["/", submissionCreateRateLimit], ["/corrections", correctionCreateRateLimit]]) {
    const route = router.stack.find((layer) => layer.route?.path === path && layer.route.methods.post).route;
    assert.equal(route.stack[0].handle.name, "auth");
    assert.equal(route.stack[1].handle.name, "submissionsEnabled");
    assert.equal(route.stack[2].handle, middleware);
  }
  assert.equal(RATE_LIMITS.submissionCreate.points, 10);
  assert.equal(RATE_LIMITS.submissionCreate.duration, 600);
  assert.equal(RATE_LIMITS.correctionCreate.points, 6);
  assert.equal(RATE_LIMITS.correctionCreate.duration, 300);
  assert.notEqual(RATE_LIMITS.submissionCreate.keyPrefix, RATE_LIMITS.correctionCreate.keyPrefix);
  assert.equal(RATE_LIMITS.genreSuggestion.points, 20);
  assert.equal(RATE_LIMITS.genreSuggestion.duration, 3600);
  assert.equal(RATE_LIMITS.globalApi.points, 300);
  assert.equal(RATE_LIMITS.globalApi.duration, 300);
});

test("exhausting either creation bucket preserves the full other budget for the same user", async () => {
  for (const order of [
    [[correctionCreateRateLimit, RATE_LIMITS.correctionCreate], [submissionCreateRateLimit, RATE_LIMITS.submissionCreate]],
    [[submissionCreateRateLimit, RATE_LIMITS.submissionCreate], [correctionCreateRateLimit, RATE_LIMITS.correctionCreate]],
  ]) {
    const userId = crypto.randomUUID();
    for (const [middleware, config] of order) {
      for (let i = 0; i < config.points; i += 1) {
        assert.equal((await attempt(middleware, userId)).passed, true);
      }
      assertBlocked(await attempt(middleware, userId), config.duration, config.message);
      assert.equal((await attempt(middleware, crypto.randomUUID())).passed, true, "another user retains their budget");
    }
  }
});
