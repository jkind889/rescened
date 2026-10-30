const Board = require("../../models/Board");
const BoardItem = require("../../models/BoardItem");
const BoardListen = require("../../models/BoardListen");
const { CATALOG_ALBUM_FIELDS, normalizeCatalogAlbum } = require("./albumCatalog");
const { fail } = require("./diaryValidation");
const { BOARD_ORDER_LIMIT, orderMode, displayStyle, orderEntries, orderedCount } = require("./boardOrder");

function publicBoardId(value) {
  const id = String(value || "").trim().toLowerCase();
  return Board.isBoardId(id) ? id : "";
}

function persistedBoardId(board) {
  const id = publicBoardId(board?.boardId);
  if (!id) throw fail(500, "BOARD_ID_INTEGRITY_ERROR", "Board is missing a valid public identifier");
  return id;
}

// Owner reads include interactionRevision, the token a reorder must carry.
const WITH_REVISION = "+interactionRevision";
const CATALOG_ALBUM_PROJECTION = Object.fromEntries(CATALOG_ALBUM_FIELDS.split(" ").map((field) => [field, 1]));

async function getDefaultBoard(userId) {
  const existing = await Board.findOne({ userId, isDefault: true }, WITH_REVISION);
  if (existing) return existing;
  try { return await Board.create({ userId, title: "Saved albums", isDefault: true }); }
  catch (error) {
    if (error.code === 11000) return Board.findOne({ userId, isDefault: true }, WITH_REVISION);
    throw error;
  }
}

async function ownedBoard(userId, boardId, createDefault = true) {
  if (String(boardId).trim().toLowerCase() === "default") {
    return createDefault ? getDefaultBoard(userId) : Board.findOne({ userId, isDefault: true }, WITH_REVISION);
  }
  const id = publicBoardId(boardId);
  return id ? Board.findOne({ userId, boardId: id }, WITH_REVISION) : null;
}

// Validate both parents before using memberships in counts or album summaries.
function liveMembershipStages(match) {
  return [
    { $match: match },
    { $lookup: { from: "listens", localField: "listenId", foreignField: "_id", as: "listen" } },
    { $unwind: "$listen" },
    { $lookup: { from: "boards", localField: "boardId", foreignField: "_id", as: "board" } },
    { $unwind: "$board" },
    { $match: { $expr: { $and: [
      { $eq: ["$userId", "$board.userId"] },
      { $eq: ["$userId", "$listen.userId"] },
      { $eq: ["$albumCatalogId", "$listen.albumCatalogId"] },
    ] } } },
  ];
}

async function linkedAlbums(match, session, { albumFields = CATALOG_ALBUM_FIELDS, batchSize } = {}) {
  const albumProjection = albumFields === CATALOG_ALBUM_FIELDS
    ? CATALOG_ALBUM_PROJECTION
    : Object.fromEntries(albumFields.split(" ").map((field) => [field, 1]));
  const query = BoardListen.aggregate([
    ...liveMembershipStages(match),
    { $group: {
      _id: { board: "$boardId", album: "$albumCatalogId", user: "$userId" },
      savedAt: { $min: "$addedAt" }, listenCount: { $sum: 1 }, latestListenedOn: { $max: "$listen.listenedOn" },
    } },
    { $lookup: { from: "albumcatalogs", localField: "_id.album", foreignField: "_id", pipeline: [{ $project: albumProjection }], as: "album" } },
    { $unwind: "$album" },
  ]);
  if (session) query.session(session);
  return batchSize ? query.cursor({ batchSize }) : query;
}

// One entry per board album: { key, boardKey, albumId, savedAt, album }. key
// and boardKey are the internal AlbumCatalog and Board _ids for ordering and
// grouping; only album is ever serialized.
// Inside a transaction the reads run in its session, one after the other.
async function collectionEntries(match, session = null, options = {}) {
  const bounded = Number.isFinite(options.maxRows);
  const albumFields = options.albumFields || CATALOG_ALBUM_FIELDS;
  const batchSize = bounded ? options.batchSize || 500 : undefined;
  let rows = options.boardCount || 0;
  const populatedBoards = new Set();
  const entries = new Map();
  const checkLimit = () => {
    if (bounded && rows > options.maxRows) {
      throw fail(413, "EXPORT_TOO_LARGE", `Exports are limited to ${options.maxRows.toLocaleString("en-US")} rows.`);
    }
  };
  checkLimit();
  const put = (id, entry) => {
    if (bounded && !entries.has(id)) {
      // Each board already reserves one row, even when it has no albums.
      if (populatedBoards.has(entry.boardKey)) rows += 1;
      checkLimit();
      populatedBoards.add(entry.boardKey);
    }
    entries.set(id, entry);
  };
  const loadSaves = () => {
    const query = BoardItem.find(match).populate({ path: "albumCatalogId", select: albumFields }).sort({ savedAt: -1 });
    if (session) query.session(session);
    return bounded ? query.select("boardId userId albumCatalogId savedAt").lean().cursor({ batchSize }) : query;
  };
  const loadLinked = () => linkedAlbums(match, session, { albumFields, batchSize });
  const addLinked = (row) => {
    const album = normalizeCatalogAlbum(row.album);
    if (!album?.albumId) return;
    put(`${row._id.board}:${album.albumId}`, {
      key: String(row._id.album),
      boardKey: String(row._id.board),
      album: {
        ...album, userId: row._id.user, savedAt: row.savedAt,
        listenCount: row.listenCount, latestListenedOn: row.latestListenedOn, explicitlySaved: false,
      },
    });
  };
  const addSave = (row) => {
    const album = normalizeCatalogAlbum(row.albumCatalogId);
    if (!album?.albumId) return;
    const id = `${row.boardId}:${album.albumId}`;
    const linkedAlbum = entries.get(id)?.album;
    put(id, {
      key: String(row.albumCatalogId._id),
      boardKey: String(row.boardId),
      album: {
        ...album, userId: row.userId, savedAt: row.savedAt,
        listenCount: linkedAlbum?.listenCount || 0,
        latestListenedOn: linkedAlbum?.latestListenedOn || null, explicitlySaved: true,
      },
    });
  };
  if (bounded) {
    // Consume one cursor at a time; never load the whole account before the
    // row guard runs. Always close on limit, read, or normalization failures.
    const consume = async (cursor, add) => {
      try { for await (const row of cursor) add(row); }
      finally { await cursor.close(); }
    };
    await consume(await loadLinked(), addLinked);
    await consume(loadSaves(), addSave);
  } else {
    const [saves, linked] = session
      ? [await loadSaves(), await loadLinked()]
      : await Promise.all([loadSaves(), loadLinked()]);
    linked.forEach(addLinked);
    saves.forEach(addSave);
  }
  return [...entries.values()].map(({ key, boardKey, album }) => ({ key, boardKey, albumId: album.albumId, savedAt: album.savedAt, album }));
}

// A board's albums as the order rules arrange them: date order, or the
// board's manual order. See boardOrder.js.
async function boardEntries(board, session = null) {
  return orderEntries(await collectionEntries({ boardId: board._id }, session), board);
}

// revision is for the owner: a reorder must send it back.
function boardPayload(board, albums, { albums: includeAlbums = false, revision = false } = {}) {
  return {
    boardId: persistedBoardId(board), userId: board.userId, title: board.title, description: board.description || "",
    isDefault: Boolean(board.isDefault), createdAt: board.createdAt, updatedAt: board.updatedAt,
    orderMode: orderMode(board), displayStyle: displayStyle(board),
    // The leading albums a manual board numbers and lets its owner arrange.
    orderedCount: orderedCount(board, albums.length), orderLimit: BOARD_ORDER_LIMIT,
    itemCount: albums.length, listenCount: albums.reduce((sum, album) => sum + album.listenCount, 0),
    // Albums saved on purpose, the only ones "Pick something for me" can suggest.
    explicitSaveCount: albums.filter((album) => album.explicitlySaved).length,
    previewAlbums: albums.slice(0, 4), ...(includeAlbums ? { albums } : {}),
    ...(revision ? { revision: Number(board.interactionRevision) || 0 } : {}),
  };
}

async function formatBoard(board, options = {}) {
  return boardPayload(board, (await boardEntries(board)).map((entry) => entry.album), options);
}

// Formats a list of boards from one membership read instead of one per board.
// Each board's albums are ordered exactly as boardEntries orders them.
async function formatBoards(boards, options = {}) {
  if (!boards.length) return [];
  const entries = await collectionEntries(
    { boardId: { $in: boards.map((board) => board._id) } }, null,
    { maxRows: options.maxRows, boardCount: boards.length, albumFields: options.albumFields, batchSize: options.batchSize },
  );
  const byBoard = new Map();
  for (const entry of entries) {
    if (!byBoard.has(entry.boardKey)) byBoard.set(entry.boardKey, []);
    byBoard.get(entry.boardKey).push(entry);
  }
  return boards.map((board) => boardPayload(
    board,
    orderEntries(byBoard.get(String(board._id)) || [], board).map((entry) => entry.album),
    options,
  ));
}

async function savedAlbums(userId) {
  const rows = orderEntries(await collectionEntries({ userId }), { orderMode: "added" }).map((entry) => entry.album);
  const seen = new Set();
  return rows.filter((album) => {
    if (seen.has(album.albumId)) return false;
    seen.add(album.albumId);
    return true;
  }).map(({ listenCount, latestListenedOn, explicitlySaved, ...album }) => album);
}

async function albumBoards(userId, albumCatalogId) {
  const [saves, linked] = await Promise.all([
    BoardItem.find({ userId, albumCatalogId }).populate("boardId"),
    BoardListen.aggregate([
      ...liveMembershipStages({ userId, albumCatalogId }),
      { $group: { _id: "$boardId", board: { $first: "$board" } } },
    ]),
  ]);
  const boards = new Map();
  for (const board of [...saves.map((item) => item.boardId), ...linked.map((row) => row.board)]) {
    if (!board || board.userId !== userId) continue;
    const boardId = persistedBoardId(board);
    boards.set(boardId, { boardId, title: board.title, isDefault: Boolean(board.isDefault) });
  }
  return [...boards.values()];
}

async function savedUserCount(albumCatalogId) {
  const [explicit, linked] = await Promise.all([
    BoardItem.distinct("userId", { albumCatalogId }),
    BoardListen.aggregate([...liveMembershipStages({ albumCatalogId }), { $group: { _id: "$userId" } }]),
  ]);
  return new Set([...explicit, ...linked.map((row) => row._id)]).size;
}

module.exports = { publicBoardId, persistedBoardId, getDefaultBoard, ownedBoard, boardEntries, formatBoard, formatBoards, savedAlbums, albumBoards, savedUserCount, liveMembershipStages };
