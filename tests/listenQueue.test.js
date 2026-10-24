const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const {
  MAX_QUEUE,
  addInput,
  applyOrder,
  effectiveQueue,
  placeAlbum,
  reorderInput,
} = require("../routes/utils/listenQueue");

const ALBUM_ID = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
const OTHER_ALBUM_ID = "7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d";

function id() { return new mongoose.Types.ObjectId(); }
function entries(count) {
  return Array.from({ length: count }, (_, index) => ({ albumCatalogId: id(), addedAt: new Date(2026, 0, index + 1) }));
}
function rejects(fn, status, code) {
  assert.throws(fn, (error) => error.status === status && error.code === code);
}

test("add input accepts an album and an optional top or bottom position", () => {
  assert.deepEqual(addInput({ albumId: ALBUM_ID.toUpperCase() }), { albumId: ALBUM_ID, position: null });
  assert.deepEqual(addInput({ albumId: ALBUM_ID, position: "bottom" }), { albumId: ALBUM_ID, position: "bottom" });
  rejects(() => addInput({ albumId: ALBUM_ID, position: null }), 400, "INVALID_QUEUE_REQUEST");
  assert.deepEqual(addInput({ albumId: ALBUM_ID, position: "top" }), { albumId: ALBUM_ID, position: "top" });
  rejects(() => addInput({ albumId: ALBUM_ID, position: "middle" }), 400, "INVALID_QUEUE_REQUEST");
  rejects(() => addInput({ albumId: ALBUM_ID, addedAt: "2026-01-01" }), 400, "INVALID_QUEUE_REQUEST");
  rejects(() => addInput({}), 400, "INVALID_QUEUE_REQUEST");
  rejects(() => addInput([]), 400, "INVALID_QUEUE_REQUEST");
  rejects(() => addInput({ albumId: "spotify:album:1" }), 400, "INVALID_ALBUM_ID");
});

test("reorder input requires distinct public album IDs and a revision", () => {
  assert.deepEqual(reorderInput({ albumIds: [ALBUM_ID, OTHER_ALBUM_ID], revision: 3 }), { albumIds: [ALBUM_ID, OTHER_ALBUM_ID], revision: 3 });
  assert.deepEqual(reorderInput({ albumIds: [], revision: 0 }), { albumIds: [], revision: 0 });
  rejects(() => reorderInput({ albumIds: [ALBUM_ID] }), 400, "INVALID_QUEUE_REQUEST");
  rejects(() => reorderInput({ albumIds: [ALBUM_ID], revision: -1 }), 400, "INVALID_QUEUE_REQUEST");
  rejects(() => reorderInput({ albumIds: [ALBUM_ID], revision: "1" }), 400, "INVALID_QUEUE_REQUEST");
  rejects(() => reorderInput({ albumIds: [ALBUM_ID, ALBUM_ID], revision: 1 }), 400, "INVALID_QUEUE_REQUEST");
  rejects(() => reorderInput({ albumIds: Array(MAX_QUEUE + 1).fill(ALBUM_ID), revision: 1 }), 400, "INVALID_QUEUE_REQUEST");
  rejects(() => reorderInput({ albumIds: [ALBUM_ID], revision: 1, userId: "someone" }), 400, "INVALID_QUEUE_REQUEST");
  rejects(() => reorderInput({ albumIds: [12], revision: 1 }), 400, "INVALID_ALBUM_ID");
});

test("placing an album adds it at either end and moves an album already queued", () => {
  const queue = entries(3);
  const added = id();
  const now = new Date("2026-10-16T00:00:00Z");
  const bottom = placeAlbum(queue, added, "bottom", now);
  assert.equal(bottom.length, 4);
  assert.equal(bottom[3].albumCatalogId, added);
  assert.equal(bottom[3].addedAt, now);
  assert.equal(placeAlbum(queue, added, "top", now)[0].albumCatalogId, added);

  const moved = placeAlbum(queue, queue[2].albumCatalogId, "top", now);
  assert.deepEqual(moved.map((entry) => entry.albumCatalogId), [queue[2], queue[0], queue[1]].map((entry) => entry.albumCatalogId));
  assert.equal(moved[0].addedAt, queue[2].addedAt, "a move keeps the original addedAt");
  assert.equal(queue.length, 3, "the input is not mutated");
});

test("an add without a position appends a new album and leaves a queued one in place", () => {
  const queue = entries(3);
  const added = id();
  const appended = placeAlbum(queue, added, null);
  assert.equal(appended.length, 4);
  assert.equal(appended[3].albumCatalogId, added);
  assert.equal(placeAlbum(queue, queue[0].albumCatalogId, null), queue, "a queued album keeps its place");
  rejects(() => placeAlbum(entries(MAX_QUEUE), id(), null), 409, "QUEUE_FULL");
});

test("the queue cap blocks new albums but still allows moves", () => {
  const full = entries(MAX_QUEUE);
  rejects(() => placeAlbum(full, id(), "bottom"), 409, "QUEUE_FULL");
  const moved = placeAlbum(full, full[MAX_QUEUE - 1].albumCatalogId, "top");
  assert.equal(moved.length, MAX_QUEUE);
  assert.equal(moved[0], full[MAX_QUEUE - 1]);
});

test("a reorder must name exactly the current albums", () => {
  const queue = entries(3);
  const reversed = applyOrder(queue, [...queue].reverse().map((entry) => entry.albumCatalogId));
  assert.deepEqual(reversed, [...queue].reverse());
  rejects(() => applyOrder(queue, queue.slice(0, 2).map((entry) => entry.albumCatalogId)), 409, "QUEUE_CHANGED");
  rejects(() => applyOrder(queue, [queue[0], queue[1], { albumCatalogId: id() }].map((entry) => entry.albumCatalogId)), 409, "QUEUE_CHANGED");
  rejects(() => applyOrder(queue, [...queue, { albumCatalogId: id() }].map((entry) => entry.albumCatalogId)), 409, "QUEUE_CHANGED");
});

test("a profile that never wrote its queue reads the legacy listening-next album", () => {
  const legacy = id();
  const updatedAt = new Date("2026-05-01T00:00:00Z");
  assert.deepEqual(effectiveQueue({ listeningNextAlbum: { albumCatalogId: legacy }, updatedAt }), [{ albumCatalogId: legacy, addedAt: updatedAt }]);
  assert.deepEqual(effectiveQueue({ listeningNextAlbum: { albumCatalogId: { _id: legacy } }, queueRevision: 0, updatedAt }), [{ albumCatalogId: legacy, addedAt: updatedAt }]);
  assert.deepEqual(effectiveQueue({ listeningNextAlbum: null }), []);
  assert.deepEqual(effectiveQueue(null), []);

  const queued = entries(2);
  assert.deepEqual(effectiveQueue({ listenQueue: queued, queueRevision: 4, listeningNextAlbum: { albumCatalogId: legacy } }), queued);
  assert.deepEqual(effectiveQueue({ listenQueue: [], queueRevision: 1, listeningNextAlbum: { albumCatalogId: legacy } }), []);
});
