const assert = require("node:assert/strict");
const test = require("node:test");
const Follow = require("../models/Follow");
const Review = require("../models/Reviews");
const UserProfile = require("../models/UserProfile");
const {
  CANDIDATE_POOL_SIZE, CANDIDATE_POOL_TTL_MS, RANKING_MAX_TIME_MS,
  buildSuggestionPipeline, getSuggestionLimit, resetSuggestionCache, suggestPeople,
} = require("../routes/utils/peopleSuggestions");

test("suggestion limits default and clamp", () => {
  assert.equal(getSuggestionLimit(undefined), 5);
  assert.equal(getSuggestionLimit("0"), 1);
  assert.equal(getSuggestionLimit("100"), 12);
  assert.equal(getSuggestionLimit("3"), 3);
});

test("suggestion pipeline ranks every author except the deleted placeholder into a shared pool", () => {
  const now = new Date("2026-09-30T00:00:00.000Z");
  const pipeline = buildSuggestionPipeline({ now });
  assert.deepEqual(pipeline[0], { $match: { userId: { $ne: Review.DELETED_AUTHOR_ID } } });
  const group = pipeline.find((stage) => stage.$group).$group;
  assert.deepEqual(group.recentReviewCount.$sum.$cond[0], { $gte: ["$date", new Date("2026-08-31T00:00:00.000Z")] });
  assert.deepEqual(pipeline.find((stage) => stage.$sort).$sort, {
    recentReviewCount: -1, reviewCount: -1, latestReviewDate: -1, _id: 1,
  });
  assert.deepEqual(pipeline.at(-1), { $limit: CANDIDATE_POOL_SIZE });
});

// Stubs the three model reads suggestPeople makes and records how they are called.
function stubModels(t, { ranked, follows = {}, privateIds = () => [] }) {
  const currentPrivate = typeof privateIds === "function" ? privateIds : () => privateIds;
  const calls = { aggregate: 0, maxTimeMS: [], authorLimits: [] };
  t.mock.method(Review, "aggregate", () => {
    calls.aggregate += 1;
    const result = typeof ranked === "function" ? ranked() : Promise.resolve(ranked);
    return { option: ({ maxTimeMS }) => { calls.maxTimeMS.push(maxTimeMS); return result; } };
  });
  t.mock.method(Follow, "find", ({ followerId }) => ({
    select: () => ({ lean: async () => (follows[followerId] || []).map((followingId) => ({ followingId })) }),
  }));
  t.mock.method(UserProfile, "find", ({ userId }) => ({
    select: () => ({ lean: async () => userId.$in.filter((id) => currentPrivate().includes(id)).map((id) => ({ userId: id })) }),
  }));
  const authors = async (ids, options) => {
    calls.authorLimits.push(options?.limit);
    return new Map(ids.map((id) => [id, { username: `name-${id}`, imageUrl: "" }]));
  };
  return { calls, authors };
}

function rows(...ids) {
  return ids.map((id, index) => ({ _id: id, recentReviewCount: 10 - index, reviewCount: 20 - index }));
}

test("the ranking is cached across viewers while follows and privacy are read per request", async (t) => {
  resetSuggestionCache();
  let privateIds = [];
  const { calls, authors } = stubModels(t, { ranked: rows("a", "b", "c", "d"), follows: { viewer: ["a"] }, privateIds: () => privateIds });
  const clock = () => 1_000;

  const anonymous = await suggestPeople({ limit: 2, authors, clock });
  assert.deepEqual(anonymous.map((row) => row.userId), ["a", "b"]);
  assert.deepEqual(anonymous[0], { userId: "a", username: "name-a", imageUrl: "", recentReviewCount: 10, reviewCount: 20, isFollowing: false });

  // The viewer, and whoever they follow, are excluded from the cached pool.
  const signedIn = await suggestPeople({ viewerId: "b", limit: 5, authors, clock });
  assert.deepEqual(signedIn.map((row) => row.userId), ["a", "c", "d"]);
  const following = await suggestPeople({ viewerId: "viewer", limit: 5, authors, clock });
  assert.deepEqual(following.map((row) => row.userId), ["b", "c", "d"]);

  // A profile made private disappears immediately, without waiting for the cache.
  privateIds = ["c"];
  const afterPrivacy = await suggestPeople({ viewerId: "viewer", limit: 5, authors, clock });
  assert.deepEqual(afterPrivacy.map((row) => row.userId), ["b", "d"]);

  assert.equal(calls.aggregate, 1);
  assert.deepEqual(calls.maxTimeMS, [RANKING_MAX_TIME_MS]);
  // Clerk's default page of 10 would drop names beyond the tenth candidate.
  assert.deepEqual(calls.authorLimits, [4]);
});

test("the ranking refreshes after the TTL", async (t) => {
  resetSuggestionCache();
  let now = 0;
  const { calls, authors } = stubModels(t, { ranked: rows("a") });
  await suggestPeople({ authors, clock: () => now });
  now = CANDIDATE_POOL_TTL_MS - 1;
  await suggestPeople({ authors, clock: () => now });
  assert.equal(calls.aggregate, 1);
  now = CANDIDATE_POOL_TTL_MS;
  await suggestPeople({ authors, clock: () => now });
  assert.equal(calls.aggregate, 2);
});

test("concurrent requests share one ranking and a failed ranking is not cached", async (t) => {
  resetSuggestionCache();
  let attempt = 0;
  const { calls, authors } = stubModels(t, {
    ranked: () => {
      attempt += 1;
      return attempt === 1 ? Promise.reject(Object.assign(new Error("timeout"), { code: 50 })) : Promise.resolve(rows("a"));
    },
  });
  const clock = () => 0;
  const results = await Promise.allSettled([suggestPeople({ authors, clock }), suggestPeople({ authors, clock })]);
  assert.deepEqual(results.map((result) => result.status), ["rejected", "rejected"]);
  assert.equal(calls.aggregate, 1);

  const retried = await suggestPeople({ authors, clock });
  assert.deepEqual(retried.map((row) => row.userId), ["a"]);
  assert.equal(calls.aggregate, 2);
});

test("an empty site returns no suggestions without calling Clerk", async (t) => {
  resetSuggestionCache();
  const { calls, authors } = stubModels(t, { ranked: [] });
  assert.deepEqual(await suggestPeople({ viewerId: "viewer", authors, clock: () => 0 }), []);
  assert.deepEqual(calls.authorLimits, []);
});
