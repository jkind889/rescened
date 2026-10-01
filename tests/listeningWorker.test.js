const assert = require("node:assert/strict");
const test = require("node:test");
const { simplifiedTitle } = require("../lib/listening/discovery");
const { identityKey, inActivationWindow, syncWindow, RETENTION_MS, OVERLAP_MS } = require("../lib/listening/worker");

test("edition simplification is conservative and never strips distinct-work labels", () => {
  assert.equal(simplifiedTitle("Born to Die (Deluxe Version)"), "Born to Die");
  assert.equal(simplifiedTitle("Album - 10th Anniversary Edition"), "Album");
  assert.equal(simplifiedTitle("Album (Remix Edition)"), "");
  assert.equal(simplifiedTitle("Album (Live)"), "");
  assert.equal(simplifiedTitle("Album (Acoustic)"), "");
});

test("event identity is stable across field order and differs by played time", () => {
  const row = { playedAt: new Date("2026-09-25T12:00:00Z"), artist: "Artist", album: "Album", track: "Track" };
  assert.equal(identityKey(row), identityKey({ track: "Track", album: "Album", artist: "Artist", playedAt: "2026-09-25T12:00:00Z" }));
  assert.notEqual(identityKey(row), identityKey({ ...row, playedAt: new Date("2026-09-25T12:00:01Z") }));
  assert.equal(identityKey(row), identityKey({ ...row, albumMbid: "11111111-1111-4111-8111-111111111111", trackMbid: "22222222-2222-4222-8222-222222222222" }));
});

test("activation windows exclude paused boundaries", () => {
  const connection = { windows: [
    { start: new Date("2026-09-25T10:00:00Z"), end: new Date("2026-09-25T11:00:00Z") },
    { start: new Date("2026-09-25T12:00:00Z"), end: null },
  ] };
  assert.equal(inActivationWindow(connection, "2026-09-25T10:59:59Z"), true);
  assert.equal(inActivationWindow(connection, "2026-09-25T11:00:00Z"), false);
  assert.equal(inActivationWindow(connection, "2026-09-25T11:30:00Z"), false);
  assert.equal(inActivationWindow(connection, "2026-09-25T12:00:00Z"), true);
});

test("sync windows overlap completed work but never cross connection or retention boundaries", () => {
  const now = new Date("2026-09-25T12:00:00Z");
  const overlap = syncWindow({ connectedAt: new Date("2026-09-01T00:00:00Z"), completedThrough: new Date("2026-09-25T10:00:00Z") }, now);
  assert.equal(overlap.from.toISOString(), new Date(new Date("2026-09-25T10:00:00Z").getTime() - OVERLAP_MS).toISOString());
  const old = syncWindow({ connectedAt: new Date(now.getTime() - RETENTION_MS - 86_400_000), completedThrough: null }, now);
  assert.equal(old.from.toISOString(), new Date(now.getTime() - RETENTION_MS).toISOString());
  assert.ok(old.retentionGap);
});
