const mongoose = require("mongoose");
const Board = require("../../models/Board");
const BoardItem = require("../../models/BoardItem");
const BoardListen = require("../../models/BoardListen");
const Listen = require("../../models/Listen");
const UserProfile = require("../../models/UserProfile");
const { isTransactionUnavailable } = require("./transactions");
const { fail, uuid } = require("./diaryValidation");
const { boardEntries } = require("./boardLibrary");
const { orderMode, nextSettings, reconciledOrder, seededOrder, requestedOrder } = require("./boardOrder");

async function transaction(domain, callback) {
  // Concurrent first-use profile/default-board upserts and creation receipts
  // can lose a unique-index race. Retry the whole transaction on a fresh snapshot.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let session;
    try {
      session = await mongoose.startSession();
      return await session.withTransaction(() => callback(session));
    } catch (error) {
      if (isTransactionUnavailable(error)) {
        throw fail(503, `${domain}_WRITE_UNAVAILABLE`, "This write requires MongoDB transactions");
      }
      if (error.code !== 11000 || attempt === 2) throw error;
    } finally {
      if (session) await session.endSession();
    }
  }
}

// With revision, the claim succeeds only if the board is still at the revision
// the client read; a board that moved on returns 409 BOARD_CHANGED. A board
// never claimed before has no stored revision, which reads as 0.
async function claimBoard(userId, boardId, session, { createDefault = false, revision } = {}) {
  const isDefault = boardId === "default";
  const filter = isDefault ? { userId, isDefault: true } : { userId, boardId: uuid(boardId, "board") };
  const claim = revision === undefined ? filter : { ...filter, interactionRevision: revision === 0 ? { $in: [0, null] } : revision };
  let board = await Board.findOneAndUpdate(claim, { $inc: { interactionRevision: 1 } }, { session, returnDocument: "after", timestamps: false });
  if (!board && revision !== undefined && await Board.exists(filter).session(session)) {
    throw fail(409, "BOARD_CHANGED", "This board changed somewhere else. Refresh and try again.");
  }
  if (!board && isDefault && createDefault) {
    [board] = await Board.create([{ userId, title: "Saved albums", isDefault: true }], { session });
  }
  if (!board) throw fail(404, "BOARD_NOT_FOUND", "Board not found");
  return board;
}

async function touchBoard(board, session) {
  await Board.updateOne({ _id: board._id }, { $set: { updatedAt: new Date() } }, { session });
}

// Keeps a manual board's stored order in step with a membership change made
// earlier in the same transaction. Date-ordered boards store no order.
async function syncOrder(board, session) {
  if (orderMode(board) !== "manual") return;
  const next = reconciledOrder(await boardEntries(board, session), board);
  const current = (board.albumOrder || []).map(String);
  if (next.length === current.length && next.every((key, index) => key === current[index])) return;
  await Board.updateOne({ _id: board._id }, { $set: { albumOrder: next } }, { session, timestamps: false });
}

async function claimListen(userId, listenId, session) {
  const listen = await Listen.findOneAndUpdate(
    { userId, listenId: uuid(listenId, "listen") }, { $inc: { interactionRevision: 1 } },
    { session, returnDocument: "after", timestamps: false },
  );
  if (!listen) throw fail(404, "LISTEN_NOT_FOUND", "Listen not found");
  return listen;
}

async function saveAlbum(userId, boardId, albumCatalogId) {
  return transaction("BOARD", async (session) => {
    const board = await claimBoard(userId, boardId, session, { createDefault: true });
    await BoardItem.updateOne(
      { boardId: board._id, albumCatalogId },
      { $setOnInsert: { userId, boardId: board._id, albumCatalogId, savedAt: new Date() } },
      { upsert: true, session },
    );
    await syncOrder(board, session);
    await touchBoard(board, session);
    return board;
  });
}

async function removeAlbum(userId, boardId, albumCatalogId) {
  return transaction("BOARD", async (session) => {
    const board = await claimBoard(userId, boardId, session);
    await BoardItem.deleteOne({ boardId: board._id, albumCatalogId }, { session });
    await BoardListen.deleteMany({ boardId: board._id, albumCatalogId }, { session });
    await syncOrder(board, session);
    await touchBoard(board, session);
  });
}

async function deleteBoard(userId, boardId) {
  return transaction("BOARD", async (session) => {
    const board = await claimBoard(userId, boardId, session);
    if (board.isDefault) throw fail(400, "DEFAULT_BOARD_REQUIRED", "The default board cannot be deleted");
    await BoardItem.deleteMany({ boardId: board._id }, { session });
    await BoardListen.deleteMany({ boardId: board._id }, { session });
    await UserProfile.updateMany({ pinnedBoardId: board._id }, { $set: { pinnedBoardId: null } }, { session });
    await Board.deleteOne({ _id: board._id, userId }, { session });
  });
}

async function setMembership(userId, boardId, listenId, attached) {
  return transaction("DIARY", async (session) => {
    // Every attach claims both parents, including idempotent repeats. A delete
    // racing an attach therefore conflicts and retries instead of leaving an orphan.
    const board = await claimBoard(userId, boardId, session, { createDefault: attached });
    const listen = await claimListen(userId, listenId, session);
    if (attached) {
      await BoardListen.updateOne(
        { boardId: board._id, listenId: listen._id },
        { $setOnInsert: { userId, boardId: board._id, listenId: listen._id, albumCatalogId: listen.albumCatalogId, addedAt: new Date() } },
        { upsert: true, session },
      );
    } else {
      await BoardListen.deleteOne({ boardId: board._id, listenId: listen._id }, { session });
    }
    await syncOrder(board, session);
    await touchBoard(board, session);
  });
}

// Applies title, description, and order settings together. Switching to
// manual order seeds it from the date order the board showed, and is refused
// past the order limit; switching back drops the stored order.
async function updateBoard(userId, boardId, changes) {
  return transaction("BOARD", async (session) => {
    const board = await claimBoard(userId, boardId, session, { createDefault: true });
    const update = { $set: {} };
    if (changes.title !== undefined) update.$set.title = changes.title;
    if (changes.description !== undefined) update.$set.description = changes.description;
    if (changes.orderMode !== undefined || changes.displayStyle !== undefined) {
      const next = nextSettings(board, changes);
      if (next.orderMode === "manual" && orderMode(board) !== "manual") {
        update.$set.albumOrder = seededOrder(await boardEntries(board, session));
      }
      if (next.orderMode !== "manual") update.$unset = { albumOrder: 1 };
      Object.assign(update.$set, next);
    }
    await Board.updateOne({ _id: board._id }, update, { session, runValidators: true });
  });
}

// Replaces a manual board's order. albumIds are public IDs already validated
// by orderInput; they must match the board at the revision the client read.
async function reorderBoard(userId, boardId, { albumIds, revision }) {
  return transaction("BOARD", async (session) => {
    const board = await claimBoard(userId, boardId, session, { revision });
    if (orderMode(board) !== "manual") throw fail(400, "INVALID_BOARD_ORDER", "Switch this board to custom order first");
    const albumOrder = requestedOrder(await boardEntries(board, session), albumIds);
    await Board.updateOne({ _id: board._id }, { $set: { albumOrder } }, { session, runValidators: true });
  });
}

module.exports = {
  transaction, claimBoard, touchBoard, syncOrder, claimListen, saveAlbum, removeAlbum, deleteBoard, setMembership, updateBoard, reorderBoard,
};
