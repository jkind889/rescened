const assert = require("node:assert/strict");
const test = require("node:test");

const Board = require("../models/Board");
const {
  BOARD_ORDER_LIMIT, orderEntries, orderedCount, reconciledOrder, seededOrder, requestedOrder, orderInput, nextSettings,
} = require("../routes/utils/boardOrder");

function albumId(index) { return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`; }
function key(index) { return `k${String(index).padStart(4, "0")}`; }
// Album i was saved i minutes after the epoch, so higher numbers are newer.
function entry(index, savedMinute = index) {
  return { key: key(index), albumId: albumId(index), savedAt: new Date(savedMinute * 60_000) };
}
function keysOf(entries) { return entries.map((item) => item.key); }
function range(from, to) { return Array.from({ length: to - from + 1 }, (_, i) => from + i); }

test("date order lists the newest album first and breaks ties by albumId", () => {
  const entries = [entry(1), entry(3), entry(2), entry(4, 3)];
  assert.deepEqual(keysOf(orderEntries(entries, { orderMode: "added" })), [key(3), key(4), key(2), key(1)]);
  assert.deepEqual(keysOf(orderEntries(entries, {})), [key(3), key(4), key(2), key(1)], "a legacy board is in date order");
  assert.deepEqual(keysOf(orderEntries(entries, { orderMode: "added", albumOrder: [key(1)] })), [key(3), key(4), key(2), key(1)], "date order ignores a stored order");
});

test("manual order skips missing and repeated entries, then appends other albums oldest first", () => {
  const entries = [entry(1), entry(2), entry(3), entry(4), entry(5)];
  const board = { orderMode: "manual", albumOrder: [key(3), "gone", key(1), key(3)] };
  // 3 and 1 are ordered; 2, 4 and 5 (listen-only or saved later) follow by savedAt.
  assert.deepEqual(keysOf(orderEntries(entries, board)), [key(3), key(1), key(2), key(4), key(5)]);
  assert.deepEqual(keysOf(orderEntries(entries, { orderMode: "manual" })), [key(1), key(2), key(3), key(4), key(5)]);
});

test("albumOrder entries may be ObjectIds or strings", () => {
  const objectish = { toString: () => key(2) };
  assert.deepEqual(keysOf(orderEntries([entry(1), entry(2)], { orderMode: "manual", albumOrder: [objectish] })), [key(2), key(1)]);
});

test("seeding manual order keeps the date order the board showed", () => {
  assert.deepEqual(seededOrder([entry(1), entry(3), entry(2)]), [key(3), key(2), key(1)]);
  assert.equal(seededOrder(range(1, BOARD_ORDER_LIMIT).map((i) => entry(i))).length, BOARD_ORDER_LIMIT);
  assert.throws(() => seededOrder(range(1, BOARD_ORDER_LIMIT + 1).map((i) => entry(i))), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, "BOARD_ORDER_LIMIT");
    return true;
  });
});

test("reconciliation on a small board stores the displayed order with new albums at the bottom", () => {
  const board = { orderMode: "manual", albumOrder: [key(2), key(1), "gone"] };
  // Album 3 just joined (newest) and album 4 joined earlier through a listen.
  const entries = [entry(1), entry(2), entry(3, 9), entry(4, 5)];
  const stored = reconciledOrder(entries, board);
  assert.deepEqual(stored, [key(2), key(1), key(4), key(3)]);
  assert.deepEqual(keysOf(orderEntries(entries, { ...board, albumOrder: stored })), keysOf(orderEntries(entries, board)), "nothing visibly moves");
});

test("a board past the limit keeps its ordered block, and later albums follow it oldest first", () => {
  const blockKeys = range(1, BOARD_ORDER_LIMIT).reverse().map(key);
  const board = { orderMode: "manual", albumOrder: blockKeys };
  const entries = [...range(1, BOARD_ORDER_LIMIT).map((i) => entry(i)), entry(102, 500), entry(101, 400)];
  const ordered = keysOf(orderEntries(entries, board));
  assert.deepEqual(ordered.slice(0, BOARD_ORDER_LIMIT), blockKeys);
  assert.deepEqual(ordered.slice(BOARD_ORDER_LIMIT), [key(101), key(102)]);
  assert.equal(orderedCount(board, entries.length), BOARD_ORDER_LIMIT);
  assert.deepEqual(reconciledOrder(entries, board), blockKeys, "new albums are not added to a full block");

  // A removal leaves the block short; the next album still follows the older ones.
  const short = entries.filter((item) => item.key !== key(50)).concat(entry(103, 600));
  const stored = reconciledOrder(short, board);
  assert.equal(stored.length, BOARD_ORDER_LIMIT - 1);
  assert.equal(stored.includes(key(50)), false);
  assert.deepEqual(keysOf(orderEntries(short, { ...board, albumOrder: stored })).slice(-3), [key(101), key(102), key(103)]);
});

test("shrinking back to the limit folds the followers into the stored order without moving them", () => {
  const board = { orderMode: "manual", albumOrder: range(1, BOARD_ORDER_LIMIT).map(key) };
  const entries = [...range(2, BOARD_ORDER_LIMIT).map((i) => entry(i)), entry(101, 400)];
  const stored = reconciledOrder(entries, board);
  assert.equal(stored.length, BOARD_ORDER_LIMIT);
  assert.equal(stored.at(-1), key(101));
});

test("ordered counts number every album up to the limit and none in date order", () => {
  assert.equal(orderedCount({ orderMode: "manual" }, 7), 7);
  assert.equal(orderedCount({ orderMode: "manual" }, 250), BOARD_ORDER_LIMIT);
  assert.equal(orderedCount({ orderMode: "added" }, 7), 0);
});

test("a reorder must list exactly the board's albums, or exactly the limit on a larger board", () => {
  const entries = [entry(1), entry(2), entry(3)];
  assert.deepEqual(requestedOrder(entries, [albumId(3), albumId(1), albumId(2)]), [key(3), key(1), key(2)]);
  for (const albumIds of [[albumId(1), albumId(2)], [albumId(1), albumId(2), albumId(3), albumId(4)], [albumId(1), albumId(2), albumId(9)]]) {
    assert.throws(() => requestedOrder(entries, albumIds), (error) => error.status === 409 && error.code === "BOARD_CHANGED");
  }

  const large = range(1, BOARD_ORDER_LIMIT + 2).map((i) => entry(i));
  const block = range(3, BOARD_ORDER_LIMIT + 2).map(albumId);
  assert.equal(requestedOrder(large, block).length, BOARD_ORDER_LIMIT);
  assert.throws(() => requestedOrder(large, block.slice(1)), (error) => error.code === "BOARD_CHANGED");
});

test("reorder bodies are validated before any lookup", () => {
  assert.deepEqual(orderInput({ albumIds: [albumId(1).toUpperCase()], revision: 3 }), { albumIds: [albumId(1)], revision: 3 });
  const invalid = [
    undefined, [], { albumIds: [albumId(1)] }, { albumIds: albumId(1), revision: 1 }, { albumIds: [], revision: -1 },
    { albumIds: [], revision: 1.5 }, { albumIds: [albumId(1), albumId(1)], revision: 1 }, { albumIds: [], revision: 1, extra: true },
    { albumIds: range(1, BOARD_ORDER_LIMIT + 1).map(albumId), revision: 1 },
  ];
  for (const body of invalid) {
    assert.throws(() => orderInput(body), (error) => error.status === 400 && error.code === "INVALID_BOARD_ORDER", JSON.stringify(body));
  }
  assert.throws(() => orderInput({ albumIds: ["not-an-album"], revision: 1 }), (error) => error.code === "INVALID_ALBUM_ID");
});

test("settings changes keep a ranked board in manual order", () => {
  assert.deepEqual(nextSettings({}, {}), { orderMode: "added", displayStyle: "grid" });
  assert.deepEqual(nextSettings({}, { orderMode: "manual", displayStyle: "ranked" }), { orderMode: "manual", displayStyle: "ranked" });
  assert.deepEqual(nextSettings({ orderMode: "manual", displayStyle: "ranked" }, { orderMode: "added" }), { orderMode: "added", displayStyle: "grid" });
  assert.deepEqual(nextSettings({ orderMode: "manual", displayStyle: "ranked" }, { displayStyle: "grid" }), { orderMode: "manual", displayStyle: "grid" });
  for (const [board, input] of [[{}, { displayStyle: "ranked" }], [{ orderMode: "manual" }, { orderMode: "added", displayStyle: "ranked" }], [{}, { orderMode: "custom" }], [{}, { displayStyle: "list" }]]) {
    assert.throws(() => nextSettings(board, input), (error) => error.status === 400 && error.code === "INVALID_BOARD_ORDER");
  }
});

test("the board model defaults to date order and caps its stored order", () => {
  const board = new Board({ userId: "owner", title: "Top albums" });
  assert.equal(board.orderMode, "added");
  assert.equal(board.displayStyle, "grid");
  assert.equal(board.albumOrder, undefined);
  board.albumOrder = range(1, BOARD_ORDER_LIMIT + 1).map(() => new Board()._id);
  assert.ok(board.validateSync()?.errors.albumOrder);
  assert.ok(new Board({ userId: "owner", title: "x", orderMode: "custom" }).validateSync()?.errors.orderMode);
});
