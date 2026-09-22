const Board = require("../../models/Board");
const BoardItem = require("../../models/BoardItem");
const BoardListen = require("../../models/BoardListen");
const { normalizeCatalogAlbum } = require("./albumCatalog");
const { fail } = require("./diaryValidation");

function publicBoardId(value) {
  const id = String(value || "").trim().toLowerCase();
  return Board.isBoardId(id) ? id : "";
}

function persistedBoardId(board) {
  const id = publicBoardId(board?.boardId);
  if (!id) throw fail(500, "BOARD_ID_INTEGRITY_ERROR", "Board is missing a valid public identifier");
  return id;
}

async function getDefaultBoard(userId) {
  const existing = await Board.findOne({ userId, isDefault: true });
  if (existing) return existing;
  try { return await Board.create({ userId, title: "Saved albums", isDefault: true }); }
  catch (error) {
    if (error.code === 11000) return Board.findOne({ userId, isDefault: true });
    throw error;
  }
}

async function ownedBoard(userId, boardId, createDefault = true) {
  if (String(boardId).trim().toLowerCase() === "default") {
    return createDefault ? getDefaultBoard(userId) : Board.findOne({ userId, isDefault: true });
  }
  const id = publicBoardId(boardId);
  return id ? Board.findOne({ userId, boardId: id }) : null;
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

async function linkedAlbums(match) {
  return BoardListen.aggregate([
    ...liveMembershipStages(match),
    { $group: {
      _id: { board: "$boardId", album: "$albumCatalogId", user: "$userId" },
      savedAt: { $min: "$addedAt" }, listenCount: { $sum: 1 }, latestListenedOn: { $max: "$listen.listenedOn" },
    } },
    { $lookup: { from: "albumcatalogs", localField: "_id.album", foreignField: "_id", as: "album" } },
    { $unwind: "$album" },
  ]);
}

async function collectionAlbums(match) {
  const [saves, linked] = await Promise.all([
    BoardItem.find(match).populate("albumCatalogId").sort({ savedAt: -1 }),
    linkedAlbums(match),
  ]);
  const albums = new Map();
  for (const row of linked) {
    const album = normalizeCatalogAlbum(row.album);
    if (!album?.albumId) continue;
    albums.set(`${row._id.board}:${album.albumId}`, {
      ...album, userId: row._id.user, savedAt: row.savedAt,
      listenCount: row.listenCount, latestListenedOn: row.latestListenedOn, explicitlySaved: false,
    });
  }
  for (const row of saves) {
    const album = normalizeCatalogAlbum(row.albumCatalogId);
    if (!album?.albumId) continue;
    const key = `${row.boardId}:${album.albumId}`;
    const linkedAlbum = albums.get(key);
    albums.set(key, {
      ...album, userId: row.userId, savedAt: row.savedAt,
      listenCount: linkedAlbum?.listenCount || 0,
      latestListenedOn: linkedAlbum?.latestListenedOn || null, explicitlySaved: true,
    });
  }
  return [...albums.values()].sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt) || a.albumId.localeCompare(b.albumId));
}

async function formatBoard(board, includeAlbums = false) {
  const albums = await collectionAlbums({ boardId: board._id });
  return {
    boardId: persistedBoardId(board), userId: board.userId, title: board.title,
    isDefault: Boolean(board.isDefault), createdAt: board.createdAt, updatedAt: board.updatedAt,
    itemCount: albums.length, listenCount: albums.reduce((sum, album) => sum + album.listenCount, 0),
    previewAlbums: albums.slice(0, 4), ...(includeAlbums ? { albums } : {}),
  };
}

async function savedAlbums(userId) {
  const rows = await collectionAlbums({ userId });
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

module.exports = { publicBoardId, persistedBoardId, getDefaultBoard, ownedBoard, formatBoard, savedAlbums, albumBoards, savedUserCount };
