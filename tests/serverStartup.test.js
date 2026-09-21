const assert = require("node:assert/strict");
const test = require("node:test");

const serverPath = require.resolve("../server");
const REQUIRED_ENV = ["MONGO_URI", "CLERK_SECRET_KEY", "CLERK_PUBLISHABLE_KEY", "NODE_ENV"];

function loadServer(t) {
  const previous = Object.fromEntries(REQUIRED_ENV.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    MONGO_URI: "mongodb://example.test/rescened",
    CLERK_SECRET_KEY: "sk_test_startup",
    CLERK_PUBLISHABLE_KEY: "pk_test_startup",
    NODE_ENV: "test",
  });
  delete require.cache[serverPath];
  const server = require("../server");
  t.after(() => {
    delete require.cache[serverPath];
    REQUIRED_ENV.forEach((key) => {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    });
  });
  return server;
}

test("startServer waits for MongoDB before binding the HTTP port", async (t) => {
  const { startServer } = loadServer(t);
  const calls = [];
  let resolveConnection;
  const connected = new Promise((resolve) => { resolveConnection = resolve; });

  const starting = startServer({
    mongoUri: "mongodb://example.test/rescened",
    port: 4100,
    connect: async (uri) => {
      calls.push(["connect", uri]);
      await connected;
    },
    initializeDiary: async () => { calls.push(["diaryIndexes"]); },
    listen: (port, callback) => {
      calls.push(["listen", port]);
      callback();
      return { close() {} };
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [["connect", "mongodb://example.test/rescened"]]);

  resolveConnection();
  await starting;
  assert.deepEqual(calls, [
    ["connect", "mongodb://example.test/rescened"],
    ["diaryIndexes"],
    ["listen", 4100],
  ]);
});

test("startServer does not accept traffic when diary index initialization fails", async (t) => {
  const { startServer } = loadServer(t);
  let listenCalls = 0;
  await assert.rejects(startServer({
    connect: async () => {},
    initializeDiary: async () => { throw new Error("Diary index creation failed"); },
    listen: () => { listenCalls += 1; },
  }), /Diary index creation failed/);
  assert.equal(listenCalls, 0);
});

test("startServer does not bind a port when MongoDB connection fails", async (t) => {
  const { startServer } = loadServer(t);
  let listenCalls = 0;

  await assert.rejects(
    () => startServer({
      connect: async () => { throw new Error("MongoDB unavailable"); },
      listen: () => { listenCalls += 1; },
    }),
    /MongoDB unavailable/,
  );

  assert.equal(listenCalls, 0);
});
