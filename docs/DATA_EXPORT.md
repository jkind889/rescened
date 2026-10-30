# Data export

Signed-in users can download their own reviews, diary listens, and boards as CSV or JSON. The feature is off until `DATA_EXPORT_ENABLED=true` is set on the API. Code: [`routes/dataExport.js`](../routes/dataExport.js) and [`lib/dataExport/`](../lib/dataExport/). The design and its October 30, 2026 decisions are in [the sharing and export plans](SHARING_AND_EXPORT_PLANS.md).

## Endpoints

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/profile/me/export` | Availability check: `{ datasets, formats }`. Spends no export. The settings page uses it to stay hidden while the flag is off. |
| `GET` | `/profile/me/export/:dataset.:format` | The signed-in user's whole dataset. `dataset` is `reviews`, `listens`, or `boards`; `format` is `csv` or `json`. No query parameters are accepted. |

The router is mounted in `server.js` before `/profile`, so these paths never reach the profile router.

**Access.** Owner-only through Clerk, whatever the profile's `isPrivate` setting. There is no way to export another user's data.

**Order of checks.** Flag (`503 DATA_EXPORT_DISABLED`), then Clerk (`401 UNAUTHORIZED`), then the dataset, format, and query (`400 INVALID_EXPORT_REQUEST`), then the `dataExport` rate limit (`429 RATE_LIMITED` with `Retry-After`). Validation runs before the limit, so a malformed request does not spend one of the ten hourly exports.

**Response.** The body is built in memory and sent once with `Cache-Control: no-store`, so a failure returns clean JSON (`500 EXPORT_FAILED`) instead of a truncated file. Content types are `text/csv; charset=utf-8` and `application/json; charset=utf-8`. There is no `Content-Disposition`: the client names the file (`rescened-reviews-2026-10-30.csv`, using the local date).

**Limits.** 10 exports per hour per user, in memory per API instance (see the [rate-limit reference](ERROR_CODES.md#rate-limit-reference)). Above 50,000 rows in one dataset the request fails with `413 EXPORT_TOO_LARGE`; background export jobs are deferred until someone reaches the cap.

## Reading the data

- Reviews and listens are read with one cursor per request in batches of 500, along the existing user indexes (`userId, date, _id` and `userId, listenedOn, createdAt, _id`). Each batch resolves its albums with one `AlbumCatalog` read.
- Boards come from `formatBoards` in `routes/utils/boardLibrary.js`, the same reads the profile's board pages use. Membership (explicit `BoardItem` saves and linked `BoardListen` diary entries), live-membership validation, and manual or date order are therefore identical to what the user sees. Boards are listed default first, then most recently updated.
- Album title and artist come from `AlbumCatalog` at export time, not from when the review or listen was written.

## Formats

### JSON

```json
{ "schemaVersion": 1, "dataset": "reviews", "exportedAt": "2026-10-30T12:00:00.000Z", "items": [] }
```

Listens add `omitted`, the number of listens left out because their album no longer exists. It is present even when zero:

```json
{ "schemaVersion": 1, "dataset": "listens", "exportedAt": "2026-10-30T12:00:00.000Z", "omitted": 0, "items": [] }
```

Boards nest each board's albums in display order under `albums`. JSON keeps text exactly as stored.

### CSV

- Every field is quoted (RFC 4180), embedded quotes are doubled, lines end with CRLF, and the file starts with a UTF-8 byte order mark so Excel detects the encoding.
- A text cell that starts with `=`, `+`, `-`, `@`, tab, or carriage return gets a leading `'`, so spreadsheets do not run it as a formula. Numbers and booleans are never prefixed. The prefix is visible and reversible, and the JSON export is unchanged.
- Boards have one row per membership. An empty board has one row with blank album columns.
- CSV has no envelope, so `schemaVersion`, `exportedAt`, and listens' `omitted` appear only in JSON.

## Field schemas (schema version 1)

Timestamps are ISO-8601 UTC. Missing values are `null` in JSON and blank in CSV. Only public IDs appear; no Mongo `_id`, `albumCatalogId`, `userId`, `interactionRevision`, `creationKey`, `followedReviewFanoutAt`, or `albumOrder`.

### Reviews

Newest first.

| Field | Type | Meaning |
| --- | --- | --- |
| `reviewId` | UUID | Public review ID. |
| `albumId` | UUID or null | Public catalog album ID. Null if the album no longer exists; the review is kept because its text is the user's own. |
| `albumTitle` | text | Current catalog title, blank if the album is gone. |
| `albumArtist` | text | Current catalog `artistDisplayName`, blank if the album is gone. |
| `rating` | number | 1 to 5 in half steps. |
| `reviewText` | text | At most 300 characters. |
| `reviewedAt` | timestamp | When the review was posted. Edits do not change it. |
| `editedAt` | timestamp or null | Last edit of the rating or text. Null means never edited. |

### Listens

Diary entries, newest date first. Last.fm scrobbles are not diary listens and are never exported.

| Field | Type | Meaning |
| --- | --- | --- |
| `listenId` | UUID | Public listen ID. |
| `albumId` | UUID | Public catalog album ID. |
| `albumTitle` | text | Current catalog title. |
| `albumArtist` | text | Current catalog `artistDisplayName`. |
| `listenedOn` | `YYYY-MM-DD` | The diary date, kept as a calendar date with no time zone. |
| `source` | `manual` or `automatic` | `manual` listens were logged by hand; `automatic` ones were created by listening detection (see [automatic album listens](AUTOMATIC_ALBUM_LISTENS.md)). |
| `loggedAt` | timestamp | When the listen was recorded. |

### Boards

| Field | Type | Meaning |
| --- | --- | --- |
| `boardId` | UUID | Public board ID. |
| `boardTitle` | text | Board title. |
| `boardDescription` | text | Board description, blank if none. |
| `isDefault` | boolean | True for the default "Saved albums" board. |
| `orderMode` | `added` or `manual` | Date order or the owner's custom order. See [board ordering](BOARD_ORDERING.md). |
| `displayStyle` | `grid` or `ranked` | How the board is shown. |
| `position` | number | 1-based place in the board's display order. Blank on an empty board's CSV row. |
| `albumId` | UUID | Public catalog album ID. |
| `albumTitle` | text | Current catalog title. |
| `albumArtist` | text | Current catalog `artistDisplayName`. |
| `savedAt` | timestamp | When the album joined the board: the explicit save, or the earliest linked diary listen. |
| `explicitlySaved` | boolean | False when the album is on the board only through linked diary listens. |

In JSON, `position` through `explicitlySaved` are the fields of each entry in a board's `albums`. A user's saved shelf is the deduplicated set of `albumId` values across all their boards.

## Not exported in v1

Track rankings (the first planned addition), album likes, the listen queue, comments you wrote, comments on your reviews, Last.fm scrobbles, and listens whose album no longer exists (counted in `omitted`).

When a field is added, renamed, or removed, update this file and bump `SCHEMA_VERSION` in `lib/dataExport/serializers.js` if existing readers would break.

## Frontend

`frontend/src/features/export/DataExport.jsx` renders on the owner-only `/account/edit` page. It has Reviews, Listens, and Boards rows, each with CSV and JSON buttons, and no helper text. It fetches with the Clerk session token, saves the response through a temporary blob link, reports errors through `getApiErrorMessage` (including the `Retry-After` wait), and hides itself when the availability check or a download returns `503`.

## Rollout

1. Deploy with `DATA_EXPORT_ENABLED` unset and confirm `GET /profile/me/export` returns `503 DATA_EXPORT_DISABLED` and the settings page shows no export section.
2. Set `DATA_EXPORT_ENABLED=true`, restart, and download each dataset in both formats from a test account. Open the CSV files in a spreadsheet and confirm the byte order mark, quoting, and formula prefix behave.
3. To turn exports off again, unset the flag and restart; nothing is stored, so there is nothing to clean up.
