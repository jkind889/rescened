const assert = require("node:assert/strict");
const test = require("node:test");

const helper = import("../frontend/src/features/reviewEffort/reviewEffort.js");
const target = { effortId: "11111111-1111-4111-8111-111111111111", kind: "mapping", targetKind: "cases", targetId: "22222222-2222-4222-8222-222222222222", targetRevision: 4, outcome: "decided" };

test("the review timer counts only started intervals", async () => {
  const { activeMs, emptyTimer, hasTiming, pauseTimer, startTimer } = await helper;
  let timer = emptyTimer();
  assert.equal(hasTiming(timer), false);
  assert.equal(pauseTimer(timer, 5_000), timer, "pausing an idle timer changes nothing");
  timer = startTimer(timer, 10_000);
  assert.equal(startTimer(timer, 20_000), timer, "starting twice keeps the first start");
  assert.equal(activeMs(timer, 15_000), 5_000);
  timer = pauseTimer(timer, 40_000);
  assert.equal(activeMs(timer, 1_000_000), 30_000, "paused time is not counted");
  timer = pauseTimer(startTimer(timer, 100_000), 110_000);
  assert.deepEqual(timer.intervals, [{ startedAt: 10_000, endedAt: 40_000 }, { startedAt: 100_000, endedAt: 110_000 }]);
});

test("the payload closes a running interval and is null when nothing was timed", async () => {
  const { effortPayload, emptyTimer, startTimer } = await helper;
  assert.equal(effortPayload(emptyTimer(), 1_000, target), null);
  const start = Date.parse("2026-11-20T10:00:00Z");
  const payload = effortPayload(startTimer(emptyTimer(), start), start + 90_000, target);
  assert.deepEqual(payload, { ...target, intervals: [{ startedAt: "2026-11-20T10:00:00.000Z", endedAt: "2026-11-20T10:01:30.000Z" }] });
});

test("elapsed time is shown as minutes and seconds, with hours when needed", async () => {
  const { formatElapsed, newEffortId } = await helper;
  assert.equal(formatElapsed(0), "0:00");
  assert.equal(formatElapsed(65_000), "1:05");
  assert.equal(formatElapsed(3_725_000), "1:02:05");
  assert.match(newEffortId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
});
