const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const mongoose = require("mongoose");
const BoardItemNote = require("../models/BoardItemNote");
const { noteInput } = require("../routes/utils/boardNoteInput");
const server = require("../lib/boardNoteText");
const client = vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../frontend/src/features/boards/boardNoteText.js"), "utf8")
  .replace(/export /g, "") + "\n({ normalizeBoardNote, boardNoteLength, BOARD_NOTE_LIMIT });");

test("note limits count the same Unicode graphemes on the client and server", () => {
  for (const value of ["hello", "é", "e\u0301", "😀", "👩🏽‍💻", "👨‍👩‍👧‍👦", "🇵🇭", "  hello\r\n\tworld  "]) {
    assert.equal(client.normalizeBoardNote(value), server.normalizeBoardNote(value));
    assert.equal(client.boardNoteLength(value), server.boardNoteLength(value));
  }
  assert.equal(client.BOARD_NOTE_LIMIT, server.BOARD_NOTE_LIMIT);
  assert.equal(server.boardNoteLength("👨‍👩‍👧‍👦"), 1);
  assert.equal(noteInput({ note: "👩🏽‍💻".repeat(100), revision: 0 }).note, "👩🏽‍💻".repeat(100));
  assert.throws(() => noteInput({ note: "👩🏽‍💻".repeat(101), revision: 0 }), { code: "INVALID_BOARD_NOTE" });
});

test("note input normalizes single-line text, allows clearing, and rejects unsupported data", () => {
  assert.deepEqual(noteInput({ note: "  Cafe\u0301\n\t  memories  ", revision: 3 }), { note: "Café memories", revision: 3 });
  assert.equal(noteInput({ note: " \r\n ", revision: 0 }).note, "");
  for (const note of [undefined, null, 3, {}, []]) assert.throws(() => noteInput({ note, revision: 0 }), { code: "INVALID_BOARD_NOTE" });
  for (const revision of [undefined, -1, "0", 1.5, Infinity]) assert.throws(() => noteInput({ note: "a", revision }), { code: "INVALID_BOARD_NOTE" });
  for (const body of [null, [], { note: "a", revision: 0, userId: "someone" }, { note: "a", revision: 0, albumId: "injected" }]) {
    assert.throws(() => noteInput(body), { code: "INVALID_DIARY_REQUEST" });
  }
});

test("the note model validates its storage contract and has a unique board-album index", () => {
  const record = (note) => new BoardItemNote({ userId: "owner", boardId: new mongoose.Types.ObjectId(), albumCatalogId: new mongoose.Types.ObjectId(), note });
  assert.equal(record("😀".repeat(100)).validateSync(), undefined);
  for (const note of ["x".repeat(101), "line\nbreak", "  leading", ""]) assert.ok(record(note).validateSync()?.errors.note);
  assert.ok(BoardItemNote.schema.indexes().some(([keys, options]) => keys.boardId === 1 && keys.albumCatalogId === 1 && options.unique));
});
