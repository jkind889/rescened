# Rescened

Repeatable local API/database performance tests and their interpretation are documented in [the benchmark guide](./benchmarks/README.md).

Rescened is a community-curated album catalog. Albums, reviews, review comments, boards, listens, and notifications receive domain-specific immutable UUIDs (`albumId`, `reviewId`, `commentId`, `boardId`, `listenId`, and `notificationId`); MongoDB `_id` values remain internal implementation details. Search, album detail, reviews, likes, profiles, activity, boards, and the diary use the local catalog only.

Application, provider, and operator failures are cataloged in the [error and status code reference](./docs/ERROR_CODES.md), including HTTP meanings, rate-limit budgets, report reasons, workflow statuses, and command exit codes.

Future feature ideas and optimizations are tracked in the living [Rescened 2.0 roadmap](./docs/RESCENED_2_0.md).

## Local development

Point the root `.env` file's `MONGO_URI` at a dedicated development database such as `rescened_dev`, using a database user with `readWrite` access only to that database. Do not use production credentials or `readWriteAnyDatabase` for local development. A development database may share the Atlas cluster with production, but it remains an independent copy and shares cluster resources. To refresh it, keep a production dump outside the repository, review a `mongorestore --dryRun` with explicit source-to-development namespace mapping, and restore only into an empty development target. Restart the API after changing `.env` and confirm `/health` reports `status: "ok"`.

Set `MONGO_URI`, `CLERK_SECRET_KEY`, and either `CLERK_PUBLISHABLE_KEY` or `VITE_CLERK_PUBLISHABLE_KEY`. Spotify credentials are not used or required. Set `COMMUNITY_SUBMISSIONS_ENABLED=true` to enable contributor submission mutations and `COMMUNITY_MODERATION_ENABLED=true` to enable moderator commands; both are disabled by default. Set `MODERATOR_USER_IDS` to a comma-separated Clerk allowlist. Start the API with `npm run devStart` and the frontend from `frontend/` with `npm run dev`.

`REVIEW_CURSOR_SECRET` is optional but recommended when review-pagination cursors should be rotated independently of the Clerk secret.

Set `DATA_EXPORT_ENABLED=true` to let signed-in users download their reviews, diary listens, and boards as CSV or JSON from `/account/edit`; it is disabled by default. See [the data export guide](docs/DATA_EXPORT.md).

The database is intentionally empty after the generation-2 cutover. Phase 2 includes contributor and moderator APIs: approval creates, links, or applies an explicit field-level correction to a usable local catalog album inside a Mongo transaction. Approval commands, review interaction mutations (deletion, review likes, and pinning), and review comment writes require a transaction-capable MongoDB replica set or sharded deployment; standalone Mongo remains safe for reads and non-publication moderation commands only. Transaction-unavailable mutations return an action-specific `503` code and do not fall back to partial writes.

## Catalog contract

Catalog responses expose `albumId`, `title`, `artistDisplayName`, `artistCredits`, `releaseType`, release date fields, `releaseYear`, `cover`, `tracks`, `label`, and normalized external references. Album-bearing social records resolve their current metadata from the catalog, so edits to an approved catalog record are reflected in reviews and activity.

Saved albums are the deduplicated union of every board a user owns. Removing an item from one board does not remove it from the saved shelf while another board still contains it; manage membership from board detail pages.

Boards expose `boardId` and notifications expose `notificationId`. Board items and profile pins continue to store internal Board ObjectIds, which are resolved server-side and are never serialized. Because the pre-rollout board and notification datasets were very small, the UUID rollout intentionally deleted every existing board and notification instead of backfilling identifiers. It also deleted the associated board items and cleared every matching profile board pin. This was a one-time completed reset, not an automated migration procedure.

## Listening diary

A listen records an existing catalog album and a calendar date; ratings, reviews, and notes are separate from listens. Multiple intentional listens on the same day are supported. Diary and board-date reads follow profile privacy: public profiles are readable anonymously; private profiles are readable only by their owner, including subsequent pages. Logging for the first time creates a profile if necessary without changing an existing privacy setting.

| Method and endpoint | Contract |
| --- | --- |
| `POST /diary` | Authenticated creation with `{ albumId, listenedOn, timeZone, boardIds? }` and a UUID-v4 `Idempotency-Key` header. Returns a listen with `201`, or `200` for a matching retry. |
| `GET /diary` | Authenticated owner's diary. |
| `PATCH /diary/:listenId` | Owner corrects the date with `{ listenedOn, timeZone }`; returns the updated listen. Album identity is immutable. |
| `DELETE /diary/:listenId` | Owner deletes the listen and all its board memberships. Repeating deletion is a successful no-op. |
| `PUT /boards/:boardId/listens/:listenId` | Owner attaches an existing owned listen idempotently; no body fields. |
| `DELETE /boards/:boardId/listens/:listenId` | Owner detaches a listen from this board; no body fields. Repeating detachment while both parents exist is a successful no-op. |
| `GET /boards/:boardId/albums/:albumId/listens` | Owner reads dates for this album in this board only. |
| `GET /profile/:userId/diary` | Diary read with profile privacy checks. |
| `GET /profile/:userId/boards/:boardId/albums/:albumId/listens` | Board-specific dates with profile privacy checks. |
| `GET /diary/calendar?month=YYYY-MM` | Authenticated owner's listens for one calendar month, grouped by day. |
| `GET /profile/:userId/diary/calendar?month=YYYY-MM` | The same month view with profile privacy checks. |

`listenedOn` is a real `YYYY-MM-DD` calendar date, stored without UTC conversion. Creation and date edits require an IANA `timeZone`, used to reject future dates in that zone. Historical dates are allowed; the frontend should supply the user's local date and timezone explicitly. Creation accepts at most 100 board UUIDs, deduplicates them, and requires ownership of every board. Existing authenticated board paths retain the `default` alias. A standalone listen creates no default board or saved-album membership.

Lists return `{ listens, nextCursor }`. Each listen contains `listenId`, `userId`, `albumId`, current normalized `album` metadata, `listenedOn`, `createdAt`, and `updatedAt`; neither internal Mongo IDs nor other board memberships are exposed. Lists accept `albumId`, `boardId`, inclusive `from`/`to` dates, `limit` (default 20, capped at 50), and an opaque `cursor`. Board/album route parameters fix those filters. Ordering is listening date descending, then creation time descending, then an internal tie-breaker. Cursors are encrypted with a diary-specific key derived from `CLERK_SECRET_KEY` and bound to the target user and filters; changing a filter requires starting a new page sequence. Edits to dates can change ordering, so reload the first page after editing. Missing catalog records are excluded before pagination and board counts.

Calendar reads accept only `month`, which must be a real `YYYY-MM` month; anything else returns `400 INVALID_DIARY_REQUEST` before any query. They return `{ month, total, limit, truncated, days }`, where `days` lists only dates with listens, in ascending order, as `{ date, listens }`. Each listen carries `listenId`, `listenedOn`, `source` (`manual` or `automatic`), and an `album` with only `albumId`, `title`, `artistDisplayName`, and `cover`. A month returns at most `limit` (400) listens, oldest first; `truncated` is `true` when more exist. Listens whose catalog album no longer resolves are dropped before the limit applies, so they never use up the month and `total` counts only the listens returned. Calendar reads use the existing `{ userId, listenedOn }` index.

Boards combine explicit `BoardItem` saves with `BoardListen` memberships. Existing response fields remain, with `listenCount` added to board summaries and `listenCount`, `latestListenedOn` (or `null`), and `explicitlySaved` added to each album. `itemCount` still counts distinct albums; preview covers remain deduplicated. Explicit saves preserve their `savedAt`; listen-only album cards use the earliest remaining membership timestamp. The saved shelf remains the deduplicated union across all boards, using the latest board-level `savedAt`, and album save counts count each user once. Personal and public activity feeds include explicit saves, reviews, and listens. Listen activities expose the public `listenId`, `listenedOn`, and current catalog metadata, ordered by creation time (when logged), rather than the listening date. Date corrections update the displayed listening date without bumping the event; deleting a listen removes it from activity. Board attachments and idempotent retries do not create extra activity. Missing catalog albums are excluded.

Boards have an optional `description` of up to 280 characters, returned on every board summary (an empty string when unset). `POST /boards` accepts `{ title, description? }`. `PATCH /boards/:boardId` accepts any of `title`, `description`, `orderMode`, and `displayStyle`, and leaves omitted fields unchanged. A body with none of them returns `400 INVALID_DIARY_REQUEST`. Custom and ranked order, `PUT /boards/:boardId/order`, and the 100-album limit are described in [ordered and ranked boards](docs/BOARD_ORDERING.md). Descriptions keep line breaks but normalize `\r\n`, trim trailing spaces on each line, and collapse runs of blank lines to one. A non-string or over-long description returns `400 INVALID_BOARD_DESCRIPTION`. Sending `""` clears it.

`GET /boards/pick` (authenticated) picks one random album the owner explicitly saved but has neither logged nor reviewed. It returns `{ album, candidateCount }`, where `album` holds only `albumId`, `title`, `artistDisplayName`, `releaseYear`, and `cover`, or `{ album: null, candidateCount: 0 }` when every saved album has been played. Albums on a board only through listens are never candidates, since a listen means the album was played. Board summaries include `explicitSaveCount`, the number of albums saved on purpose, and the pick control appears only when it is above zero. The optional `boardId` query narrows candidates to one owned board (or `default`); a malformed or unowned board returns `404 BOARD_NOT_FOUND`, and any other query field returns `400 INVALID_DIARY_REQUEST`. Candidates whose catalog record no longer resolves are skipped. `candidateCount` is approximate and is meant for display only.

Removing a listen from one board leaves its diary entry and other memberships intact. Removing an album through `DELETE /boards/:boardId/albums/:albumId` removes both its explicit save and all its listening memberships in that board. Deleting a listen removes all of its memberships; an album cover disappears only when no linked listens or explicit save remain. Deleting a board clears its memberships and profile pin but preserves diary entries. The default board remains undeletable.

Diary writes, board membership writes, board deletion, and board pinning require a transaction-capable MongoDB replica set or sharded deployment. Parent revision claims serialize overlapping edits, and unavailable transactions return `503 DIARY_WRITE_UNAVAILABLE` or `BOARD_WRITE_UNAVAILABLE` without partial writes. Creation receipts enforce one result per user/key; different canonical input returns `409 IDEMPOTENCY_CONFLICT`. Receipts retain only the user, key, input fingerprint, and resulting public listen ID after deletion; replay then returns `409 LISTEN_DELETED` rather than recreating the entry. New diary mutation routes share 30 attempts per user per 10 minutes and the existing `Retry-After` contract. Existing save limits are unchanged.

The album sidebar groups Log listen and Like, with a separate Write review action. Log listen records a local calendar date without requiring a review or saving the album. Boards is the saving entry point: choose Save album or an existing dated listen, then select or create a board. Older listens can be paged in from this picker. Retries of listen creation reuse the same idempotency key and payload.

Board cards and profile board previews show distinct album totals and listen totals. Board detail supports grid/list views and saved/listened filters, shows each album’s membership source and latest listening date, and opens paginated board-specific dates. Owners can log directly into the board, attach an existing diary entry, or remove only its board membership. “Keep album saved” adds an explicit save so removing the last linked listen does not remove that album from the board. Public views show dates without mutation controls and use the profile privacy endpoints. Removing an entire album from a board clears both membership types but preserves diary entries. Board detail also sorts albums client-side (recently or first added, release year, artist, title, or listen count), lets the owner edit the description, and offers "Pick something for me" on boards with albums. The Boards page offers the same pick across every board. Profiles have a Diary tab with the month calendar, which follows the same privacy rules as the other profile tabs.

Rollout is additive: start the backend before the diary frontend, retaining every existing board and undated save. Startup waits for the new listen, membership, and receipt models/indexes to initialize before binding the HTTP port; deployments must keep index creation enabled or provision the declared indexes ahead of startup. No existing save is converted into a listening date. Verification is `npm test`, `npm run test:integration`, and `npm run check:catalog-contract`; the replica-set suite uses isolated fixtures and no live providers.

## Review discovery feeds

`GET /reviews/popular` accepts `window=7d|30d|all` (default `30d`) and clamps `limit` to 5–10 (default 5). It returns catalog albums ranked by the Bayesian score `(averageRating * reviewCount + 10.5) / (reviewCount + 3)`. `GET /reviews/recent-albums` defaults to 6 and caps at 12, deduplicating albums by their newest review. `GET /reviews/popular-reviews` defaults to 4 and caps at 12, ranking all-time review likes with deterministic newest-review ties. All feeds resolve current `AlbumCatalog` metadata and omit catalog records that no longer exist; album MongoDB IDs are never serialized. Reviews remain public even when a profile is private. Private profiles retain a visible account identity, while saved albums, favorites, boards, activity, network data, and other profile-owned collections remain private.

Before a review-ID rollout, audit orphaned review likes, review-like notifications, and pinned-review references with a reviewed, checksummed dry-run artifact. Applying any cleanup requires separate authorization for the named target and must run transactionally; the review-ID change does not perform a live cleanup.

## Network activity feed

`GET /profile/me/network` requires Clerk authentication and returns the newest 20 review and listen activities across everyone the signed-in user follows, ordered by review date or listen creation time descending. Within each event type, internal IDs break timestamp ties; reviews precede listens at identical timestamps. The limit applies to the combined feed, not to each followed account. Self-follow rows, private-profile activity, and events whose catalog album no longer exists are excluded before selecting the feed. Following a private account does not grant access to its activity, even though its reviews remain available through public review surfaces.

Each review item contains `id` and `reviewId` (the same public review UUID), `type: "review"`, `actor` (`userId`, `username`, `imageUrl`), `userId`, `createdAt`, `album`, `rating`, `reviewText`, `likeCount`, `likedByViewer`, and `commentCount`. Album links use the public Rescened `album.albumId`; album metadata is resolved from the current catalog. Missing Clerk display details fall back to the existing account ID and a generic display name. Listen items contain `id` and `listenId` (the same public listen UUID), `type: "listen"`, `actor`, `userId`, `createdAt`, `listenedOn`, and `album`. No followed accounts or no visible activities returns `[]`.

Network includes reviews and listens, while relationship lists remain at `/profile/me/social`. Listen cards show the listening date separately from the date logged, both in the activity feed and its profile sidebar summary.

## Review history feeds

`GET /reviews/review/user/`, `GET /reviews/review/user/:userId`, and `GET /reviews/review/album/:albumId` return `{ reviews, nextCursor }`. They accept `sort=recent|popular|highest|lowest`, an opaque `cursor`, and a `limit` of up to 50 (default 20). Popular pagination freezes its ranking and review membership at a majority-committed MongoDB snapshot selected on the first request. Later likes, unlikes, re-likes, and newly created reviews cannot move entries across pages. Review text, catalog metadata, displayed like counts, and viewer-like state remain current; deleted reviews are omitted and subsequent entries fill the page. `POST /reviews/review` requires an `Idempotency-Key` UUID-v4 header: a retry with the same key returns the already-created review instead of creating another.

Popular history pagination requires MongoDB 5.0+ on a replica set or sharded deployment with snapshot reads available. It introduces no collection or data migration. Its encrypted cursor carries the snapshot timestamp; it does not keep a database session open between requests. Continuations work only while MongoDB retains that snapshot (controlled by `minSnapshotHistoryWindowInSeconds`). An expired snapshot returns `400 INVALID_REVIEW_CURSOR` with a reload message; unavailable snapshot reads return `503 POPULAR_REVIEWS_UNAVAILABLE`, without falling back to a changing ranking. Popular cursors issued before this rollout must restart from the first page; recent-sort cursors remain compatible.

`highest` and `lowest` order by rating, then newest first among equal ratings, then an internal tie-breaker. Their cursors use their own version and carry the last rating, so a cursor works only with the sort that issued it; any other sort returns `400 INVALID_REVIEW_CURSOR`. Unlike `popular`, they do not freeze a snapshot. A review whose rating is edited between page loads can move across pages. Each sort direction has its own index for album and user lists: `{ albumCatalogId: 1, rating: ±1, date: -1, _id: -1 }` and `{ userId: 1, rating: ±1, date: -1, _id: -1 }`. These are four non-unique indexes, so building them cannot fail on existing data. Build them before the rating sorts receive traffic (Mongoose builds them at startup when index creation is enabled). Without them, every rating-sorted page sorts all of the album's or user's reviews in memory.

`GET /reviews/review/:reviewId` returns one review in the same shape as the list endpoints, for shareable `/review/:reviewId` links. It needs no authentication; signed-in viewers also get `likedByViewer`. A malformed ID or a Mongo ObjectId returns `400 INVALID_REVIEW_ID`. An unknown review, or one whose catalog album no longer resolves, returns `404 REVIEW_NOT_FOUND`. As with the other review surfaces, a review stays public even when its author's profile is private. Every review response includes `commentCount`, the number of visible comments and replies. Comment threads, their flag, and moderation are described in [review comments](docs/REVIEW_COMMENTS.md).

`PATCH /reviews/review/user/:reviewId` lets the author change a review's `rating` and `reviewText`. The body takes exactly those two fields with the same rules as creation; anything else returns `400 INVALID_REVIEW`, and a missing or someone else's review returns `404 REVIEW_NOT_FOUND`. A change sets `editedAt` and claims the review's interaction revision in one conditional write, so it cannot race deletion, likes, pins, or account anonymization. Saving unchanged values returns the review untouched. An edit keeps the original `date`, does not notify followers again, and does not move the review up in feeds. Every review-bearing response (review lists, permalinks, profiles, activity, listening stats, and the comment moderation queue) includes `editedAt`, which is `null` for a review that was never edited. Existing reviews need no migration. Album rating summaries and feeds read ratings live, so an edited rating counts at once, except that cached site feed rankings can lag by up to a minute.

## Album social context

`GET /albums/album/:albumId/social` returns `savedCount`, `reviewCount`, `averageRating`, `ratingDistribution`, `viewerRating`, `followedAverageRating`, `followedReviewers`, and `followedAlbumLikers`. `viewerRating` is the rating on the signed-in viewer's newest review of the album, or `null`. A viewer can review an album more than once, so after deleting a review the album page reloads this summary instead of guessing. `followedReviewers` holds one entry per followed person, from their newest review of the album, with their `rating` and public `reviewId`. `followedAverageRating` averages those latest ratings, rounded to one decimal, or is `null` when nobody the viewer follows has reviewed the album. Anonymous viewers get `null` personal fields and empty followed lists.

## Review public-ID migration

Every review has an immutable public UUID-v4 `reviewId`; Mongo `_id` remains an internal relation and pagination key. Existing databases that predate this field must be backfilled before the matching API/frontend release serves review traffic. The sealed legacy transformer preserves canonical review UUIDs and assigns missing or invalid values while building its plan, so a database restored through that workflow does not need this separate backfill after execution.

Start with a dry run. It reads `Review.collection` directly, with Mongoose index creation disabled, so missing IDs cannot be manufactured by schema defaults. The command writes a no-clobber JSON plan and an adjacent SHA-256 checksum under the ignored `.migration/review-ids/` directory unless `--report` selects a destination. The artifact contains collection identity, hashes, ID mappings, and blockers, but no review text.

```sh
npm run db:migrate:review-ids -- --dry-run
npm run db:migrate:review-ids -- --dry-run --report .migration/review-ids/review-id-plan.json
```

Review the exact report and checksum, close review writers, and obtain authorization for the named database before applying it to a transaction-capable replica set or sharded deployment. Apply requires both the reviewed report and an exact database-name confirmation. It rechecks the collection identity and content baseline, updates only the report’s missing/null fields in batches of 500, then creates or verifies the `reviewId_1` unique index. It never overwrites the reviewed plan; progress is retained beside it as `*.apply-progress.json`. A retry treats an already matching assigned UUID as a successful no-op.

```sh
npm run db:migrate:review-ids -- --apply \
  --report .migration/review-ids/review-id-plan.json \
  --confirm-target rescened
npm run db:migrate:review-ids -- --verify --report .migration/review-ids/review-id-plan.json
```

`--verify` is read-only and checks UUID coverage, uniqueness, and the unique index; its report is optional. Exit code `0` means complete, `2` means the dry run found blockers or verification found unresolved identity/index issues, and `1` means a fatal artifact, target, transaction, or database error. If an apply error says database changes were committed or that its commit outcome is unknown, retain the report and progress artifact and rerun only after inspecting the named error; do not treat that result as a rollback.

## Community submissions

See [Phase 2 community album submissions](./docs/PHASE_2_SUBMISSIONS.md) for the contributor and moderator APIs, data model, configuration, validation, duplicate handling, approval publication, public feed, catalog corrections, and test contract. See the [moderator implementation guide](./docs/MODERATOR_IMPLEMENTATION_GUIDE.md) for a code-level walkthrough of the router, approval transactions, frontend workspace, errors, and tests. See [Phase 3 community-submission UI](./docs/PHASE_3_UI.md) for the authenticated contributor and moderator routes and workflows. The approved-feed and correction backends are present; historical reconciliation and their frontend presentation remain rollout work.

## Catalog bootstrap

The offline ListenBrainz catalog pipeline can generate a versioned MusicBrainz-hydrated seed, validate it without a database, dry-run it against MongoDB, and transactionally import accepted rows. See [ListenBrainz catalog import](./docs/CATALOG_IMPORT.md) for commands, the strict JSON contract, quarantine behavior, refresh rules, licensing, and staged rollout.

Missing catalog covers can be resolved from exact MusicBrainz identities through the Cover Art Archive. Run `npm run catalog:backfill-covers -- --dry-run` first and review `.migration/cover-backfill/report.json`, then use `npm run catalog:backfill-covers -- --apply` to conditionally fill records whose covers are still blank. Use `--report <path>` to choose another report destination. The command reads `MONGO_URI`; `MUSICBRAINZ_USER_AGENT` remains an optional identifying-user-agent override and no new environment variable is required.

The command never overwrites an existing cover. Exit code `0` means every scanned row resolved cleanly, `2` means unresolved or conflicted rows remain in the report, and `1` means a fatal database or report failure. Artwork is hotlinked at its canonical CAA `front-500` URL; the command does not download, proxy, or rehost copyrighted files.

The legacy generation-1 database workflow uses two operator commands after the isolated source and candidate databases exist: `npm run db:migrate:legacy:plan -- --run-dir <path>` creates and validates a sealed plan, and `npm run db:migrate:legacy:execute -- --run-dir <path> --plan-sha256 <sha> --confirm-target <database>` applies and verifies it. See [legacy database migration](./docs/LEGACY_DATA_MIGRATION_WORKFLOW.md) for restore preparation, overrides, artifacts, and recovery modes.
