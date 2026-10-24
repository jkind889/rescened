const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { orderEntries } = require("../routes/utils/boardOrder");

// Load the real pure client helpers without their browser-only API imports.
function pureHelpers(relativePath) {
  const source = fs.readFileSync(path.join(__dirname, relativePath), "utf8")
    .split("async function failure(")[0]
    .replace(/^import .*;\n/gm, "");
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

const helpers = Promise.all([
  pureHelpers("../frontend/src/features/boards/boardOrder.js"),
  pureHelpers("../frontend/src/features/queue/queue.js"),
]);

function fixture() {
  const entries = Array.from({ length: 103 }, (_, index) => ({
    key: `album-${String(index + 1).padStart(3, "0")}`,
    albumId: `album-${String(index + 1).padStart(3, "0")}`,
    savedAt: new Date((index + 1) * 60_000).toISOString(),
  }));
  const order = [...entries.slice(0, 100).reverse(), ...entries.slice(100)].map((entry) => entry.albumId);
  return { entries, order, albumsById: new Map(entries.map((entry) => [entry.albumId, entry])) };
}

test("earlier moves one position inside the block and promotes any overflow index", async () => {
  const [{ earlierOrderTarget }] = await helpers;
  assert.equal(earlierOrderTarget(0, 100), -1);
  assert.equal(earlierOrderTarget(1, 100), 0);
  assert.equal(earlierOrderTarget(99, 100), 98);
  assert.equal(earlierOrderTarget(100, 100), 99);
  assert.equal(earlierOrderTarget(101, 100), 99);
  assert.equal(earlierOrderTarget(102, 100), 99);
  assert.equal(earlierOrderTarget(12, 5), 4, "honors the board's reported limit");
});

test("every overflow album enters the custom block with one earlier action", async () => {
  const [{ earlierOrderTarget, normalizeDraft }, { moveItem }] = await helpers;
  const { entries, order, albumsById } = fixture();
  for (let index = 100; index < order.length; index += 1) {
    const next = normalizeDraft(moveItem(order, index, earlierOrderTarget(index, 100)), albumsById, 100);
    assert.equal(next[99], order[index]);
    assert.deepEqual(next.slice(0, 99), order.slice(0, 99));
    assert.equal(next[100], "album-001", "the displaced oldest album leads the date-sorted overflow");
    assert.equal(new Set(next).size, order.length, "promotion preserves every membership exactly once");
    assert.deepEqual(next, orderEntries(entries, { orderMode: "manual", albumOrder: next.slice(0, 100) }).map((entry) => entry.albumId), "draft matches the server's saved display order");
  }
  assert.equal(order[99], "album-001", "the original order remains unchanged");
});

test("a promoted album can continue moving earlier without disturbing overflow", async () => {
  const [{ earlierOrderTarget, normalizeDraft }, { moveItem }] = await helpers;
  const { order, albumsById } = fixture();
  const promoted = normalizeDraft(moveItem(order, 102, earlierOrderTarget(102, 100)), albumsById, 100);
  const next = normalizeDraft(moveItem(promoted, 99, earlierOrderTarget(99, 100)), albumsById, 100);
  assert.equal(next[98], "album-103");
  assert.deepEqual(next.slice(100), ["album-001", "album-101", "album-102"]);
});
