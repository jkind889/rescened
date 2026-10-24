# Listen-next queue

Each profile has an ordered queue of up to 15 albums the user plans to play next. It replaces the single "listening next" album. The queue is separate from boards: queuing an album does not save it, and it does not count toward the saved shelf. The logic lives in `routes/utils/listenQueue.js`.

## Storage

The queue is embedded in `UserProfile`:

| Field | Meaning |
| --- | --- |
| `listenQueue` | Ordered `[{ albumCatalogId, addedAt }]`, at most 15 distinct albums. |
| `queueRevision` | Internal concurrency token. `0` (or missing) means the queue has never been written. |
| `listeningNextAlbum` | Legacy single album. Read as the queue until the first queue write. |

Every queue change is a single conditional update on `queueRevision`, so no transaction is needed except when a listen removes an album (below).

**Legacy compatibility.** While `queueRevision` is `0`, reads treat `listeningNextAlbum` as a one-album queue, with the profile's `updatedAt` as its `addedAt`. The first queue write stores that album in `listenQueue`, clears `listeningNextAlbum`, and sets `queueRevision` to `1`. No migration script is needed. `PUT /profile/me` no longer reads or writes `listeningNextAlbum`, so saving the profile never clears an unmigrated album.

## Endpoints

| Method | Path | Auth | Body | Behavior |
| --- | --- | --- | --- | --- |
| `GET` | `/profile/me/queue` | Required | — | The owner's queue, with `revision`. |
| `GET` | `/profile/:userId/queue` | Optional | — | Another user's queue, without `revision`. A private profile returns `403` with `isPrivate: true` to everyone but its owner. |
| `POST` | `/profile/me/queue` | Required | `{ albumId, position? }` | Without `position`, adds the album at the bottom, or leaves it in place if it is already queued. With `top` or `bottom`, adds or moves it there; a moved album keeps its `addedAt`. `409 QUEUE_FULL` when adding a 16th album. |
| `PUT` | `/profile/me/queue` | Required | `{ albumIds, revision }` | Replaces the order. `albumIds` must list exactly the current albums and `revision` must match; otherwise `409 QUEUE_CHANGED` and nothing changes. |
| `DELETE` | `/profile/me/queue/:albumId` | Required | — | Removes the album. Removing an album that isn't queued (or doesn't exist) succeeds without a write. |

Every endpoint returns the whole queue:

```json
{
  "albums": [{ "albumId": "…", "title": "…", "artistDisplayName": "…", "cover": "…", "addedAt": "2026-10-16T12:00:00.000Z" }],
  "count": 1,
  "limit": 15,
  "revision": 4
}
```

Albums carry public `albumId` values and catalog display fields only. A queued album that no longer resolves in `AlbumCatalog` is left out of reads and dropped on the next write.

`POST` and `DELETE` re-read and retry internally (up to three attempts) when a concurrent write moves `queueRevision`. `PUT` never retries, because it was built from a specific order; a stale reorder returns `409` and the client refetches. Unknown body fields return `400 INVALID_QUEUE_REQUEST`. See [error codes](ERROR_CODES.md#listen-queue).

The mutations share the `queueMutation` rate limit (60 per 10 minutes per user), applied after authentication.

### Profile responses

`GET /profile/me`, `GET /profile/:userId`, and the profile `PUT`/`PATCH` responses include:

| Field | Meaning |
| --- | --- |
| `upNext` | The first three queued albums. |
| `queueCount` | The number of queued albums. |
| `listeningNextAlbum` | The first queued album, or `null`. Kept for compatibility. |

A private profile viewed by someone else returns `upNext: []` and `queueCount: 0`.

## Removal when a listen is logged

Creating a listen for a queued album removes it from the queue, inside the transaction that creates the listen. This covers manual listens (`POST /diary`) and automatic listens published from Last.fm when auto-diary is on (`createAutomaticListen`). A listen for an album that isn't queued leaves `queueRevision` unchanged. If the profile has not been migrated yet and the listened album is its legacy `listeningNextAlbum`, the listen clears it and marks the queue as written.

## Frontend

- **Album page:** "Add to queue" (no position) and "Listen next" (top). When the album is queued, the actions show its position, remove it, or move it to the top. Logging a listen from the page refreshes the actions.
- **Pick results** (Boards and board pages): "Add to queue" adds the picked album to the bottom without a position, so an album that is already queued keeps its place.
- **Home and own profile:** the queue editor. It supports drag reordering, ↑/↓ buttons, and Save / Discard for the new order. Removal applies immediately and is disabled while an unsaved order is pending. On the profile, the "Up Next" pin card follows the editor's changes.
- **Public profiles:** an "Up next" pin card and a read-only list of the first three, with "See all" when there are more.
- A `QUEUE_CHANGED` response reloads the queue once. Writes are never retried automatically.

Edit Profile no longer has a listening-next picker.

## Tests

- `tests/listenQueue.test.js`: input validation, placement and the cap, reorder matching, and the legacy fallback.
- `tests/listenQueue.integration.test.js` (replica set): the HTTP contract, the cap, stale and concurrent reorders, manual and automatic listen removal, legacy migration, and privacy.
