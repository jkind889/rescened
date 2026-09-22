const mongoose = require("mongoose");
const Board = require("../../models/Board");
const BoardItem = require("../../models/BoardItem");
const BoardListen = require("../../models/BoardListen");
const Listen = require("../../models/Listen");
const UserProfile = require("../../models/UserProfile");
const { isTransactionUnavailable } = require("./transactions");
const { fail, uuid } = require("./diaryValidation");

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

async function claimBoard(userId, boardId, session, { createDefault = false } = {}) {
  const isDefault = boardId === "default";
  const filter = isDefault ? { userId, isDefault: true } : { userId, boardId: uuid(boardId, "board") };
  let board = await Board.findOneAndUpdate(filter, { $inc: { interactionRevision: 1 } }, { session, returnDocument: "after", timestamps: false });
  if (!board && isDefault && createDefault) {
    [board] = await Board.create([{ userId, title: "Saved albums", isDefault: true }], { session });
  }
  if (!board) throw fail(404, "BOARD_NOT_FOUND", "Board not found");
  return board;
}

async function touchBoard(board, session) {
  await Board.updateOne({ _id: board._id }, { $set: { updatedAt: new Date() } }, { session });
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
    await touchBoard(board, session);
    return board;
  });
}

async function removeAlbum(userId, boardId, albumCatalogId) {
  return transaction("BOARD", async (session) => {
    const board = await claimBoard(userId, boardId, session);
    await BoardItem.deleteOne({ boardId: board._id, albumCatalogId }, { session });
    await BoardListen.deleteMany({ boardId: board._id, albumCatalogId }, { session });
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
    await touchBoard(board, session);
  });
}

module.exports = { transaction, claimBoard, touchBoard, claimListen, saveAlbum, removeAlbum, deleteBoard, setMembership };
