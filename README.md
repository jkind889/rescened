# Rescened

Repeatable local API/database performance tests and their interpretation are documented in [the benchmark guide](./benchmarks/README.md).

Rescened is a community-curated album catalog. Albums, reviews, boards, listens, and notifications receive domain-specific immutable UUIDs (`albumId`, `reviewId`, `boardId`, `listenId`, and `notificationId`); MongoDB `_id` values remain internal implementation details. Search, album detail, reviews, likes, profiles, activity, boards, and the diary use the local catalog only.

Application, provider, and operator failures are cataloged in the [error and status code reference](./docs/ERROR_CODES.md), including HTTP meanings, rate-limit budgets, report reasons, workflow statuses, and command exit codes.

Future feature ideas and optimizations are tracked in the living [Rescened 2.0 roadmap](./docs/RESCENED_2_0.md).

## Local development

Set `MONGO_URI`, `CLERK_SECRET_KEY`, and either `CLERK_PUBLISHABLE_KEY` or `VITE_CLERK_PUBLISHABLE_KEY`. Spotify credentials are not used or required. Set `COMMUNITY_SUBMISSIONS_ENABLED=true` to enable contributor submission mutations and `COMMUNITY_MODERATION_ENABLED=true` to enable moderator commands; both are disabled by default. Set `MODERATOR_USER_IDS` to a comma-separated Clerk allowlist. Start the API with `npm run devStart` and the frontend from `frontend/` with `npm run dev`.

`REVIEW_CURSOR_SECRET` is optional but recommended when review-pagination cursors should be rotated independently of the Clerk secret.

The database is intentionally empty after the generation-2 cutover. Phase 2 includes contributor and moderator APIs: approval creates, links, or applies an explicit field-level correction to a usable local catalog album inside a Mongo transaction. Approval commands and review interaction mutations (deletion, review likes, and pinning) require a transaction-capable MongoDB replica set or sharded deployment; standalone Mongo remains safe for reads and non-publication moderation commands only. Transaction-unavailable mutations return an action-specific `503` code and do not fall back to partial writes.

## Catalog contract

Catalog responses expose `albumId`, `title`, `artistDisplayName`, `artistCredits`, `releaseType`, release date fields, `releaseYear`, `cover`, `tracks`, `label`, and normalized external references. Album-bearing social records resolve their current metadata from the catalog, so edits to an approved catalog record are reflected in reviews and activity.

Saved albums are the deduplicated union of every board a user owns. Removing an item from one board does not remove it from the saved shelf while another board still contains it; manage membership from board detail pages.

Boards expose `boardId` and notifications expose `notificationId`. Board items and profile pins continue to store internal Board ObjectIds, which are resolved server-side and are never serialized. Because the pre-rollout board and notification datasets were very small, the UUID rollout intentionally deleted every existing board and notification instead of backfilling identifiers. It also deleted the associated board items and cleared every matching profile board pin. This was a one-time completed reset, not an automated migration procedure.

## Listening diary backend

A listen records an existing catalog album and a calendar date; ratings, reviews, notes, and listening activity feeds are outside this release. Multiple intentional listens on the same day are supported. Diary and board-date reads follow profile privacy: public profiles are readable anonymously; private profiles are readable only by their owner, including subsequent pages. Logging for the first time creates a profile if necessary without changing an existing privacy setting.

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

`listenedOn` is a real `YYYY-MM-DD` calendar date, stored without UTC conversion. Creation and date edits require an IANA `timeZone`, used to reject future dates in that zone. Historical dates are allowed; the frontend should supply the user's local date and timezone explicitly. Creation accepts at most 100 board UUIDs, deduplicates them, and requires ownership of every board. Existing authenticated board paths retain the `default` alias. A standalone listen creates no default board or saved-album membership.

Lists return `{ listens, nextCursor }`. Each listen contains `listenId`, `userId`, `albumId`, current normalized `album` metadata, `listenedOn`, `createdAt`, and `updatedAt`; neither internal Mongo IDs nor other board memberships are exposed. Lists accept `albumId`, `boardId`, inclusive `from`/`to` dates, `limit` (default 20, capped at 50), and an opaque `cursor`. Board/album route parameters fix those filters. Ordering is listening date descending, then creation time descending, then an internal tie-breaker. Cursors are encrypted with a diary-specific key derived from `CLERK_SECRET_KEY` and bound to the target user and filters; changing a filter requires starting a new page sequence. Edits to dates can change ordering, so reload the first page after editing. Missing catalog records are excluded before pagination and board counts.

Boards combine explicit `BoardItem` saves with `BoardListen` memberships. Existing response fields remain, with `listenCount` added to board summaries and `listenCount`, `latestListenedOn` (or `null`), and `explicitlySaved` added to each album. `itemCount` still counts distinct albums; preview covers remain deduplicated. Explicit saves preserve their `savedAt`; listen-only album cards use the earliest remaining membership timestamp. The saved shelf remains the deduplicated union across all boards, using the latest board-level `savedAt`, and album save counts count each user once. Personal and public activity feeds continue to use explicit saves and reviews only.

Removing a listen from one board leaves its diary entry and other memberships intact. Removing an album through `DELETE /boards/:boardId/albums/:albumId` removes both its explicit save and all its listening memberships in that board. Deleting a listen removes all of its memberships; an album cover disappears only when no linked listens or explicit save remain. Deleting a board clears its memberships and profile pin but preserves diary entries. The default board remains undeletable.

Diary writes, board membership writes, board deletion, and board pinning require a transaction-capable MongoDB replica set or sharded deployment. Parent revision claims serialize overlapping edits, and unavailable transactions return `503 DIARY_WRITE_UNAVAILABLE` or `BOARD_WRITE_UNAVAILABLE` without partial writes. Creation receipts enforce one result per user/key; different canonical input returns `409 IDEMPOTENCY_CONFLICT`. Receipts retain only the user, key, input fingerprint, and resulting public listen ID after deletion; replay then returns `409 LISTEN_DELETED` rather than recreating the entry. New diary mutation routes share 30 attempts per user per 10 minutes and the existing `Retry-After` contract. Existing save limits are unchanged.

Rollout is additive: start the backend before the future diary frontend, retaining every existing board and undated save. Startup waits for the new listen, membership, and receipt models/indexes to initialize before binding the HTTP port; deployments must keep index creation enabled or provision the declared indexes ahead of startup. No existing save is converted into a listening date. Verification is `npm test`, `npm run test:integration`, and `npm run check:catalog-contract`; the replica-set suite uses isolated fixtures and no live providers.

## Review discovery feeds

`GET /reviews/popular` accepts `window=7d|30d|all` (default `30d`) and clamps `limit` to 5–10 (default 5). It returns catalog albums ranked by the Bayesian score `(averageRating * reviewCount + 10.5) / (reviewCount + 3)`. `GET /reviews/recent-albums` defaults to 6 and caps at 12, deduplicating albums by their newest review. `GET /reviews/popular-reviews` defaults to 4 and caps at 12, ranking all-time review likes with deterministic newest-review ties. All feeds resolve current `AlbumCatalog` metadata and omit catalog records that no longer exist; album MongoDB IDs are never serialized. Reviews remain public even when a profile is private. Private profiles retain a visible account identity, while saved albums, favorites, boards, activity, network data, and other profile-owned collections remain private.

Before a review-ID rollout, audit orphaned review likes, review-like notifications, and pinned-review references with a reviewed, checksummed dry-run artifact. Applying any cleanup requires separate authorization for the named target and must run transactionally; the review-ID change does not perform a live cleanup.

## Network activity feed

`GET /profile/me/network` requires Clerk authentication and returns the newest 20 review activities across everyone the signed-in user follows, ordered by review date descending with review ID as a deterministic tie-breaker. The limit applies to the combined feed, not to each followed account. Self-follow rows, private-profile activity, and reviews whose catalog album no longer exists are excluded before selecting the feed. Following a private account does not grant access to its activity, even though its reviews remain available through public review surfaces.

Each item contains `id` and `reviewId` (the same public review UUID), `type: "review"`, `actor` (`userId`, `username`, `imageUrl`), `userId`, `createdAt`, `album`, `rating`, `reviewText`, `likeCount`, and `likedByViewer`. Album links use the public Rescened `album.albumId`; album metadata is resolved from the current catalog. Missing Clerk display details fall back to the existing account ID and a generic display name. No followed accounts or no visible reviews returns `[]`.

Network remains a review-activity feed, not a people list or a stream of other users' personal likes and follows. Relationship lists remain at `/profile/me/social`; the personal `/profile/me/activity` contract is unchanged by this restoration.

## Review history feeds

`GET /reviews/review/user/`, `GET /reviews/review/user/:userId`, and `GET /reviews/review/album/:albumId` return `{ reviews, nextCursor }`. They accept `sort=recent|popular`, an opaque `cursor`, and a `limit` of up to 50 (default 20). Popular pagination freezes its like-count ranking at the first request so later likes do not reshuffle an in-progress feed. `POST /reviews/review` requires an `Idempotency-Key` UUID-v4 header: a retry with the same key returns the already-created review instead of creating another.

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
