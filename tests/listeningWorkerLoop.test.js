const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { main, failureDelay, FAILURE_BACKOFF_MS, MAX_FAILURE_BACKOFF_MS, SCHEDULE_INTERVAL_MS } = require("../scripts/listeningWorker");

// Runs the worker loop against fakes; `step` sees each sleep and may stop the loop.
function harness({ schedulers, runWorkerOnce, step, clock = () => 0 }) {
  const signals = new EventEmitter();
  const sleeps = [];
  const logs = [];
  let disconnected = false;
  const run = main({
    env: { MONGO_URI: "mongodb://127.0.0.1:1/unused" },
    clock,
    log: (line) => logs.push(line),
    connect: async () => {},
    disconnect: async () => { disconnected = true; },
    initialize: async () => {},
    schedulers,
    runWorkerOnce,
    signals,
    sleep: async (ms) => {
      sleeps.push(ms);
      step({ sleeps, stop: () => signals.emit("SIGTERM") });
    },
  });
  return { run, sleeps, logs, signals, isDisconnected: () => disconnected };
}

test("failure backoff doubles from the base and is capped", () => {
  assert.equal(failureDelay(1), FAILURE_BACKOFF_MS);
  assert.equal(failureDelay(2), FAILURE_BACKOFF_MS * 2);
  assert.equal(failureDelay(3), FAILURE_BACKOFF_MS * 4);
  assert.equal(failureDelay(50), MAX_FAILURE_BACKOFF_MS);
});

test("a failing pass is logged and retried with backoff instead of ending the worker", async () => {
  let calls = 0;
  const transient = Object.assign(new Error("connection mongodb://user:secret@host lost"), { name: "MongoNetworkError" });
  const { run, sleeps, logs, signals, isDisconnected } = harness({
    schedulers: [],
    // Two failures, then a successful idle pass.
    runWorkerOnce: async () => {
      calls += 1;
      if (calls <= 2) throw transient;
      return { processed: false };
    },
    step: ({ sleeps: seen, stop }) => { if (seen.length === 3) stop(); },
  });
  await run;
  assert.deepEqual(sleeps, [FAILURE_BACKOFF_MS, FAILURE_BACKOFF_MS * 2, 5_000]);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /MongoNetworkError/);
  assert.doesNotMatch(logs.join("\n"), /secret/);
  assert.equal(isDisconnected(), true);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("a successful pass resets the backoff", async () => {
  const outcomes = ["fail", "fail", "ok", "fail"];
  const { run, sleeps } = harness({
    schedulers: [],
    runWorkerOnce: async () => {
      const next = outcomes.shift();
      if (next === "fail") throw Object.assign(new Error("x"), { code: 11600 });
      return { processed: false };
    },
    step: ({ sleeps: seen, stop }) => { if (seen.length === 4) stop(); },
  });
  await run;
  assert.deepEqual(sleeps, [FAILURE_BACKOFF_MS, FAILURE_BACKOFF_MS * 2, 5_000, FAILURE_BACKOFF_MS]);
});

test("a failing schedule scan does not stop the worker", async () => {
  let scheduleCalls = 0;
  const { run, logs } = harness({
    schedulers: [async () => { scheduleCalls += 1; if (scheduleCalls === 1) throw Object.assign(new Error("x"), { code: "ECONNRESET" }); }],
    runWorkerOnce: async () => ({ processed: false }),
    step: ({ sleeps: seen, stop }) => { if (seen.length === 2) stop(); },
  });
  await run;
  assert.equal(scheduleCalls, 2);
  assert.match(logs[0], /ECONNRESET/);
});

test("schedule scans run at most once per interval while jobs keep flowing", async () => {
  let now = 0;
  let scheduleCalls = 0;
  let jobCalls = 0;
  const { run } = harness({
    clock: () => now,
    schedulers: [async () => { scheduleCalls += 1; }],
    // Alternate one processed job with an empty queue on every pass.
    runWorkerOnce: async () => ({ processed: (jobCalls += 1) % 2 === 1 }),
    step: ({ sleeps: seen, stop }) => {
      now += 1_000;
      if (seen.length === 5) now += SCHEDULE_INTERVAL_MS;
      if (seen.length === 6) stop();
    },
  });
  await run;
  assert.equal(scheduleCalls, 2);
});

test("a stop signal ends the loop and disconnects", async () => {
  const { run, sleeps, isDisconnected } = harness({
    schedulers: [],
    runWorkerOnce: async () => ({ processed: false }),
    step: ({ stop }) => stop(),
  });
  await run;
  assert.deepEqual(sleeps, [5_000]);
  assert.equal(isDisconnected(), true);
});
