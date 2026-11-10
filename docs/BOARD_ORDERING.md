# Ordered and ranked boards

A board lists its albums by date added unless its owner switches it to a custom order. A board in custom order can also be shown as a ranked list. The rules live in `routes/utils/boardOrder.js`; the transactional writes are in `routes/utils/boardMutations.js`.

## Storage

The order is stored on the board, not on its memberships. An album can be on a board through an explicit save (`BoardItem`), a listen link (`BoardListen`), or both, and listen-only albums have no `BoardItem` that could hold a position.

| `Board` field | Meaning |
| --- | --- |
| `orderMode` | `added` (default) or `manual`. |
| `displayStyle` | `grid` (default) or `ranked`. A ranked board must be `manual`. |
| `albumOrder` | Internal `AlbumCatalog` `_id` values, at most 100: the ordered block. Present only in manual mode. Never serialized. |

Legacy boards without these fields read as `added` and `grid`. No migration is needed.

## Reading

- **Date order** lists the newest album first, as before.
- **Manual order** lists the `albumOrder` albums that are still on the board, then every other album by `savedAt`, oldest first. Stale and repeated entries are skipped. A newly added album is therefore always last.
- `previewAlbums` (board cards and the profile pin) and public board pages follow the same order, so a "Top 10" board previews its top four.

The saved shelf (`GET /profile/me/saved`) and album save status are unaffected: the order never changes which albums are on a board.

Board summaries add these fields:

| Field | Meaning |
| --- | --- |
| `orderMode`, `displayStyle` | As stored, with the defaults above. |
| `orderedCount` | In manual mode, the number of leading albums the board numbers and its owner can arrange: every album, up to 100. `0` in date order. |
| `orderLimit` | `100`. |
| `revision` | Owner reads only (`GET /boards/:boardId`, `PATCH`, `PUT …/order`): the token a reorder must send back. Public reads never include it. |

Albums carry public `albumId` values only.

## The 100-album limit

The ordered block holds at most 100 albums.

- A board with more than 100 albums cannot switch to custom order. `PATCH` returns `409 BOARD_ORDER_LIMIT`, and nothing in the request is applied.
- A custom-order board that grows past 100 keeps its block. Later albums follow it by `savedAt`, oldest first, and the owner can still reorder within the block or move a later album into it. On those boards `orderedCount` stays `100`; albums after the block are shown without rank numbers.
- Raise the limit only if users ask for it.

## Writing

Every write runs in a transaction that claims the board (`interactionRevision`). Without a transaction-capable MongoDB they return `503 BOARD_WRITE_UNAVAILABLE`.

| Method | Path | Body | Behavior |
| --- | --- | --- | --- |
| `PATCH` | `/boards/:boardId` | Any of `title`, `description`, `orderMode`, `displayStyle` | Switching to `manual` seeds `albumOrder` from the date order the board showed (newest first). Switching to `added` drops `albumOrder` and, unless the request says otherwise, sets `displayStyle` to `grid`. `displayStyle: "ranked"` on a board that is not manual returns `400 INVALID_BOARD_ORDER`. Returns the board summary with `revision`. |
| `PUT` | `/boards/:boardId/order` | `{ albumIds, revision }` | Replaces the order of a manual board. On a board of 100 albums or fewer, `albumIds` must list exactly its albums. On a larger board it must list exactly 100 of them, which become the block. Returns the whole board with `albums` and the new `revision`. |

A reorder fails with `409 BOARD_CHANGED`, and changes nothing, when `revision` is stale or `albumIds` does not match the board. The client refetches the board; reorders are never retried automatically. A body that is not `{ albumIds, revision }`, repeats an album, lists more than 100 albums, or targets a board in date order returns `400 INVALID_BOARD_ORDER`. Both routes share the `boardMutation` rate limit (60 per 10 minutes per user), applied after authentication.

### Membership changes

Saving an album, removing an album, attaching or detaching a listen, logging a listen to a board, and deleting a listen reconcile the stored order of every affected manual board inside the same transaction:

- On a board of 100 albums or fewer, `albumOrder` becomes the whole displayed order. A new album lands at the bottom, and an album that left and later returns counts as new.
- On a larger board, `albumOrder` only loses albums that left. New albums are not added to the block, even if a removal left it short, so a new album never jumps ahead of older albums after the block.

Deleting a board deletes its order with it.

## Frontend

- **Board page, owner:** an Order control (Date added or Custom order) and a "Show as a ranked list" toggle. Turning the toggle on also switches the board to custom order. On a board with more than 100 albums in date order, both are disabled with a short explanation.
- In custom order the sort menu adds "Custom order" as its default. With that sort and no search or filter, the owner can drag albums in grid or list view, or use the arrow buttons (← → in the grid, ↑ ↓ in the list). A Save / Discard bar holds the new order. Renaming, editing the description, removing an album, keeping it saved, managing listens, changing the order settings, and deleting the board wait until the draft is saved or discarded. Rearranging and other writes wait while a mutation, listen dialog, or refresh is pending. Metadata saves refresh the full album list and revision together before arranging resumes. A `BOARD_CHANGED` response reloads the board and discards the draft only when that reload succeeds. If it fails, the draft stays visible, writes remain disabled, and Refresh board lets the owner retry loading the latest state without retrying the rejected write.
- Past 100 albums, a marker shows where the ordered block ends. Moving an album above it pushes the block's last album out, matching what the save will store. An overflow album's earlier/up arrow moves it directly to the block's last position (with the accessible label “Move [album] into custom order”); it can then move earlier one position at a time. Later/down is disabled in overflow because that section follows date order.
- **Ranked boards** open as a list and show rank numbers on owner and public pages while sorted by custom order. Board cards and the profile pin show a "Ranked list" label.
- A visual treatment for the top three, such as larger covers, is a planned later change.

## Tests

- `tests/boardOrder.test.js`: reading order, reconciliation (missing, extra, and duplicate IDs; listen-only albums appended oldest first; the block on a larger board), reorder matching, input validation, settings rules, and the model.
- `tests/boardOrderClient.test.js`: overflow promotion and normalization against the server's display order.
- `tests/boardDetailPage.test.js`: metadata snapshot/revision coupling, dirty-draft protection, delayed writes and refreshes, listen-modal gating, repeated saves, navigation, and conflict recovery failures/retries. These execute the real page handlers; rendered controls and mouse dragging are checked separately in browser QA.
- `tests/boardPublicIdContract.test.js`: ordered reads without catalog IDs, reorder validation before any claim, and the stale-revision `409`.
- `tests/boardOrder.integration.test.js` (replica set): switching and reordering, a remove racing a reorder, two concurrent reorders, the saved-shelf union, board deletion, listen links, the limit on switching, a board growing past the limit, and public reads without Mongo IDs.

## Notes on board albums

Each visible album can have one optional note for this board, including albums
present only through linked diary listens. Notes are separate from album reviews
and individual listens. The owner edits them inline in grid or list view with an
explicit Save/Cancel action. Other viewers see the plain text whenever the
profile's existing privacy rules allow them to read the board.

`PATCH /boards/:boardId/albums/:albumId/note` accepts exactly `{ note, revision }`.
`boardId` and `albumId` are public UUIDs; the owner's `default` alias also works.
The note is normalized to NFC, whitespace is collapsed to a single space, and
leading/trailing whitespace is removed. The limit is 100 Unicode grapheme
clusters, counted identically in client/server helpers; emoji and combining
characters do not consume their UTF-16 code-unit length. Blank text clears it.
Invalid text/revisions return `400 INVALID_BOARD_NOTE`. Unknown fields use the
existing request-validation error. Non-owners cannot mutate the board.

Notes use `BoardItemNote`, uniquely keyed by internal board/catalog-album IDs.
They never create membership, change saved dates/order, or make a listen-only
album explicitly saved. The transaction claims the board at the submitted
revision, verifies live membership, writes the note, and returns the complete
board plus its revision from the same snapshot. Stale edits return
`409 BOARD_CHANGED`; the UI refreshes while keeping the draft for review and an
explicit retry. Missing membership returns `404 BOARD_ITEM_NOT_FOUND`.

Removing an album clears its note. Detaching/deleting the last linked listen
also clears it unless an explicit save remains. Board/account deletion removes
notes transactionally. Re-adding an album does not restore an old note. Notes
are loaded only for live memberships in bounded batches, and are excluded from
the cross-board saved shelf and board preview album metadata.

Existing records need no data backfill: a missing note is returned as an empty
string. Startup initializes the new collection/index before serving writes.
Board CSV/JSON exports include the per-album `note` field, with the existing CSV
formula protection. See [data export](DATA_EXPORT.md).
