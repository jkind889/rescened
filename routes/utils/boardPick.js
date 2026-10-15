const crypto = require("node:crypto");
const AlbumCatalog = require("../../models/AlbumCatalog");
const BoardItem = require("../../models/BoardItem");
const Listen = require("../../models/Listen");
const Review = require("../../models/Reviews");
const { normalizeCatalogAlbum } = require("./albumCatalog");
const { ownedBoard } = require("./boardLibrary");
const { fail } = require("./diaryValidation");

// The pick card shows only these; tracks and references stay on the album page.
function pickSummary(album) {
  const { albumId, title, artistDisplayName, releaseYear, cover } = album;
  return { albumId, title, artistDisplayName, releaseYear, cover };
}

// Explicitly saved albums the user has neither logged nor reviewed. Albums that
// appear on a board only through listens are played by definition, so only
// BoardItem saves count. match may narrow the saves to one board.
async function unplayedSavedIds(userId, match = { userId }) {
  const [saved, listened, reviewed] = await Promise.all([
    BoardItem.distinct("albumCatalogId", match),
    Listen.distinct("albumCatalogId", { userId }),
    Review.distinct("albumCatalogId", { userId }),
  ]);
  const played = new Set([...listened, ...reviewed].map(String));
  return saved.filter((id) => !played.has(String(id)));
}

// Picks one saved, unplayed album at random. boardId narrows the pool to one board.
async function pickUnplayedAlbum(userId, boardId = null) {
  const match = { userId };
  if (boardId) {
    const board = await ownedBoard(userId, boardId, false);
    if (!board) throw fail(404, "BOARD_NOT_FOUND", "Board not found");
    match.boardId = board._id;
  }
  const candidates = await unplayedSavedIds(userId, match);
  // A candidate can point at a catalog row that no longer resolves; try others
  // in random order instead of reporting an empty shelf.
  while (candidates.length) {
    const [id] = candidates.splice(crypto.randomInt(candidates.length), 1);
    const album = normalizeCatalogAlbum(await AlbumCatalog.findById(id));
    if (album?.albumId) return { album: pickSummary(album), candidateCount: candidates.length + 1 };
  }
  return { album: null, candidateCount: 0 };
}

module.exports = { pickUnplayedAlbum, unplayedSavedIds };
