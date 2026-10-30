const { toCsv } = require("./csv");

// Bump when a field is renamed, removed, or changes meaning. See docs/DATA_EXPORT.md.
const SCHEMA_VERSION = 1;
const DATASETS = ["reviews", "listens", "boards"];
const FORMATS = ["csv", "json"];
const CONTENT_TYPES = { csv: "text/csv; charset=utf-8", json: "application/json; charset=utf-8" };

const FIELDS = {
  reviews: ["reviewId", "albumId", "albumTitle", "albumArtist", "rating", "reviewText", "reviewedAt", "editedAt"],
  listens: ["listenId", "albumId", "albumTitle", "albumArtist", "listenedOn", "source", "loggedAt"],
  boards: ["boardId", "boardTitle", "boardDescription", "isDefault", "orderMode", "displayStyle", "position", "albumId", "albumTitle", "albumArtist", "savedAt", "explicitlySaved"],
};
const BOARD_ALBUM_FIELDS = FIELDS.boards.slice(6);

function iso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// album is a normalized AlbumCatalog record, or null when it no longer exists.
function albumFields(album) {
  return { albumId: album?.albumId || null, albumTitle: album?.title || "", albumArtist: album?.artistDisplayName || "" };
}

function reviewRow({ review, album }) {
  return {
    reviewId: review.reviewId, ...albumFields(album), rating: review.rating, reviewText: review.reviewText || "",
    reviewedAt: iso(review.date), editedAt: iso(review.editedAt),
  };
}

function listenRow({ listen, album }) {
  return { listenId: listen.listenId, ...albumFields(album), listenedOn: listen.listenedOn, source: listen.source || "manual", loggedAt: iso(listen.createdAt) };
}

// board is a formatBoards payload with albums in display order.
function boardItem(board) {
  return {
    boardId: board.boardId, boardTitle: board.title || "", boardDescription: board.description || "",
    isDefault: Boolean(board.isDefault), orderMode: board.orderMode, displayStyle: board.displayStyle,
    albums: (board.albums || []).map((album, index) => ({
      position: index + 1, ...albumFields(album), savedAt: iso(album.savedAt), explicitlySaved: Boolean(album.explicitlySaved),
    })),
  };
}

// One CSV row per membership; an empty board keeps one row with blank album columns.
function boardCsvRows(items) {
  const blank = Object.fromEntries(BOARD_ALBUM_FIELDS.map((field) => [field, null]));
  return items.flatMap(({ albums, ...board }) => (albums.length ? albums : [blank]).map((album) => ({ ...board, ...album })));
}

// collected: { items, omitted } from collect.js. The JSON envelope carries
// omitted only for listens, where missing albums are left out.
function serializeExport(dataset, format, collected, exportedAt = new Date()) {
  const items = dataset === "reviews" ? collected.items.map(reviewRow)
    : dataset === "listens" ? collected.items.map(listenRow)
      : collected.items.map(boardItem);
  if (format === "csv") {
    const rows = dataset === "boards" ? boardCsvRows(items) : items;
    return { contentType: CONTENT_TYPES.csv, body: toCsv(FIELDS[dataset], rows) };
  }
  const payload = {
    schemaVersion: SCHEMA_VERSION, dataset, exportedAt: iso(exportedAt),
    ...(dataset === "listens" ? { omitted: collected.omitted || 0 } : {}),
    items,
  };
  return { contentType: CONTENT_TYPES.json, body: `${JSON.stringify(payload, null, 2)}\n` };
}

module.exports = { SCHEMA_VERSION, DATASETS, FORMATS, FIELDS, serializeExport };
