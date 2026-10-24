import { API_BASE_URL } from "../../config/api";
import { getApiErrorMessage } from "../../utils/apiErrors";

// Matches the server's BOARD_ORDER_LIMIT; boards report their own orderLimit.
export const DEFAULT_ORDER_LIMIT = 100;

export function orderLimitOf(board) {
  return Number(board?.orderLimit) || DEFAULT_ORDER_LIMIT;
}

export function sameOrder(first, second) {
  return first.length === second.length && first.every((albumId, index) => albumId === second[index]);
}

// Overflow is date-sorted, so a one-place move there would be undone. Promote
// an overflow album directly into the last custom position instead.
export function earlierOrderTarget(index, limit) {
  return Math.min(index - 1, limit - 1);
}

// Past the limit only the first orderLimit albums keep a custom position; the
// rest follow by date added, oldest first, as the server lists them. Applying
// that after every move keeps the draft identical to what a save will show,
// so dragging an album into the block pushes the block's last album out.
export function normalizeDraft(order, albumsById, limit) {
  if (order.length <= limit) return order;
  const savedAt = (albumId) => new Date(albumsById.get(albumId)?.savedAt || 0).getTime();
  const rest = order.slice(limit).sort((a, b) => savedAt(a) - savedAt(b) || a.localeCompare(b));
  return [...order.slice(0, limit), ...rest];
}

// Rank numbers by albumId for the albums inside the ordered block.
export function rankMap(order, limit) {
  return new Map(order.slice(0, limit).map((albumId, index) => [albumId, index + 1]));
}

async function failure(response, fallback) {
  const data = await response.clone().json().catch(() => ({}));
  const error = new Error(await getApiErrorMessage(response, fallback));
  error.status = response.status;
  error.code = data.code || "";
  return error;
}

async function boardWrite(getToken, path, method, body, fallback) {
  const token = await getToken();
  const response = await fetch(`${API_BASE_URL}/boards/${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await failure(response, fallback);
  return response.json();
}

// Returns the whole board in its new order, with the next revision.
export function saveBoardOrder(getToken, board, albumIds) {
  return boardWrite(getToken, `${board.boardId}/order`, "PUT", { albumIds, revision: board.revision }, "Could not save the new order.");
}

// orderMode and/or displayStyle. Returns the board summary without albums.
export function saveBoardSettings(getToken, board, settings) {
  return boardWrite(getToken, board.boardId, "PATCH", settings, "Could not update how this board is ordered.");
}
