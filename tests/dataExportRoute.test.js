const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const express = require("express");
const mongoose = require("mongoose");

const AlbumCatalog = require("../models/AlbumCatalog");
const Listen = require("../models/Listen");
const Review = require("../models/Reviews");
const { MAX_EXPORT_ROWS } = require("../lib/dataExport/collect");

const clerkPath = require.resolve("@clerk/express");
const routePath = require.resolve("../routes/dataExport");
const ALBUM = { _id: new mongoose.Types.ObjectId(), albumId: "22222222-2222-4222-8222-222222222222", title: "Album", artistDisplayName: "Artist" };
let userCount = 0;

// Each test signs in as its own user, so the real per-user export budget
// starts fresh.
function nextUser() {
  userCount += 1;
  return `user_export_${process.pid}_${userCount}`;
}

function streamed(docs) {
  const chain = { sort: () => chain, lean: () => chain, cursor: () => (async function* stream() { yield* docs; })() };
  return chain;
}

async function serve(t, { enabled = true } = {}) {
  const previousFlag = process.env.DATA_EXPORT_ENABLED;
  if (enabled) process.env.DATA_EXPORT_ENABLED = "true";
  else delete process.env.DATA_EXPORT_ENABLED;
  const previousClerk = require.cache[clerkPath];
  require.cache[clerkPath] = {
    id: clerkPath, filename: clerkPath, loaded: true,
    exports: { getAuth: (req) => ({ userId: req.headers["x-test-user"] || null }) },
  };
  delete require.cache[routePath];
  const app = express();
  app.use("/profile/me/export", require(routePath));
  app.use("/profile", (req, res) => res.status(418).json({ reachedProfile: true }));
  const server = await new Promise((resolve) => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
  t.after(() => {
    server.close();
    if (previousFlag === undefined) delete process.env.DATA_EXPORT_ENABLED;
    else process.env.DATA_EXPORT_ENABLED = previousFlag;
    if (previousClerk) require.cache[clerkPath] = previousClerk;
    else delete require.cache[clerkPath];
    delete require.cache[routePath];
  });
  const base = `http://127.0.0.1:${server.address().port}/profile/me/export`;
  return async (file, userId = nextUser()) => {
    const response = await fetch(`${base}/${file}`, { headers: userId ? { "x-test-user": userId } : {} });
    // Raw bytes: response.text() would strip the byte order mark.
    const bytes = Buffer.from(await response.arrayBuffer());
    const text = bytes.toString("utf8");
    let body = text;
    try { body = JSON.parse(text); } catch { /* CSV */ }
    return { status: response.status, headers: response.headers, body, text };
  };
}

function mockData(t, { reviews = [], listens = [] } = {}) {
  const calls = { reviewFilters: [] };
  t.mock.method(Review, "find", (filter) => { calls.reviewFilters.push(filter); return streamed(reviews); });
  t.mock.method(Listen, "find", () => streamed(listens));
  t.mock.method(AlbumCatalog, "find", () => ({ lean: async () => [ALBUM] }));
  return calls;
}

test("the export is unavailable while DATA_EXPORT_ENABLED is off, before any read", async (t) => {
  const calls = mockData(t);
  const get = await serve(t, { enabled: false });
  for (const [file, user] of [["reviews.csv", "owner"], ["reviews.csv", ""], ["nope.txt", "owner"]]) {
    const response = await get(file, user);
    assert.equal(response.status, 503, file);
    assert.equal(response.body.code, "DATA_EXPORT_DISABLED");
  }
  assert.equal(calls.reviewFilters.length, 0);
});

test("unauthenticated requests get 401 UNAUTHORIZED", async (t) => {
  mockData(t);
  const get = await serve(t);
  for (const file of ["reviews.csv", "boards.json", "nope.txt"]) {
    const response = await get(file, "");
    assert.equal(response.status, 401, file);
    assert.equal(response.body.code, "UNAUTHORIZED");
  }
});

test("unknown datasets, formats, query parameters, and paths get 400 INVALID_EXPORT_REQUEST", async (t) => {
  const calls = mockData(t);
  const get = await serve(t);
  const userId = nextUser();
  for (const file of ["scrobbles.csv", "rankings.json", "reviews.xlsx", "Reviews.CSV", "reviews.csv.json", "reviews", "reviews.csv?limit=5", "reviews.json?userId=other"]) {
    const response = await get(file, userId);
    assert.equal(response.status, 400, file);
    assert.equal(response.body.code, "INVALID_EXPORT_REQUEST", file);
  }
  assert.equal(calls.reviewFilters.length, 0);
  // Invalid requests do not spend the export budget.
  assert.equal((await get("reviews.json", userId)).status, 200);
});

test("export routes never fall through to the profile router", async (t) => {
  mockData(t);
  const get = await serve(t);
  assert.notEqual((await get("reviews")).status, 418);
  const server = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  const exportMount = server.indexOf("app.use(\"/profile/me/export\"");
  const profileMount = server.indexOf("app.use(\"/profile\",");
  assert.ok(exportMount !== -1 && profileMount !== -1 && exportMount < profileMount, "the export router mounts before /profile");
});

test("an export reads only the signed-in user's data and is never cached", async (t) => {
  const review = { _id: new mongoose.Types.ObjectId(), reviewId: "11111111-1111-4111-8111-111111111111", albumCatalogId: ALBUM._id, rating: 5, reviewText: "=1+1", date: new Date("2026-09-01T00:00:00.000Z"), editedAt: null };
  const calls = mockData(t, { reviews: [review] });
  const get = await serve(t);
  const userId = nextUser();

  const csv = await get("reviews.csv", userId);
  assert.equal(csv.status, 200);
  assert.equal(csv.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(csv.headers.get("cache-control"), "no-store");
  assert.equal(csv.headers.get("content-disposition"), null, "the client names the file");
  assert.ok(csv.text.startsWith("﻿\"reviewId\""));
  assert.ok(csv.text.includes("\"'=1+1\""));
  assert.ok(!csv.text.includes(String(review._id)) && !csv.text.includes(String(ALBUM._id)));

  const json = await get("reviews.json", userId);
  assert.equal(json.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(json.body.schemaVersion, 1);
  assert.equal(json.body.items[0].reviewText, "=1+1");
  assert.deepEqual(calls.reviewFilters, [{ userId }, { userId }]);
});

test("listen exports include omitted next to items", async (t) => {
  const listen = { _id: new mongoose.Types.ObjectId(), listenId: "44444444-4444-4444-8444-444444444444", albumCatalogId: ALBUM._id, listenedOn: "2026-10-01", source: "manual", createdAt: new Date() };
  const gone = { ...listen, listenId: "55555555-5555-4555-8555-555555555555", albumCatalogId: new mongoose.Types.ObjectId() };
  mockData(t, { listens: [listen, gone] });
  const get = await serve(t);
  const response = await get("listens.json");
  assert.equal(response.status, 200);
  assert.equal(response.body.omitted, 1);
  assert.deepEqual(response.body.items.map((item) => item.listenId), [listen.listenId]);
});

test("an export above the row cap returns 413 EXPORT_TOO_LARGE", async (t) => {
  const review = { reviewId: "11111111-1111-4111-8111-111111111111", albumCatalogId: ALBUM._id, rating: 3, reviewText: "x", date: new Date() };
  mockData(t, { reviews: Array.from({ length: MAX_EXPORT_ROWS + 1 }, () => review) });
  const get = await serve(t);
  const response = await get("reviews.csv");
  assert.equal(response.status, 413);
  assert.equal(response.body.code, "EXPORT_TOO_LARGE");
});

test("a failed read returns 500 EXPORT_FAILED as JSON without internal details", async (t) => {
  mockData(t);
  t.mock.method(Review, "find", () => { throw new Error("connection to mongodb://secret lost"); });
  t.mock.method(console, "error", () => {});
  const get = await serve(t);
  const response = await get("reviews.json");
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: "Failed to build the export.", code: "EXPORT_FAILED" });
});

test("the eleventh export in an hour is rate limited with Retry-After", async (t) => {
  mockData(t);
  const get = await serve(t);
  const userId = nextUser();
  for (let index = 0; index < 10; index += 1) assert.equal((await get(index % 2 ? "reviews.csv" : "listens.json", userId)).status, 200);
  const limited = await get("boards.csv", userId);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, "RATE_LIMITED");
  assert.ok(limited.body.retryAfterSeconds > 3000);
  assert.equal(limited.headers.get("retry-after"), String(limited.body.retryAfterSeconds));
  assert.equal((await get("reviews.csv")).status, 200, "another user keeps their own budget");
});
