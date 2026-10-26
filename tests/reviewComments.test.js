const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

const ReviewComment = require("../models/ReviewComment");
const {
  decodeCursor,
  encodeCursor,
  normalizeBody,
  parseCreateBody,
  parseEditBody,
  parseModerationBody,
  parseReportBody,
} = require("../lib/reviewComments/common");
const { serializeComment } = require("../lib/reviewComments/read");

const clerkPath = require.resolve("@clerk/express");
const rateLimitPath = require.resolve("../routes/utils/rateLimit");
const commentRoutePath = require.resolve("../routes/reviewComments");
const moderationRoutePath = require.resolve("../routes/commentModeration");
const COMMENT_ID = "33333333-3333-4333-8333-333333333333";
const PARENT_ID = "44444444-4444-4444-8444-444444444444";
const REVIEW_ID = "11111111-1111-4111-8111-111111111111";
const KEY = "55555555-5555-4555-8555-555555555555";

function code(run) {
  try { run(); } catch (error) { return error.code; }
  return "ok";
}

test("comment bodies are plain text with normalized whitespace and collapsed blank lines", () => {
  assert.equal(normalizeBody("  hello \t  world  "), "hello world");
  assert.equal(normalizeBody("one\r\n\r\n\r\n\r\ntwo\n   \n\nthree"), "one\n\ntwo\n\nthree");
  assert.equal(normalizeBody("a\u200Bb\u202Ec\u0000d"), "abcd");
  const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
  assert.equal(normalizeBody(`${family} \u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645`), `${family} \u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645`, "joiners survive");
  assert.equal(normalizeBody("<b>not html</b>"), "<b>not html</b>", "markup is kept as literal text");
  assert.equal(normalizeBody("x".repeat(500)).length, 500);
  assert.equal(code(() => normalizeBody("x".repeat(501))), "INVALID_COMMENT_REQUEST");
  assert.equal(code(() => normalizeBody(" \n\u200B\t ")), "INVALID_COMMENT_REQUEST");
  assert.equal(code(() => normalizeBody(42)), "INVALID_COMMENT_REQUEST");
});

test("comment requests reject unknown and client-owned fields", () => {
  assert.deepEqual(parseCreateBody({ body: "hi" }), { body: "hi", parentCommentId: null });
  assert.deepEqual(parseCreateBody({ body: "hi", parentCommentId: PARENT_ID.toUpperCase() }), { body: "hi", parentCommentId: PARENT_ID });
  for (const field of ["commentId", "userId", "status", "replyToUserId", "reviewId", "_id", "createdAt"]) {
    assert.equal(code(() => parseCreateBody({ body: "hi", [field]: "x" })), "INVALID_COMMENT_REQUEST", field);
    assert.equal(code(() => parseEditBody({ body: "hi", [field]: "x" })), "INVALID_COMMENT_REQUEST", field);
  }
  assert.equal(code(() => parseCreateBody({ body: "hi", parentCommentId: new mongoose.Types.ObjectId().toString() })), "INVALID_COMMENT_ID");
  assert.equal(code(() => parseCreateBody(["body"])), "INVALID_COMMENT_REQUEST");

  assert.deepEqual(parseReportBody({ reason: "spam" }), { reason: "spam", note: "" });
  assert.deepEqual(parseReportBody({ reason: "other", note: "  see   thread " }), { reason: "other", note: "see thread" });
  assert.equal(code(() => parseReportBody({ reason: "rude" })), "INVALID_COMMENT_REQUEST");
  assert.equal(code(() => parseReportBody({ reason: "spam", note: "x".repeat(301) })), "INVALID_COMMENT_REQUEST");
  assert.equal(code(() => parseReportBody({ reason: "spam", status: "dismissed" })), "INVALID_COMMENT_REQUEST");

  assert.deepEqual(parseModerationBody({ reason: " Spam link " }), { reason: "Spam link" });
  assert.equal(code(() => parseModerationBody({})), "INVALID_COMMENT_REQUEST");
  assert.equal(code(() => parseModerationBody({ reason: "ok", action: "restore" })), "INVALID_COMMENT_REQUEST");
});

test("cursors encode public comment IDs only and reject anything else", () => {
  const internal = new mongoose.Types.ObjectId();
  const cursor = encodeCursor({ _id: internal, commentId: COMMENT_ID, createdAt: new Date("2026-10-01T00:00:00Z") });
  assert.equal(Buffer.from(cursor, "base64url").toString("utf8").includes(String(internal)), false);
  assert.deepEqual(decodeCursor(cursor), { createdAt: new Date("2026-10-01T00:00:00Z"), commentId: COMMENT_ID });
  assert.equal(decodeCursor(""), null);
  const forged = Buffer.from(JSON.stringify({ createdAt: "2026-10-01T00:00:00Z", commentId: String(internal) })).toString("base64url");
  for (const value of [forged, "not-a-cursor", ["array"]]) assert.equal(code(() => decodeCursor(value)), "INVALID_COMMENT_CURSOR");
});

test("tombstones serialize without body, author, or Mongo IDs", () => {
  const internal = new mongoose.Types.ObjectId();
  const row = {
    _id: internal,
    commentId: COMMENT_ID,
    reviewId: new mongoose.Types.ObjectId(),
    parentCommentId: null,
    userId: "user_author",
    body: "kept for audit",
    status: "removed_by_moderator",
    createdAt: new Date("2026-10-01T00:00:00Z"),
  };
  const serialized = serializeComment(row, { authors: new Map(), thread: { replyCount: 1, replies: [], repliesCursor: null } });
  assert.deepEqual(serialized, {
    commentId: COMMENT_ID,
    status: "removed_by_moderator",
    createdAt: row.createdAt,
    replyCount: 1,
    replies: [],
    repliesCursor: null,
  });
  assert.equal(JSON.stringify(serialized).includes(String(internal)), false);

  const reply = serializeComment(
    { ...row, status: "visible", body: "hi", parentCommentId: internal, replyToUserId: "user_other", editedAt: null },
    { authors: new Map([["user_author", { userId: "user_author", username: "author", imageUrl: "" }]]), parentPublicId: PARENT_ID },
  );
  assert.equal(reply.parentCommentId, PARENT_ID);
  assert.deepEqual(reply.author, { userId: "user_author", username: "author", imageUrl: "" });
  assert.deepEqual(reply.replyTo, { userId: "user_other", username: "rescened user" });
  assert.equal(JSON.stringify(reply).includes(String(internal)), false);
});

test("the comment model requires a body only while visible", () => {
  const base = { reviewId: new mongoose.Types.ObjectId(), userId: "user_a" };
  assert.ok(new ReviewComment({ ...base }).validateSync()?.errors.body);
  assert.equal(new ReviewComment({ ...base, status: "deleted_by_author" }).validateSync(), undefined);
  assert.ok(new ReviewComment({ ...base, body: "x".repeat(501) }).validateSync()?.errors.body);
});

// Route wiring: authentication, the feature flag, and the rate limiter run in
// that order before any handler can persist anything.

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    set(name, value) { this.headers[name] = value; return this; },
    status(statusCode) { this.statusCode = statusCode; return this; },
    json(body) { this.body = body; return this; },
  };
}

function loadRoutes(t, { userId = "user_viewer", moderators = "" } = {}) {
  const calls = [];
  const blocker = (name) => (req, res, next) => {
    calls.push(name);
    if (req.blockRateLimit) {
      res.set("Retry-After", "42");
      return res.status(429).json({ error: `Rate limited by ${name}`, code: "RATE_LIMITED", retryAfterSeconds: 42 });
    }
    return next();
  };
  const previous = { clerk: require.cache[clerkPath], rateLimit: require.cache[rateLimitPath] };
  require.cache[clerkPath] = {
    id: clerkPath, filename: clerkPath, loaded: true,
    exports: { getAuth: () => ({ userId }), clerkClient: { users: { getUserList: async () => ({ data: [] }) } } },
  };
  require.cache[rateLimitPath] = {
    id: rateLimitPath, filename: rateLimitPath, loaded: true,
    exports: {
      commentCreateRateLimit: blocker("commentCreate"),
      commentMutationRateLimit: blocker("commentMutation"),
      commentReportRateLimit: blocker("commentReport"),
      moderationMutationRateLimit: blocker("moderationMutation"),
    },
  };
  const previousEnv = { MODERATOR_USER_IDS: process.env.MODERATOR_USER_IDS };
  process.env.MODERATOR_USER_IDS = moderators;
  [commentRoutePath, moderationRoutePath].forEach((path) => delete require.cache[path]);
  const routers = { comments: require(commentRoutePath), moderation: require(moderationRoutePath) };
  t.after(() => {
    [commentRoutePath, moderationRoutePath].forEach((path) => delete require.cache[path]);
    if (previous.clerk) require.cache[clerkPath] = previous.clerk; else delete require.cache[clerkPath];
    if (previous.rateLimit) require.cache[rateLimitPath] = previous.rateLimit; else delete require.cache[rateLimitPath];
    if (previousEnv.MODERATOR_USER_IDS === undefined) delete process.env.MODERATOR_USER_IDS;
    else process.env.MODERATOR_USER_IDS = previousEnv.MODERATOR_USER_IDS;
  });
  return { calls, routers };
}

async function call(router, method, path, req = {}) {
  const layer = router.stack.find((item) => item.route?.path === path && item.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} should be registered`);
  const res = response();
  const request = { params: {}, query: {}, body: {}, get: () => KEY, ...req };
  for (const { handle } of layer.route.stack) {
    let advanced = false;
    await handle(request, res, () => { advanced = true; });
    if (!advanced) break;
  }
  return res;
}

function withFlag(t, name, value) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
}

const MUTATIONS = [
  ["post", "/review/:reviewId/comments", "commentCreate", { params: { reviewId: REVIEW_ID }, body: { body: "hi" } }],
  ["patch", "/comments/:commentId", "commentMutation", { params: { commentId: COMMENT_ID }, body: { body: "hi" } }],
  ["delete", "/comments/:commentId", "commentMutation", { params: { commentId: COMMENT_ID } }],
  ["post", "/comments/:commentId/report", "commentReport", { params: { commentId: COMMENT_ID }, body: { reason: "spam" } }],
];

test("comment mutations require sign-in, then the flag, then their rate limit", async (t) => {
  withFlag(t, "REVIEW_COMMENTS_ENABLED", undefined);
  const signedOut = loadRoutes(t, { userId: null });
  for (const [method, path, , req] of MUTATIONS) {
    const res = await call(signedOut.routers.comments, method, path, req);
    assert.equal(res.statusCode, 401, `${method} ${path}`);
  }
  assert.deepEqual(signedOut.calls, []);

  const disabled = loadRoutes(t);
  for (const [method, path, , req] of MUTATIONS) {
    const res = await call(disabled.routers.comments, method, path, req);
    assert.equal(res.statusCode, 503, `${method} ${path}`);
    assert.equal(res.body.code, "COMMENTS_DISABLED");
  }
  assert.deepEqual(disabled.calls, [], "a disabled flag refuses before the rate limit is spent");

  withFlag(t, "REVIEW_COMMENTS_ENABLED", "true");
  const limited = loadRoutes(t);
  for (const [method, path, limiter, req] of MUTATIONS) {
    const res = await call(limited.routers.comments, method, path, { ...req, blockRateLimit: true });
    assert.equal(res.statusCode, 429, `${method} ${path}`);
    assert.equal(res.headers["Retry-After"], "42");
    assert.equal(limited.calls.at(-1), limiter);
  }
});

test("comment reads stay available with the flag off", async (t) => {
  withFlag(t, "REVIEW_COMMENTS_ENABLED", "false");
  const { routers } = loadRoutes(t);
  const layer = routers.comments.stack.find((item) => item.route?.path === "/review/:reviewId/comments" && item.route.methods.get);
  assert.equal(layer.route.stack.length, 1, "the thread read has no auth, flag, or limiter middleware");
  const replies = routers.comments.stack.find((item) => item.route?.path === "/review/:reviewId/comments/:commentId/replies" && item.route.methods.get);
  assert.equal(replies.route.stack.length, 1);
  const res = await call(routers.comments, "get", "/review/:reviewId/comments", { params: { reviewId: "not-a-uuid" } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, "INVALID_REVIEW_ID");
});

test("comment requests validate public IDs and bodies before touching the database", async (t) => {
  withFlag(t, "REVIEW_COMMENTS_ENABLED", "true");
  const { routers } = loadRoutes(t);
  const objectId = new mongoose.Types.ObjectId().toString();
  const cases = [
    ["post", "/review/:reviewId/comments", { params: { reviewId: objectId }, body: { body: "hi" } }, "INVALID_REVIEW_ID"],
    ["post", "/review/:reviewId/comments", { params: { reviewId: REVIEW_ID }, body: { body: "hi", userId: "someone" } }, "INVALID_COMMENT_REQUEST"],
    ["post", "/review/:reviewId/comments", { params: { reviewId: REVIEW_ID }, body: { body: "hi" }, get: () => "" }, "INVALID_IDEMPOTENCY_KEY"],
    ["patch", "/comments/:commentId", { params: { commentId: objectId }, body: { body: "hi" } }, "INVALID_COMMENT_ID"],
    ["patch", "/comments/:commentId", { params: { commentId: COMMENT_ID }, body: { body: "hi", status: "visible" } }, "INVALID_COMMENT_REQUEST"],
    ["delete", "/comments/:commentId", { params: { commentId: objectId } }, "INVALID_COMMENT_ID"],
    ["post", "/comments/:commentId/report", { params: { commentId: COMMENT_ID }, body: { reason: "boring" } }, "INVALID_COMMENT_REQUEST"],
  ];
  for (const [method, path, req, expected] of cases) {
    const res = await call(routers.comments, method, path, req);
    assert.equal(res.statusCode, 400, `${method} ${path}`);
    assert.equal(res.body.code, expected, `${method} ${path}`);
  }
});

test("moderator comment commands require a moderator, the moderation flag, and the moderation limit", async (t) => {
  withFlag(t, "COMMUNITY_MODERATION_ENABLED", "false");
  const member = loadRoutes(t, { userId: "user_member", moderators: "user_mod" });
  for (const path of ["/", "/:commentId/remove", "/:commentId/dismiss"]) {
    const method = path === "/" ? "get" : "post";
    const res = await call(member.routers.moderation, method, path, { params: { commentId: COMMENT_ID } });
    assert.equal(res.statusCode, 403, path);
    assert.equal(res.body.code, "MODERATOR_REQUIRED");
  }

  const moderator = loadRoutes(t, { userId: "user_mod", moderators: "user_mod" });
  for (const path of ["/:commentId/remove", "/:commentId/dismiss"]) {
    const res = await call(moderator.routers.moderation, "post", path, { params: { commentId: COMMENT_ID }, body: { reason: "spam" } });
    assert.equal(res.statusCode, 503, path);
    assert.equal(res.body.code, "MODERATION_DISABLED");
  }
  assert.deepEqual(moderator.calls, []);

  withFlag(t, "COMMUNITY_MODERATION_ENABLED", "true");
  const enabled = loadRoutes(t, { userId: "user_mod", moderators: "user_mod" });
  const missingReason = await call(enabled.routers.moderation, "post", "/:commentId/remove", { params: { commentId: COMMENT_ID }, body: {} });
  assert.equal(missingReason.statusCode, 400);
  assert.deepEqual(enabled.calls, ["moderationMutation"]);
  const limited = await call(enabled.routers.moderation, "post", "/:commentId/dismiss", { params: { commentId: COMMENT_ID }, body: { reason: "ok" }, blockRateLimit: true });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers["Retry-After"], "42");
});
