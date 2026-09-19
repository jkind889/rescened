# Rescened

Repeatable local API/database performance tests and their interpretation are documented in [the benchmark guide](./benchmarks/README.md).

Rescened is a community-curated album catalog. Albums, reviews, boards, and notifications receive domain-specific immutable UUIDs (`albumId`, `reviewId`, `boardId`, and `notificationId`); MongoDB `_id` values remain internal implementation details. Search, album detail, reviews, likes, profiles, activity, and boards use the local catalog only.

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
