const crypto = require("node:crypto");
const mongoose = require("mongoose");
const AlbumCatalog = require("../../models/AlbumCatalog");
const Listen = require("../../models/Listen");
const ListenCreation = require("../../models/ListenCreation");
const BoardListen = require("../../models/BoardListen");
const Board = require("../../models/Board");
const UserProfile = require("../../models/UserProfile");
const { normalizeCatalogAlbum } = require("./albumCatalog");
const { fail, uuid, fields, calendarDate, listeningDate, creationInput, isCalendarDate } = require("./diaryValidation");
const { transaction, claimBoard, touchBoard, claimListen } = require("./boardMutations");
const { ownedBoard } = require("./boardLibrary");

const developmentCursorSecret = crypto.randomBytes(32);
function cursorKey() {
  return crypto.createHash("sha256").update(process.env.CLERK_SECRET_KEY || developmentCursorSecret).update("rescened:diary:v1").digest();
}

function encodeCursor(row, scope) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", cursorKey(), iv);
  const payload = { v: 1, scope, date: row.listenedOn, createdAt: new Date(row.createdAt).toISOString(), id: String(row._id) };
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

function decodeCursor(value, scope) {
  try {
    if (typeof value !== "string" || value.length > 4096) throw new Error("cursor");
    const parts = value.split(".");
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error("cursor");
    const [iv, tag, encrypted] = parts.map((part) => Buffer.from(part, "base64url"));
    if (iv.length !== 12 || tag.length !== 16) throw new Error("cursor");
    const decipher = crypto.createDecipheriv("aes-256-gcm", cursorKey(), iv);
    decipher.setAuthTag(tag);
    const row = JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8"));
    if (row.v !== 1 || row.scope !== scope || !isCalendarDate(row.date)
        || typeof row.id !== "string" || !/^[0-9a-f]{24}$/.test(row.id)
        || typeof row.createdAt !== "string" || !Number.isFinite(new Date(row.createdAt).getTime())) throw new Error("cursor");
    return { ...row, id: new mongoose.Types.ObjectId(row.id), createdAt: new Date(row.createdAt) };
  } catch {
    throw fail(400, "INVALID_DIARY_CURSOR", "Diary cursor is invalid or belongs to a different list");
  }
}

function serializeListen(listen, album) {
  const normalized = normalizeCatalogAlbum(album);
  if (!normalized?.albumId) return null;
  return {
    listenId: listen.listenId, userId: listen.userId, albumId: normalized.albumId, album: normalized,
    listenedOn: listen.listenedOn, createdAt: listen.createdAt, updatedAt: listen.updatedAt,
  };
}

async function serializedListen(listen, session) {
  const album = await AlbumCatalog.findById(listen.albumCatalogId).session(session || null);
  const result = serializeListen(listen, album);
  if (!result) throw fail(404, "ALBUM_NOT_FOUND", "Catalog album not found");
  return result;
}

async function createListen(userId, body, key) {
  const input = creationInput(body, key);
  return transaction("DIARY", async (session) => {
    const receipt = await ListenCreation.findOne({ userId, key: input.key }).session(session);
    if (receipt) {
      if (receipt.fingerprint !== input.fingerprint) throw fail(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key was used with different input");
      const existing = await Listen.findOne({ userId, listenId: receipt.listenId }).session(session);
      if (!existing) throw fail(409, "LISTEN_DELETED", "The listen created with this key has been deleted");
      return { created: false, listen: await serializedListen(existing, session) };
    }
    const album = await AlbumCatalog.findOne({ albumId: input.albumId }).session(session);
    if (!album) throw fail(404, "ALBUM_NOT_FOUND", "Catalog album not found");
    const boards = [];
    for (const id of input.boardIds) boards.push(await claimBoard(userId, id, session));
    const [listen] = await Listen.create([{ userId, albumCatalogId: album._id, listenedOn: input.listenedOn }], { session });
    await ListenCreation.create([{ userId, key: input.key, fingerprint: input.fingerprint, listenId: listen.listenId }], { session });
    for (const board of boards) {
      await BoardListen.create([{ userId, boardId: board._id, listenId: listen._id, albumCatalogId: album._id }], { session });
      await touchBoard(board, session);
    }
    await UserProfile.updateOne({ userId }, { $setOnInsert: { userId } }, { upsert: true, session });
    return { created: true, listen: serializeListen(listen, album) };
  });
}

async function updateListen(userId, listenId, body) {
  fields(body, ["listenedOn", "timeZone"]);
  const { listenedOn } = listeningDate(body);
  return transaction("DIARY", async (session) => {
    const listen = await claimListen(userId, listenId, session);
    listen.listenedOn = listenedOn;
    await listen.save({ session });
    return serializedListen(listen, session);
  });
}

async function deleteListen(userId, listenId) {
  const id = uuid(listenId, "listen");
  return transaction("DIARY", async (session) => {
    const existing = await Listen.findOne({ userId, listenId: id }).session(session);
    if (!existing) return;
    const memberships = await BoardListen.find({ listenId: existing._id }).session(session);
    const boards = await Board.find({ _id: { $in: memberships.map((row) => row.boardId) }, userId }).sort({ boardId: 1 }).session(session);
    for (const board of boards) {
      await claimBoard(userId, board.boardId, session);
      await touchBoard(board, session);
    }
    // Claiming the listen also catches an attach to a board absent from the
    // snapshot above; the transaction retries with its new membership included.
    const listen = await claimListen(userId, id, session);
    await BoardListen.deleteMany({ listenId: listen._id }, { session });
    await Listen.deleteOne({ _id: listen._id, userId }, { session });
  });
}

async function listListens(userId, query = {}, fixed = {}) {
  fields(query, ["albumId", "boardId", "from", "to", "limit", "cursor"]);
  const filters = { ...query };
  for (const [key, value] of Object.entries(fixed)) {
    if (filters[key] !== undefined && String(filters[key]).toLowerCase() !== String(value).toLowerCase()) {
      throw fail(400, "INVALID_DIARY_REQUEST", "A filter conflicts with the requested board or album");
    }
    filters[key] = value;
  }
  const albumId = filters.albumId === undefined ? "" : uuid(filters.albumId, "album");
  const from = filters.from === undefined ? "" : calendarDate(filters.from);
  const to = filters.to === undefined ? "" : calendarDate(filters.to);
  if (from && to && from > to) throw fail(400, "INVALID_LISTEN_DATE", "from must not follow to");
  if (filters.limit !== undefined && (typeof filters.limit !== "string" || !/^[1-9]\d*$/.test(filters.limit))) {
    throw fail(400, "INVALID_DIARY_REQUEST", "limit must be a positive integer");
  }
  const limit = Math.min(Number(filters.limit || 20), 50);
  let board;
  if (filters.boardId !== undefined) {
    if (typeof filters.boardId !== "string") throw fail(400, "INVALID_BOARD_ID", "boardId must be a UUID v4 or default");
    if (filters.boardId !== "default") uuid(filters.boardId, "board");
    board = await ownedBoard(userId, filters.boardId, false);
    if (!board) throw fail(404, "BOARD_NOT_FOUND", "Board not found");
  }
  const scope = JSON.stringify({ userId, albumId, boardId: board?.boardId || "", from, to });
  const cursor = filters.cursor === undefined ? null : decodeCursor(filters.cursor, scope);
  const match = { userId };
  if (from || to) match.listenedOn = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  if (albumId) {
    const album = await AlbumCatalog.findOne({ albumId });
    if (!album) throw fail(404, "ALBUM_NOT_FOUND", "Catalog album not found");
    match.albumCatalogId = album._id;
  }
  if (cursor) match.$or = [
    { listenedOn: { $lt: cursor.date } },
    { listenedOn: cursor.date, createdAt: { $lt: cursor.createdAt } },
    { listenedOn: cursor.date, createdAt: cursor.createdAt, _id: { $lt: cursor.id } },
  ];
  const pipeline = [{ $match: match }, { $sort: { listenedOn: -1, createdAt: -1, _id: -1 } }];
  if (board) pipeline.push(
    { $lookup: {
      from: "boardlistens", localField: "_id", foreignField: "listenId",
      pipeline: [{ $match: { boardId: board._id, userId } }], as: "membership",
    } },
    { $match: { "membership.0": { $exists: true } } },
  );
  pipeline.push(
    { $lookup: { from: "albumcatalogs", localField: "albumCatalogId", foreignField: "_id", as: "album" } },
    { $unwind: "$album" },
    { $limit: limit + 1 },
  );
  const rows = await Listen.aggregate(pipeline);
  const page = rows.slice(0, limit);
  return {
    listens: page.map((row) => serializeListen(row, row.album)),
    nextCursor: rows.length > limit ? encodeCursor(page.at(-1), scope) : null,
  };
}

module.exports = { createListen, updateListen, deleteListen, listListens, serializeListen };
