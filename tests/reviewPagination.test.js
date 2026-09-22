const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const {
  DEFAULT_REVIEW_PAGE_SIZE,
  MAX_REVIEW_PAGE_SIZE,
  ReviewFeedValidationError,
  buildPopularReviewPagePipeline,
  decodeCursor,
  encodeCursor,
  nextCursorFor,
  parseReviewFeedQuery,
  recentCursorFilter,
  readPopularReviewPage,
} = require("../routes/utils/reviewPagination");

test("review feeds validate sorts, clamp page size, and keep cursor data opaque", () => {
  const id = new mongoose.Types.ObjectId();
  const scope = "album:4b2a1e56-24d1-49df-9550-c17054ca9e91";
  const cursor = nextCursorFor({ _id: id, date: new Date("2026-09-03T00:00:00Z"), likeCount: 7 }, {
    sort: "popular",
    scope,
    snapshotTime: { t: 1788480000, i: 7 },
  });
  assert.equal(cursor.includes(String(id)), false);
  const parsed = parseReviewFeedQuery({ sort: "popular", limit: "999", cursor }, scope);
  assert.equal(parsed.limit, MAX_REVIEW_PAGE_SIZE);
  assert.equal(String(parsed.cursor.id), String(id));
  assert.equal(parsed.cursor.likeCount, 7);
  assert.deepEqual(parsed.snapshotTime, { t: 1788480000, i: 7 });
  assert.equal(parseReviewFeedQuery({}, scope).limit, DEFAULT_REVIEW_PAGE_SIZE);
  assert.throws(() => parseReviewFeedQuery({ sort: "rating" }, scope), (error) => error instanceof ReviewFeedValidationError && error.code === "INVALID_REVIEW_SORT");
  assert.throws(() => decodeCursor("not-a-cursor", { sort: "popular", scope }), (error) => error.code === "INVALID_REVIEW_CURSOR");
  assert.throws(() => parseReviewFeedQuery({ sort: "popular", cursor }, "album:other"), (error) => error.code === "INVALID_REVIEW_CURSOR");
});

test("popular cursors reject old timestamp-only cursors, malformed snapshots, and tampering", () => {
  const payload = {
    sort: "popular", scope: "user:owner", id: String(new mongoose.Types.ObjectId()),
    date: "2026-09-03T00:00:00Z", likeCount: 2,
  };
  for (const extra of [
    { v: 1, asOf: "2026-09-04T00:00:00Z" },
    { snapshotTime: { t: 0, i: 1 } },
    { snapshotTime: { t: 1788480000, i: -1 } },
    { snapshotTime: { t: 1788480000, i: 0x100000000 } },
    { snapshotTime: { t: 1788480000, i: 1 }, likeCount: -1 },
  ]) {
    const cursor = encodeCursor({ ...payload, ...extra });
    assert.throws(() => parseReviewFeedQuery({ sort: "popular", cursor }, payload.scope), { code: "INVALID_REVIEW_CURSOR" });
  }
  const cursor = encodeCursor({ ...payload, snapshotTime: { t: 1788480000, i: 1 } });
  const parts = cursor.split(".");
  parts[2] = `${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
  assert.throws(() => parseReviewFeedQuery({ sort: "popular", cursor: parts.join(".") }, payload.scope), { code: "INVALID_REVIEW_CURSOR" });
  assert.throws(() => parseReviewFeedQuery({ sort: "popular", cursor }, "album:other"), { code: "INVALID_REVIEW_CURSOR" });
  assert.throws(() => parseReviewFeedQuery({ sort: "popular", cursor: "x".repeat(4097) }, payload.scope), { code: "INVALID_REVIEW_CURSOR" });
});

test("recent version-one cursors remain compatible", () => {
  const payload = { v: 1, sort: "recent", scope: "user:owner", id: String(new mongoose.Types.ObjectId()), date: "2026-09-03T00:00:00Z" };
  const cursor = encodeCursor(payload);
  assert.equal(String(parseReviewFeedQuery({ cursor }, payload.scope).cursor.id), payload.id);
});

test("expired snapshots require restarting the feed instead of silently reranking", async () => {
  for (const error of [{ code: 286 }, { codeName: "SnapshotTooOld" }, { code: 246 }]) {
    let attempts = 0;
    const db = { async command() { attempts += 1; throw error; } };
    await assert.rejects(readPopularReviewPage({}, { cursor: {}, snapshotTime: { t: 1788480000, i: 1 }, limit: 2 }, db), {
      status: 400, code: "INVALID_REVIEW_CURSOR",
    });
    assert.equal(attempts, 1);
  }
});

test("unavailable snapshot reads return a stable 503 without a live-ranking fallback", async () => {
  for (const code of [20, 50, 72, 134, 246]) {
    const db = { async command() { throw { code }; } };
    await assert.rejects(readPopularReviewPage({}, { cursor: null, snapshotTime: null, limit: 2 }, db), {
      status: 503, code: "POPULAR_REVIEWS_UNAVAILABLE",
    });
  }
});

test("recent and popular pages use deterministic, bounded continuation filters", () => {
  const id = new mongoose.Types.ObjectId();
  const date = new Date("2026-09-03T00:00:00Z");
  assert.deepEqual(recentCursorFilter({ id, date }), {
    $or: [{ date: { $lt: date } }, { date, _id: { $lt: id } }],
  });

  const pipeline = buildPopularReviewPagePipeline({ userId: "user" }, {
    cursor: { id, date, likeCount: 4 },
    limit: 20,
  });
  assert.deepEqual(pipeline.find((stage) => stage.$sort), { $sort: { likeCount: -1, date: -1, _id: -1 } });
  assert.deepEqual(pipeline.find((stage) => stage.$limit), { $limit: 21 });
  assert.deepEqual(pipeline.find((stage) => stage.$match?.$or)?.$match, {
    $or: [
      { likeCount: { $lt: 4 } },
      { likeCount: 4, date: { $lt: date } },
      { likeCount: 4, date, _id: { $lt: id } },
    ],
  });
});
