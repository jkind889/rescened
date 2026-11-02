const test = require("node:test");
const assert = require("node:assert/strict");
const effort = require("../lib/reviewObservations/effort");
const clerkPath = require.resolve("@clerk/express");
const routerPath = require.resolve("../routes/reviewEffort");
const originalClerk = require.cache[clerkPath];
require.cache[clerkPath] = { id: clerkPath, filename: clerkPath, loaded: true, exports: { getAuth: (req) => ({ userId: req.testUserId || "" }) } };
const router = require("../routes/reviewEffort");
const originals = { status: effort.status, setOptIn: effort.setOptIn, recordEffort: effort.recordEffort };
const saved = { moderators: process.env.MODERATOR_USER_IDS, timer: process.env.REVIEW_EFFORT_TIMER_ENABLED };
process.env.MODERATOR_USER_IDS = "effort-moderator";
test.after(() => {
  Object.assign(effort, originals);
  if (originalClerk) require.cache[clerkPath] = originalClerk; else delete require.cache[clerkPath];
  delete require.cache[routerPath];
  for (const [key, name] of [["moderators", "MODERATOR_USER_IDS"], ["timer", "REVIEW_EFFORT_TIMER_ENABLED"]]) {
    if (saved[key] === undefined) delete process.env[name]; else process.env[name] = saved[key];
  }
});
async function invoke(method, path, input = {}) {
  const route = router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]);
  const req = { params: {}, query: {}, body: {}, ip: "127.0.0.1", ...input };
  const res = { statusCode: 200, headers: {}, status(value) { this.statusCode = value; return this; }, set(name, value) { this.headers[name] = value; return this; }, setHeader(name, value) { this.headers[name] = value; return this; }, json(value) { this.body = value; return this; } };
  const reached = [];
  for (const layer of route.route.stack) { let next = false; await layer.handle(req, res, () => { next = true; }); reached.push(layer.name); if (!next) break; }
  return Object.assign(res, { reached });
}

test("every review-timer endpoint requires Clerk authentication and moderator membership", async () => {
  for (const layer of router.stack.filter((entry) => entry.route)) {
    const method = Object.keys(layer.route.methods)[0];
    assert.equal((await invoke(method, layer.route.path)).statusCode, 401);
    assert.equal((await invoke(method, layer.route.path, { testUserId: "outsider" })).statusCode, 403);
  }
});

test("a disabled timer reports itself off and refuses writes before the rate limit", async () => {
  delete process.env.REVIEW_EFFORT_TIMER_ENABLED;
  effort.status = originals.status;
  const status = await invoke("get", "/", { testUserId: "effort-moderator" });
  assert.deepEqual([status.statusCode, status.body], [200, { enabled: false, optedIn: false }]);
  effort.recordEffort = async () => { throw new Error("not reached"); };
  for (const [method, path] of [["put", "/opt-in"], ["post", "/"]]) {
    const result = await invoke(method, path, { testUserId: "effort-moderator", body: { optedIn: true } });
    assert.deepEqual([result.statusCode, result.body.code], [503, "REVIEW_EFFORT_TIMER_DISABLED"]);
    assert.equal(result.reached.at(-1), "timerEnabled", "stops before the rate limit");
  }
});

test("service errors keep their status and code; unexpected failures stay generic", async () => {
  process.env.REVIEW_EFFORT_TIMER_ENABLED = "true";
  effort.recordEffort = async () => { throw new effort.EffortError("REVIEW_EFFORT_OPT_IN_REQUIRED", 403); };
  const refused = await invoke("post", "/", { testUserId: "effort-moderator", body: {} });
  assert.deepEqual([refused.statusCode, refused.body.code], [403, "REVIEW_EFFORT_OPT_IN_REQUIRED"]);
  effort.recordEffort = async () => { throw new Error("database exploded with details"); };
  const failed = await invoke("post", "/", { testUserId: "effort-moderator", body: {} });
  assert.deepEqual([failed.statusCode, failed.body], [500, { error: "Review timer request failed", code: "REVIEW_EFFORT_REQUEST_FAILED" }]);
  effort.recordEffort = async () => ({ recorded: true, linked: false });
  const recorded = await invoke("post", "/", { testUserId: "effort-moderator", body: {} });
  assert.deepEqual([recorded.statusCode, recorded.body], [201, { recorded: true, linked: false }]);
});
