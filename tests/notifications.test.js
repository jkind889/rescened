const assert = require("node:assert/strict");
const test = require("node:test");

const {
  decodeCursor,
  encodeCursor,
  normalizePreferencesPatch,
  normalizeSelection,
  recordSuggestionStatus,
  serializePreferences,
  takeRecipients,
} = require("../routes/utils/notifications");

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function loadRouter(t, path) {
  const clerkPath = require.resolve("@clerk/express");
  const routePath = require.resolve(path);
  require.cache[clerkPath] = {
    id: clerkPath, filename: clerkPath, loaded: true,
    exports: { getAuth: () => ({ userId: "user_a" }), clerkClient: { users: { getUserList: async () => ({ data: [] }) } } },
  };
  delete require.cache[routePath];
  t.after(() => { delete require.cache[clerkPath]; delete require.cache[routePath]; });
  return require(routePath);
}

async function callLast(router, method, path, body) {
  const layer = router.stack.find((item) => item.route?.path === path && item.route.methods[method]);
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  await layer.route.stack.at(-1).handle({ userId: "user_a", body, params: {}, query: {} }, res);
  return { status: res.statusCode, body: res.body };
}

test("preferences default on, including for profiles written before preferences existed", () => {
  const all = { review_like: true, follow: true, followed_review: true, review_comment: true, comment_reply: true, suggestion_status: true };
  assert.deepEqual(serializePreferences(null), { preferences: all, locked: ["suggestion_status"] });
  assert.deepEqual(serializePreferences({ notificationPreferences: { follow: false } }).preferences, { ...all, follow: false });
});

test("preference updates accept known booleans and reject unknown, malformed, or locked changes", () => {
  assert.deepEqual(normalizePreferencesPatch({ follow: false, followed_review: true }), {
    "notificationPreferences.follow": false,
    "notificationPreferences.followed_review": true,
  });
  assert.deepEqual(normalizePreferencesPatch({ suggestion_status: true }), {}, "keeping a locked type on is a no-op");
  const code = (body) => { try { normalizePreferencesPatch(body); } catch (error) { return error.code; } return "ok"; };
  assert.equal(code({ suggestion_status: false }), "NOTIFICATION_PREFERENCE_LOCKED");
  assert.equal(code({ suggestion_status: "false" }), "INVALID_NOTIFICATION_PREFERENCES");
  assert.equal(code({ follow: "false" }), "INVALID_NOTIFICATION_PREFERENCES");
  assert.equal(code({ digest: true }), "INVALID_NOTIFICATION_PREFERENCES");
  assert.equal(code({ "notificationPreferences.follow": false }), "INVALID_NOTIFICATION_PREFERENCES");
  assert.equal(code({}), "INVALID_NOTIFICATION_PREFERENCES");
  assert.equal(code([]), "INVALID_NOTIFICATION_PREFERENCES");
});

test("read and clear selections take public IDs or all, never both or Mongo IDs", () => {
  assert.deepEqual(normalizeSelection({ all: true }), { all: true });
  assert.deepEqual(normalizeSelection({ notificationIds: [ID.toUpperCase(), ID] }), { notificationIds: [ID] });
  for (const body of [
    {}, null, { all: false }, { all: true, notificationIds: [ID] }, { notificationIds: [] },
    { notificationIds: ["507f1f77bcf86cd799439011"] }, { notificationIds: Array(101).fill(ID) }, { readAt: null },
  ]) {
    assert.throws(() => normalizeSelection(body), (error) => error.code === "INVALID_NOTIFICATION_REQUEST", JSON.stringify(body));
  }
});

test("cursors round-trip a timestamp and public ID and reject anything else", () => {
  const row = { createdAt: new Date("2026-10-10T00:00:00.000Z"), notificationId: ID };
  assert.deepEqual(decodeCursor(encodeCursor(row)), row);
  assert.equal(decodeCursor(undefined), null);
  const objectIdCursor = Buffer.from(JSON.stringify({ createdAt: row.createdAt, notificationId: "507f1f77bcf86cd799439011" })).toString("base64url");
  for (const value of ["not-a-cursor", objectIdCursor, ["array"]]) {
    assert.throws(() => decodeCursor(value), (error) => error.code === "INVALID_NOTIFICATION_CURSOR");
  }
});

test("fan-out recipients keep follow order, skip ineligible and muted followers, and count past the cap", () => {
  const state = { recipients: [], skipped: 0 };
  takeRecipients(state, ["a", "b", "c", "d"], new Set(["a", "c", "d"]), new Set(["c"]), 1);
  assert.deepEqual(state, { recipients: ["a"], skipped: 1 });
  takeRecipients(state, ["e"], new Set(["e"]), new Set(), 1);
  assert.deepEqual(state, { recipients: ["a"], skipped: 2 }, "later batches keep counting skips");
});

test("suggestion notifications refuse to write outside a transaction and skip self-moderation", async () => {
  const submission = { _id: "internal", submittedByUserId: "contributor", currentRevision: 1 };
  await assert.rejects(recordSuggestionStatus({ submission, status: "approved", actorUserId: "moderator" }), /transaction session/);
  assert.equal(await recordSuggestionStatus({ submission, status: "approved", actorUserId: "contributor", session: {} }), false);
});

test("preference and read-state routes reject bad bodies before touching the database", async (t) => {
  const profile = loadRouter(t, "../routes/profile");
  const locked = await callLast(profile, "patch", "/me/notification-preferences", { suggestion_status: false });
  assert.deepEqual(locked, { status: 400, body: { error: "suggestion_status notifications cannot be turned off", code: "NOTIFICATION_PREFERENCE_LOCKED" } });
  const notifications = loadRouter(t, "../routes/notifications");
  for (const path of ["/read", "/clear"]) {
    const result = await callLast(notifications, "post", path, { notificationIds: ["507f1f77bcf86cd799439011"] });
    assert.equal(result.status, 400, path);
    assert.equal(result.body.code, "INVALID_NOTIFICATION_REQUEST", path);
  }
});
