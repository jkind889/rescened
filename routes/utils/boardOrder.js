const { fail, uuid } = require("./diaryValidation");

// A manual board keeps an ordered block of at most this many albums. Albums
// past it follow by savedAt, oldest first. See docs/BOARD_ORDERING.md.
const BOARD_ORDER_LIMIT = 100;
const ORDER_MODES = ["added", "manual"];
const DISPLAY_STYLES = ["grid", "ranked"];

function invalid(message) { return fail(400, "INVALID_BOARD_ORDER", message); }
function changed() { return fail(409, "BOARD_CHANGED", "This board changed somewhere else. Refresh and try again."); }

function time(value) { return new Date(value).getTime() || 0; }
function byNewest(a, b) { return time(b.savedAt) - time(a.savedAt) || a.albumId.localeCompare(b.albumId); }
function byOldest(a, b) { return time(a.savedAt) - time(b.savedAt) || a.albumId.localeCompare(b.albumId); }

function orderMode(board) { return board?.orderMode === "manual" ? "manual" : "added"; }
function displayStyle(board) { return orderMode(board) === "manual" && board?.displayStyle === "ranked" ? "ranked" : "grid"; }

// entries: one per board album, { key: String(albumCatalogId), albumId, savedAt }.
// Date order lists the newest first. Manual order lists the albumOrder entries
// that are still on the board, then every other album by savedAt, oldest
// first, so a newly added album is always last. Stale and repeated albumOrder
// entries are skipped.
function orderEntries(entries, board) {
  if (orderMode(board) !== "manual") return [...entries].sort(byNewest);
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const placed = new Set();
  const block = [];
  for (const id of board.albumOrder || []) {
    const key = String(id);
    const entry = byKey.get(key);
    if (!entry || placed.has(key) || block.length === BOARD_ORDER_LIMIT) continue;
    placed.add(key);
    block.push(entry);
  }
  return [...block, ...entries.filter((entry) => !placed.has(entry.key)).sort(byOldest)];
}

// The albums a manual board numbers and lets the owner arrange: all of them up
// to the limit, otherwise the first BOARD_ORDER_LIMIT of the displayed order.
function orderedCount(board, itemCount) {
  return orderMode(board) === "manual" ? Math.min(itemCount, BOARD_ORDER_LIMIT) : 0;
}

// The albumOrder to store after any membership change on a manual board. On a
// board of BOARD_ORDER_LIMIT or fewer it is the whole displayed order, so a new
// album lands at the bottom and nothing visibly moves. On a larger board the
// block only loses albums that left; new albums follow it by savedAt.
function reconciledOrder(entries, board) {
  if (entries.length <= BOARD_ORDER_LIMIT) return orderEntries(entries, board).map((entry) => entry.key);
  const keys = new Set(entries.map((entry) => entry.key));
  const seen = new Set();
  return (board.albumOrder || []).map(String).filter((key) => {
    if (!keys.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, BOARD_ORDER_LIMIT);
}

// The albumOrder that switching to manual mode seeds: the date order the board
// showed until now. Larger boards cannot switch.
function seededOrder(entries) {
  if (entries.length > BOARD_ORDER_LIMIT) {
    throw fail(409, "BOARD_ORDER_LIMIT", `Custom order works on boards of up to ${BOARD_ORDER_LIMIT} albums.`);
  }
  return orderEntries(entries, { orderMode: "added" }).map((entry) => entry.key);
}

// A reorder must name exactly the board's albums, or on a larger board exactly
// BOARD_ORDER_LIMIT of them, so a stale copy never drops or invents an album.
function requestedOrder(entries, albumIds) {
  const expected = Math.min(entries.length, BOARD_ORDER_LIMIT);
  if (albumIds.length !== expected) throw changed();
  const byAlbumId = new Map(entries.map((entry) => [entry.albumId, entry.key]));
  return albumIds.map((albumId) => {
    const key = byAlbumId.get(albumId);
    if (!key) throw changed();
    return key;
  });
}

function orderInput(body) {
  const value = body === undefined ? {} : body;
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((key) => !["albumIds", "revision"].includes(key))) {
    throw invalid("A reorder takes only albumIds and revision");
  }
  if (!Array.isArray(value.albumIds) || value.albumIds.length > BOARD_ORDER_LIMIT) {
    throw invalid(`albumIds must be a list of at most ${BOARD_ORDER_LIMIT} albums`);
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw invalid("revision must be a non-negative integer");
  const albumIds = value.albumIds.map((id) => uuid(id, "album"));
  if (new Set(albumIds).size !== albumIds.length) throw invalid("albumIds must not repeat an album");
  return { albumIds, revision: value.revision };
}

// Resolves a settings change against the board's current settings. Leaving
// manual order also drops the ranked display, unless the request asks for it,
// which is rejected: a ranked board must be in manual order.
function settingsInput(input) {
  if (input.orderMode !== undefined && !ORDER_MODES.includes(input.orderMode)) throw invalid("orderMode must be added or manual");
  if (input.displayStyle !== undefined && !DISPLAY_STYLES.includes(input.displayStyle)) throw invalid("displayStyle must be grid or ranked");
  return { orderMode: input.orderMode, displayStyle: input.displayStyle };
}

function nextSettings(board, input) {
  settingsInput(input);
  const mode = input.orderMode ?? orderMode(board);
  let style = input.displayStyle ?? displayStyle(board);
  if (input.displayStyle === undefined && mode !== "manual") style = "grid";
  if (style === "ranked" && mode !== "manual") throw invalid("A ranked board must use custom order");
  return { orderMode: mode, displayStyle: style };
}

module.exports = {
  BOARD_ORDER_LIMIT, ORDER_MODES, DISPLAY_STYLES,
  orderMode, displayStyle, orderEntries, orderedCount, reconciledOrder, seededOrder, requestedOrder, orderInput, settingsInput, nextSettings,
};
