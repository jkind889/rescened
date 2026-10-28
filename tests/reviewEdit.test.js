const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

const AlbumCatalog = require("../models/AlbumCatalog");
const Like = require("../models/Like");
const Review = require("../models/Reviews");
const ReviewComment = require("../models/ReviewComment");

const clerkPath = require.resolve("@clerk/express");
const reviewRoutePath = require.resolve("../routes/reviews");
const REVIEW_ID = "11111111-1111-4111-8111-111111111111";
const EDITED_AT = new Date("2026-10-27T12:00:00.000Z");

function loadRouter(t) {
  const previousClerk = require.cache[clerkPath];
  require.cache[clerkPath] = {
    id: clerkPath,
    filename: clerkPath,
    loaded: true,
    exports: {
      getAuth: () => ({ userId: "owner" }),
      clerkClient: { users: { async getUserList() { return { data: [] }; } } },
    },
  };
  const previousRoute = require.cache[reviewRoutePath];
  delete require.cache[reviewRoutePath];
  const router = require(reviewRoutePath);
  t.after(() => {
    if (previousClerk) require.cache[clerkPath] = previousClerk;
    else delete require.cache[clerkPath];
    if (previousRoute) require.cache[reviewRoutePath] = previousRoute;
    else delete require.cache[reviewRoutePath];
  });
  return router;
}

async function patch(router, body) {
  const layer = router.stack.find((item) => item.route?.path === "/review/user/:id" && item.route.methods.patch);
  const res = {
    statusCode: 200,
    body: null,
    status(statusCode) { this.statusCode = statusCode; return this; },
    json(value) { this.body = value; return this; },
  };
  await layer.route.stack.at(-1).handle({ userId: "owner", params: { id: REVIEW_ID }, body }, res);
  return { status: res.statusCode, body: res.body };
}

function setup(t) {
  const album = { _id: new mongoose.Types.ObjectId(), albumId: "22222222-2222-4222-8222-222222222222", title: "Album", artistDisplayName: "Artist", artistCredits: [], tracks: [], catalogSource: "manual" };
  const stored = { _id: new mongoose.Types.ObjectId(), reviewId: REVIEW_ID, userId: "owner", albumCatalogId: album._id, rating: 3, reviewText: "Original", date: new Date("2026-09-01T00:00:00.000Z"), editedAt: null };
  const calls = { update: [], find: [] };
  t.mock.method(AlbumCatalog, "find", async () => [album]);
  t.mock.method(Like, "find", async () => []);
  t.mock.method(Like, "aggregate", async () => []);
  t.mock.method(ReviewComment, "aggregate", async () => []);
  return { stored, calls };
}

test("an edit that changes the review marks it edited and claims its interaction revision", async (t) => {
  const { stored, calls } = setup(t);
  t.mock.method(Review, "findOneAndUpdate", async (filter, update, options) => {
    calls.update.push({ filter, update, options });
    return { ...stored, ...update.$set, editedAt: EDITED_AT };
  });
  const router = loadRouter(t);

  const response = await patch(router, { rating: 4.5, reviewText: "  Changed my mind  " });

  assert.equal(response.status, 200);
  const [{ filter, update, options }] = calls.update;
  assert.deepEqual(filter, { reviewId: REVIEW_ID, userId: "owner", $or: [{ rating: { $ne: 4.5 } }, { reviewText: { $ne: "Changed my mind" } }] });
  assert.equal(update.$set.rating, 4.5);
  assert.equal(update.$set.reviewText, "Changed my mind");
  assert.ok(update.$set.editedAt instanceof Date);
  assert.deepEqual(update.$inc, { interactionRevision: 1 });
  assert.equal(options.runValidators, true);
  assert.equal(response.body.editedAt, EDITED_AT);
  assert.equal(response.body.date, stored.date);
});

test("saving an unchanged review returns it without an edited mark", async (t) => {
  const { stored } = setup(t);
  t.mock.method(Review, "findOneAndUpdate", async () => null);
  t.mock.method(Review, "findOne", async (filter) => {
    assert.deepEqual(filter, { reviewId: REVIEW_ID, userId: "owner" });
    return stored;
  });
  const router = loadRouter(t);

  const response = await patch(router, { rating: 3, reviewText: "Original" });

  assert.equal(response.status, 200);
  assert.equal(response.body.editedAt, null);
  assert.equal(response.body.reviewText, "Original");
});

test("editing a missing or unowned review returns REVIEW_NOT_FOUND", async (t) => {
  setup(t);
  t.mock.method(Review, "findOneAndUpdate", async () => null);
  t.mock.method(Review, "findOne", async () => null);
  const router = loadRouter(t);

  const response = await patch(router, { rating: 4, reviewText: "Not mine" });

  assert.deepEqual(response, { status: 404, body: { error: "Review not found", code: "REVIEW_NOT_FOUND" } });
});

test("edits reject unknown fields and invalid values before any write", async (t) => {
  setup(t);
  const write = t.mock.method(Review, "findOneAndUpdate", async () => { throw new Error("must not write"); });
  const router = loadRouter(t);
  const cases = [
    [{ rating: 4, reviewText: "Fine", editedAt: "2020-01-01" }, "Unsupported review fields: editedAt"],
    [{ rating: 4, reviewText: "Fine", date: "2020-01-01" }, "Unsupported review fields: date"],
    [{ rating: 4.25, reviewText: "Fine" }, "Rating must be a whole or half number between 1 and 5"],
    [{ rating: 6, reviewText: "Fine" }, "Rating must be a whole or half number between 1 and 5"],
    [{ rating: 4 }, "Review text is required"],
    [{ rating: 4, reviewText: "   " }, "Review text is required"],
    [{ rating: 4, reviewText: 42 }, "Review text is required"],
    [{ rating: 4, reviewText: "x".repeat(301) }, "Review text must be 300 characters or fewer"],
  ];

  for (const [body, error] of cases) {
    assert.deepEqual(await patch(router, body), { status: 400, body: { error, code: "INVALID_REVIEW" } }, JSON.stringify(body));
  }
  assert.equal(write.mock.callCount(), 0);
});
