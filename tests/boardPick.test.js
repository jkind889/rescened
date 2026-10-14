const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");
const AlbumCatalog = require("../models/AlbumCatalog");
const Board = require("../models/Board");
const BoardItem = require("../models/BoardItem");
const Listen = require("../models/Listen");
const Review = require("../models/Reviews");
const { pickUnplayedAlbum } = require("../routes/utils/boardPick");

const BOARD_ID = "11111111-1111-4111-8111-111111111111";

function album(id, albumId) {
  return { _id: id, albumId, title: `Album ${albumId.slice(0, 1)}`, artistDisplayName: "Artist", artistCredits: [], tracks: [] };
}

test("picks only saved albums the user has neither logged nor reviewed", async (t) => {
  const [listened, reviewed, open, missing] = Array.from({ length: 4 }, () => new mongoose.Types.ObjectId());
  const distinctCalls = [];
  t.mock.method(BoardItem, "distinct", async (field, match) => { distinctCalls.push(match); return [listened, reviewed, open, missing]; });
  t.mock.method(Listen, "distinct", async () => [listened]);
  t.mock.method(Review, "distinct", async () => [reviewed]);
  // The dangling catalog reference is skipped rather than ending the pick.
  t.mock.method(AlbumCatalog, "findById", async (id) => (String(id) === String(open) ? album(open, "33333333-3333-4333-8333-333333333333") : null));

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await pickUnplayedAlbum("owner");
    assert.equal(result.album.albumId, "33333333-3333-4333-8333-333333333333");
    assert.ok(result.candidateCount >= 1 && result.candidateCount <= 2);
    assert.equal(JSON.stringify(result).includes(String(open)), false);
    assert.deepEqual(Object.keys(result.album).sort(), ["albumId", "artistDisplayName", "cover", "releaseYear", "title"]);
  }
  assert.deepEqual(distinctCalls[0], { userId: "owner" });
});

test("an exhausted shelf returns no album, and a board pick is scoped to an owned board", async (t) => {
  const boardObjectId = new mongoose.Types.ObjectId();
  const saved = new mongoose.Types.ObjectId();
  let match;
  t.mock.method(BoardItem, "distinct", async (field, query) => { match = query; return [saved]; });
  t.mock.method(Listen, "distinct", async () => [saved]);
  t.mock.method(Review, "distinct", async () => []);
  const findOne = t.mock.method(Board, "findOne", async (query) => (query.boardId === BOARD_ID ? { _id: boardObjectId, boardId: BOARD_ID, userId: "owner" } : null));

  assert.deepEqual(await pickUnplayedAlbum("owner", BOARD_ID), { album: null, candidateCount: 0 });
  assert.deepEqual(findOne.mock.calls[0].arguments[0], { userId: "owner", boardId: BOARD_ID });
  assert.deepEqual(match, { userId: "owner", boardId: boardObjectId });

  await assert.rejects(pickUnplayedAlbum("owner", "22222222-2222-4222-8222-222222222222"), (error) => error.status === 404 && error.code === "BOARD_NOT_FOUND");
});
