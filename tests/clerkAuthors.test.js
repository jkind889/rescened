const test = require("node:test");
const assert = require("node:assert/strict");

const { BATCH_SIZE, createAuthorCache, lookupAuthors } = require("../lib/clerkAuthors");

const clerkPath = require.resolve("@clerk/express");

function fakeUsers({ fail = false, missing = new Set(), delay = 0 } = {}) {
  const calls = [];
  return {
    calls,
    async getUserList(params) {
      calls.push(params);
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (fail) throw new Error("clerk unavailable");
      return {
        data: params.userId
          .filter((id) => !missing.has(id))
          .map((id) => ({ id, username: `name-${id}`, imageUrl: `https://img.test/${id}.png` })),
        totalCount: params.userId.length,
      };
    },
  };
}

test("lookups batch ids with an explicit limit and run the batches in parallel", async () => {
  const users = fakeUsers({ delay: 5 });
  const cache = createAuthorCache();
  const ids = Array.from({ length: BATCH_SIZE * 2 + 5 }, (_, index) => `user_${index}`);

  const authors = await cache.lookup(users, [...ids, ids[0], "", null]);

  assert.equal(users.calls.length, 3);
  assert.deepEqual(users.calls.map((call) => call.userId.length), [BATCH_SIZE, BATCH_SIZE, 5]);
  users.calls.forEach((call) => assert.equal(call.limit, call.userId.length));
  assert.equal(authors.size, ids.length);
  assert.deepEqual(authors.get("user_150"), { userId: "user_150", username: "name-user_150", imageUrl: "https://img.test/user_150.png" });
});

test("a cached author is reused until the TTL passes", async () => {
  let now = 1_000;
  const users = fakeUsers();
  const cache = createAuthorCache({ ttlMs: 100, now: () => now });

  await cache.lookup(users, ["a"]);
  now += 99;
  await cache.lookup(users, ["a"]);
  assert.equal(users.calls.length, 1);

  now += 1;
  await cache.lookup(users, ["a"]);
  assert.equal(users.calls.length, 2);
});

test("concurrent lookups share one in-flight Clerk call", async () => {
  const users = fakeUsers({ delay: 10 });
  const cache = createAuthorCache();

  const [first, second] = await Promise.all([cache.lookup(users, ["a", "b"]), cache.lookup(users, ["b", "a"])]);

  assert.equal(users.calls.length, 1);
  assert.equal(first.get("a").username, "name-a");
  assert.equal(second.get("b").username, "name-b");
});

test("a failed Clerk call falls back to the default author and is not cached", async () => {
  const failing = fakeUsers({ fail: true });
  const cache = createAuthorCache();

  const authors = await cache.lookup(failing, ["a"]);
  assert.deepEqual(authors.get("a"), { userId: "a", username: "rescened user", imageUrl: "" });
  assert.equal(cache.size, 0);

  const healthy = fakeUsers();
  const retried = await cache.lookup(healthy, ["a"]);
  assert.equal(healthy.calls.length, 1);
  assert.equal(retried.get("a").username, "name-a");
});

test("a user Clerk does not return is cached under the default name", async () => {
  const users = fakeUsers({ missing: new Set(["gone"]) });
  const cache = createAuthorCache();

  const authors = await cache.lookup(users, ["gone", "here"]);
  assert.equal(authors.get("gone").username, "rescened user");
  await cache.lookup(users, ["gone"]);
  assert.equal(users.calls.length, 1);
});

test("refresh skips the cache for the named users only", async () => {
  const users = fakeUsers();
  const cache = createAuthorCache();

  await cache.lookup(users, ["a", "b"]);
  await cache.lookup(users, ["a", "b"], { refresh: ["a"] });

  assert.equal(users.calls.length, 2);
  assert.deepEqual(users.calls[1].userId, ["a"]);
});

test("the cache evicts the least recently used author past its size bound", async () => {
  const users = fakeUsers();
  const cache = createAuthorCache({ maxEntries: 2 });

  await cache.lookup(users, ["a", "b"]);
  await cache.lookup(users, ["a"]);
  await cache.lookup(users, ["c"]);
  assert.equal(cache.size, 2);

  await cache.lookup(users, ["a"]);
  assert.equal(users.calls.length, 2, "a stayed cached because it was used most recently");
  await cache.lookup(users, ["b"]);
  assert.equal(users.calls.length, 3, "b was evicted");
});

test("returned authors are copies, so callers cannot mutate the cache", async () => {
  const users = fakeUsers();
  const cache = createAuthorCache();

  const first = await cache.lookup(users, ["a"]);
  first.get("a").username = "changed";
  const second = await cache.lookup(users, ["a"]);
  assert.equal(second.get("a").username, "name-a");
});

test("lookupAuthors resolves the Clerk module per call and caches per client", async (t) => {
  const previous = require.cache[clerkPath];
  t.after(() => {
    if (previous) require.cache[clerkPath] = previous;
    else delete require.cache[clerkPath];
  });
  function install(users) {
    require.cache[clerkPath] = { id: clerkPath, filename: clerkPath, loaded: true, exports: { clerkClient: { users } } };
  }

  const firstClient = fakeUsers();
  install(firstClient);
  await lookupAuthors(["a"]);
  await lookupAuthors(["a"]);
  assert.equal(firstClient.calls.length, 1);

  const secondClient = fakeUsers({ missing: new Set(["a"]) });
  install(secondClient);
  const authors = await lookupAuthors(["a"]);
  assert.equal(secondClient.calls.length, 1, "a new client starts with an empty cache");
  assert.equal(authors.get("a").username, "rescened user");

  install({});
  const fallback = await lookupAuthors(["b"]);
  assert.equal(fallback.get("b").username, "rescened user");
});
