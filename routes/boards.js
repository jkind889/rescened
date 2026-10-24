const express = require("express");
const { getAuth } = require("@clerk/express");
const Board = require("../models/Board");
const { findAlbumByPublicId } = require("./utils/albumCatalog");
const { albumSaveRateLimit, boardMutationRateLimit, diaryMutationRateLimit } = require("./utils/rateLimit");
const { fail, fields } = require("./utils/diaryValidation");
const { getDefaultBoard, ownedBoard, formatBoard, albumBoards, publicBoardId } = require("./utils/boardLibrary");
const { saveAlbum, removeAlbum, deleteBoard, setMembership, updateBoard, reorderBoard } = require("./utils/boardMutations");
const { orderInput, settingsInput } = require("./utils/boardOrder");
const { listListens } = require("./utils/listeningDiary");
const { pickUnplayedAlbum } = require("./utils/boardPick");

const router = express.Router();

function auth(req, res, next) {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  req.userId = userId;
  next();
}
const MAX_DESCRIPTION_LENGTH = 280;
function title(value) { return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : ""; }
// Descriptions keep line breaks but drop trailing spaces and runs of blank lines.
function description(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw fail(400, "INVALID_BOARD_DESCRIPTION", "Board description must be text");
  const text = value.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trimEnd()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length > MAX_DESCRIPTION_LENGTH) throw fail(400, "INVALID_BOARD_DESCRIPTION", "Board description must be 280 characters or fewer");
  return text;
}
function body(req, allowed) {
  const value = req.body === undefined ? {} : req.body;
  if (value && (Object.hasOwn(value, "boardId") || Object.hasOwn(value, "_id"))) {
    throw fail(400, "INVALID_BOARD_ID", "boardId is server-generated");
  }
  fields(value, allowed);
  return value;
}
function target(req) {
  const id = String(req.params.boardId || "").trim().toLowerCase();
  if (id !== "default" && !publicBoardId(id)) throw fail(404, "BOARD_NOT_FOUND", "Board not found");
  return id;
}
function sendError(res, error, message) {
  res.status(error.status || 500).json({ error: error.status ? error.message : message, ...(error.status && error.code ? { code: error.code } : {}) });
}

router.get("/", auth, async (req, res) => {
  try {
    await getDefaultBoard(req.userId);
    const boards = await Board.find({ userId: req.userId }).sort({ isDefault: -1, updatedAt: -1 });
    res.json(await Promise.all(boards.map((board) => formatBoard(board))));
  } catch (error) { sendError(res, error, "Failed to fetch boards"); }
});

router.post("/", auth, async (req, res) => {
  try {
    const input = body(req, ["title", "description"]);
    const boardTitle = title(input.title);
    if (!boardTitle || boardTitle.length > 80) return res.status(400).json({ error: "Board title must be 1–80 characters" });
    const boardDescription = description(input.description) || "";
    res.status(201).json(await formatBoard(await Board.create({ userId: req.userId, title: boardTitle, description: boardDescription })));
  } catch (error) { sendError(res, error, "Failed to create board"); }
});

// Registered before /:boardId so "pick" is never read as a board ID.
router.get("/pick", auth, async (req, res) => {
  try {
    fields(req.query, ["boardId"]);
    const boardId = req.query.boardId === undefined ? null : target({ params: { boardId: req.query.boardId } });
    res.json(await pickUnplayedAlbum(req.userId, boardId));
  } catch (error) { sendError(res, error, "Failed to pick an album"); }
});

router.get("/album/:albumId", auth, async (req, res) => {
  try {
    const album = await findAlbumByPublicId(req.params.albumId);
    const boards = await albumBoards(req.userId, album._id);
    res.json({ albumId: album.albumId, saved: boards.length > 0, boards });
  } catch (error) { sendError(res, error, "Failed to check board saves"); }
});

router.get("/:boardId", auth, async (req, res) => {
  try {
    const board = await ownedBoard(req.userId, req.params.boardId);
    if (!board) return res.status(404).json({ error: "Board not found" });
    res.json(await formatBoard(board, { albums: true, revision: true }));
  } catch (error) { sendError(res, error, "Failed to fetch board"); }
});

// Accepts any of title, description, orderMode, and displayStyle. Omitted
// fields stay unchanged. Whether the order settings fit the board is checked
// against it inside the update's transaction.
router.patch("/:boardId", auth, boardMutationRateLimit, async (req, res) => {
  try {
    const input = body(req, ["title", "description", "orderMode", "displayStyle"]);
    const hasTitle = input.title !== undefined;
    const boardTitle = title(input.title);
    if (hasTitle && (!boardTitle || boardTitle.length > 80)) return res.status(400).json({ error: "Board title must be 1–80 characters" });
    const boardDescription = description(input.description);
    const settings = settingsInput(input);
    if (!hasTitle && boardDescription === undefined && settings.orderMode === undefined && settings.displayStyle === undefined) {
      throw fail(400, "INVALID_DIARY_REQUEST", "Board update must include a title, description, or order setting");
    }
    const boardId = target(req);
    await updateBoard(req.userId, boardId, { title: hasTitle ? boardTitle : undefined, description: boardDescription, ...settings });
    res.json(await formatBoard(await ownedBoard(req.userId, boardId), { revision: true }));
  } catch (error) { sendError(res, error, "Failed to update board"); }
});

// Replaces a manual board's order and returns the whole board in it.
router.put("/:boardId/order", auth, boardMutationRateLimit, async (req, res) => {
  try {
    const boardId = target(req);
    await reorderBoard(req.userId, boardId, orderInput(req.body));
    res.json(await formatBoard(await ownedBoard(req.userId, boardId), { albums: true, revision: true }));
  } catch (error) { sendError(res, error, "Failed to reorder board"); }
});

router.delete("/:boardId", auth, async (req, res) => {
  try {
    body(req, []);
    await deleteBoard(req.userId, target(req));
    res.json({ message: "Board deleted" });
  } catch (error) { sendError(res, error, "Failed to delete board"); }
});

router.post("/:boardId/albums", auth, albumSaveRateLimit, async (req, res) => {
  try {
    const input = body(req, ["albumId"]);
    const album = await findAlbumByPublicId(input.albumId);
    const board = await saveAlbum(req.userId, target(req), album._id);
    const formatted = await formatBoard(board, { albums: true });
    const { albums, ...summary } = formatted;
    res.status(201).json({ board: summary, album: albums.find((item) => item.albumId === album.albumId) || null });
  } catch (error) { sendError(res, error, "Failed to save album to board"); }
});

router.delete("/:boardId/albums/:albumId", auth, async (req, res) => {
  try {
    body(req, []);
    const album = await findAlbumByPublicId(req.params.albumId);
    await removeAlbum(req.userId, target(req), album._id);
    res.json({ message: "Album removed from board" });
  } catch (error) { sendError(res, error, "Failed to remove album from board"); }
});

router.get("/:boardId/albums/:albumId/listens", auth, async (req, res) => {
  try { res.json(await listListens(req.userId, req.query, { boardId: target(req), albumId: req.params.albumId })); }
  catch (error) { sendError(res, error, "Failed to fetch listening dates"); }
});

for (const [method, attached] of [["put", true], ["delete", false]]) {
  router[method]("/:boardId/listens/:listenId", auth, diaryMutationRateLimit, async (req, res) => {
    try {
      body(req, []);
      await setMembership(req.userId, target(req), req.params.listenId, attached);
      res.json({ message: attached ? "Listen added to board" : "Listen removed from board" });
    } catch (error) { sendError(res, error, "Failed to update board listen"); }
  });
}

module.exports = router;
