# September 22, 2026 change summary

## Scope

This round completes the listening-diary frontend and activity integration on the `2.0` branch, fixes popular-review pagination, and prepares the changes for review. It includes the working-tree changes already present when the production-readiness review began, as well as the pagination fix requested during that review.

The PR from `2.0` into `main` also includes the earlier branch commits for performance tooling, the 2.0 roadmap, catalog search ranking and artist aliases, and the listening-diary backend. Those are existing branch changes, not newly implemented during this review. Their maintained guides are linked below.

## Album actions and listen logging

- Added `frontend/src/Components/ListenForm.jsx` to log an existing catalog album with a local calendar date and the browser's IANA timezone.
- Creation sends a UUID-v4 `Idempotency-Key`. Retries after an ambiguous network or server failure retain the same key and payload; validation failures allow a corrected submission.
- Album detail now presents Log listen beside Like, separates Write review, and uses Boards as the saving entry point.
- The board picker can save an album or attach an existing dated listen, including listens loaded through pagination. Existing board creation remains available.
- Updated review-form wording to distinguish writing a review from logging a listen.

## Board listening controls

- Added `frontend/src/Components/BoardListens.jsx` for paginated board-specific listening dates, direct logging into a board, and attaching existing diary entries.
- Owners can remove a listen's board membership without deleting the diary entry. Keep album saved adds an explicit save for an album currently present only through listens.
- Board detail shows membership source, listen totals, latest listening date, and saved/listened filters in grid and list views.
- Board cards, profile board previews, and pinned boards display separate distinct-album and listen totals.
- Public board views use profile privacy endpoints and expose dates without mutation controls.
- Added request cancellation and scope checks to board refreshes, loading and action feedback, dialog focus handling, keyboard controls, and responsive styling.

## Profile and network activity

- Added `routes/utils/listenActivity.js` to resolve listen events against current `AlbumCatalog` metadata and expose only public listen and album identities.
- Personal and public profile activity now include listens alongside reviews and explicit saves.
- Network activity merges reviews and listens across visible followed accounts, retaining a combined limit of 20 events. Private accounts and missing catalog albums are excluded before selecting candidates.
- Listen events are ordered by creation time, with listening dates displayed separately. Date corrections do not bump an event, deletion removes it, and retries or board attachments do not create extra events.
- Account activity cards and sidebar summaries now render listen-specific labels, dates, and styling.
- Fixed pinned-review artwork and title rendering to use the API's nested `pinnedReview.album` metadata.

## Stable popular-review pagination

The prior implementation counted surviving likes created before a timestamp. Unliking a review deleted those rows, so its rank could change between requests: a reproduced sequence returned `[A, B]` and then `[A, C]`.

- Replaced the timestamp filter with MongoDB snapshot reads for all three review-history endpoints: own reviews, public user reviews, and album reviews.
- Popular cursors now encrypt the server-selected snapshot timestamp along with their scope and position. Their size does not grow with the number of previously returned reviews.
- Likes, unlikes, re-likes, and new reviews cannot move entries across an existing page sequence. A fresh first page reflects the new ranking.
- Only ranking is historical. Review text, catalog metadata, visible like counts, and viewer-like state are resolved from current records. Deleted reviews are omitted, and subsequent entries fill the page.
- Added a database time budget and explicit errors rather than a fallback to a changing live ranking.
- Popular cursors from the old implementation must restart from the first page. Recent-sort version-one cursors remain compatible.

This fix adds no collection or data migration. Popular history pagination requires MongoDB 5.0+ snapshot reads on a replica set or sharded deployment. Snapshot retention is controlled by `minSnapshotHistoryWindowInSeconds`; an expired continuation returns `400 INVALID_REVIEW_CURSOR` with a reload message. Unavailable snapshot reads return `503 POPULAR_REVIEWS_UNAVAILABLE`.

## Repository packaging and documentation

- Removed the blanket `benchmarks/` ignore rule and included the existing benchmark/search-quality source, synthetic fixtures, guide, and preserved historical baseline. Committed tests and package scripts already depended on these files; without them, a fresh checkout could not reproduce local verification. Generated run artifacts remain under ignored `.benchmarks/`.
- Expanded the README with diary UI behavior, mixed activity feeds, snapshot pagination, and isolated development-database guidance.
- Updated the error-code reference for unavailable and expired review snapshots.
- No dependency upgrades or frontend environment-validation changes were made in this round.

## Verification

The full release gate was run on September 22, 2026 against the combined working tree:

| Command | Result |
| --- | --- |
| `npm test` | PASS: 245 passed, 51 skipped, 0 failed. The default suite skips opt-in MongoDB integration and live-provider cases. |
| `npm run test:integration` | PASS: 55 passed, 0 skipped, 0 failed, using isolated local MongoDB replica sets. |
| `npm run check:catalog-contract` | PASS. |
| `npm --prefix frontend run lint` | PASS. |
| `npm --prefix frontend run build` | PASS. |
| `git diff --check` | PASS. |

After staging, the source was exported to a temporary directory with dependency symlinks and without application `.env` files or ignored local sources. Both `npm test` (245 passed, 51 skipped) and `npm run test:integration` (55 passed) also passed from that export, confirming the benchmark packaging repair. This was a source-completeness check using installed dependencies, not a fresh dependency installation.

New regression coverage exercises all three popular-history routes through unlikes, re-likes, newly popular and newly created reviews, timestamp ties, page-size changes, scope mismatch, live metadata updates, and deleted batches. Cursor tests cover malformed/tampered snapshots, old popular-cursor rejection, recent-cursor compatibility, expiry, and unavailable snapshot reads. Activity tests cover idempotency, privacy, corrected dates, current metadata, deletion, mixed-event limits, missing catalog albums, and public IDs.

The local API reported `status: "ok"` during the readiness review. That observation does not verify the production database. Authenticated browser interaction testing, live-provider checks, and production load tests were not performed in this round.

## Deferred shipping work

The readiness review identified two items intentionally left for the next run:

1. Production frontend builds still need configuration validation: a missing API URL falls back to localhost, and a missing Clerk publishable key fails at runtime despite a successful build.
2. Production dependency audits returned four backend package alerts and two frontend package alerts. These are advisory counts, not six demonstrated exploits; the frontend React Router advisory is limited to RSC mode, which this app does not use. Dependencies require updates or documented applicability review.

The actual deployment still needs verification of the separate API host, production Clerk/CORS settings, MongoDB transaction and snapshot support, required indexes, and public-ID migration state. This round did not deploy the application or apply data changes to production.

## Maintained references

- [Application and diary contracts](../README.md)
- [API error reference](ERROR_CODES.md)
- [Search behavior and catalog growth](SEARCH_AND_CATALOG_GROWTH.md)
- [Benchmark and search-quality guide](../benchmarks/README.md)
- [Historical performance results](PERFORMANCE_BENCHMARK_RESULTS.md)
- [Rescened 2.0 roadmap](RESCENED_2_0.md)
