const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const { normalizeReviewSearch, reviewSearchStages } = require("../routes/utils/reviewSearch");
const { parseReviewFeedQuery, nextCursorFor, buildPopularReviewPagePipeline } = require("../routes/utils/reviewPagination");

test("profile review search validates and normalizes bounded literal text", () => {
  assert.equal(normalizeReviewSearch(undefined), "");
  assert.equal(normalizeReviewSearch("  BJoRK\t  Live  "), "BJoRK Live");
  assert.equal(normalizeReviewSearch("İstanbul"), "İstanbul");
  assert.equal(normalizeReviewSearch("İ".repeat(101)).length, 101);
  for (const input of [null, [], {}, "x".repeat(201)]) assert.throws(() => normalizeReviewSearch(input), { status: 400, code: "INVALID_REVIEW_SEARCH" });
  const stages = reviewSearchStages("ac/dc (live).*");
  const match = stages[0].$lookup.pipeline[0].$match.$or;
  assert.deepEqual(Object.keys(match[0]), ["title"]);
  assert.deepEqual(Object.keys(match[1]), ["artistDisplayName"]);
  assert.deepEqual(Object.keys(match[2]), ["artistCredits.name"]);
  const regex = new RegExp(match[0].title.$regex, "i");
  assert.equal(regex.test("AC/DC  (LIVE).* Remastered"), true);
  assert.equal(regex.test("AC/DC Live anything"), false);
  assert.equal(regex.test("AC/DC\u00a0(LIVE).* Remastered"), true);
  assert.equal(regex.test("AC/DC\u3000(LIVE).* Remastered"), true);
  assert.deepEqual(reviewSearchStages(""), []);
});

test("all review cursors bind normalized search and reject changed or cleared queries", () => {
  for (const sort of ["recent", "popular", "highest", "lowest"]) {
    const feed = parseReviewFeedQuery({ sort, q: "  Album   Title " }, "user:owner", { searchable: true });
    feed.snapshotTime = { t: 1788480000, i: 1 };
    const cursor = nextCursorFor({ _id: new mongoose.Types.ObjectId(), date: new Date(), rating: 4, likeCount: 1 }, feed);
    assert.ok(parseReviewFeedQuery({ sort, q: "Album Title", cursor }, "user:owner", { searchable: true }).cursor);
    for (const q of [undefined, "Other", "Artist"]) {
      assert.throws(() => parseReviewFeedQuery({ sort, q, cursor }, "user:owner", { searchable: true }), { code: "INVALID_REVIEW_CURSOR" });
    }
    assert.throws(() => parseReviewFeedQuery({ sort, q: "Album Title", cursor }, "user:someone-else", { searchable: true }), { code: "INVALID_REVIEW_CURSOR" });
  }
});

test("search filters popular candidates before likes, sorting, and page limit", () => {
  const stages = buildPopularReviewPagePipeline({ userId: "owner" }, { search: "album", limit: 2 });
  assert.deepEqual(stages[0], { $match: { userId: "owner" } });
  const searchIndex = stages.findIndex((stage) => stage.$match?.["reviewSearchAlbum.0"]);
  assert.ok(searchIndex > 0);
  assert.ok(searchIndex < stages.findIndex((stage) => stage.$lookup?.as === "reviewLikeStats"));
  assert.ok(searchIndex < stages.findIndex((stage) => stage.$limit));
});
