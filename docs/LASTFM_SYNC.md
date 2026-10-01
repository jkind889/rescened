# Last.fm syncing and reviewed album-name coverage

This is the persistent **sync-only pilot**, separate from the frozen [feasibility study](LASTFM_LISTENING_STUDY.md). It collects future scrobbles and resolves reviewed album identities. It does not count completed albums, create diary entries, publish catalog albums, or change manual listens. The later counting scope remains in [AUTOMATIC_ALBUM_LISTENS.md](AUTOMATIC_ALBUM_LISTENS.md).

## Account and privacy contracts

The Last.fm pilot section, including detected listen sessions, is the owner-only **Last.fm** tab on the signed-in user's profile (`/account`). Start authorization while signed into Rescened, authorize the application at Last.fm, and return to `/account/lastfm/callback`, which sends the browser back to that tab. The server binds an expiring, single-use attempt to the authenticated Clerk user, exchanges the token, and uses the provider-returned account name. The browser removes callback parameters from its URL; the server stores only a hash of the attempt state. Session keys and authorization tokens are not persisted.

A Last.fm account can have only one active or paused connection, and a Rescened user can have only one connection. Another user cannot take over an existing connection. Pause closes the activation window; resume begins another. Reconnection starts from the new connection time. Paused-period listening and history before connection are excluded.

Last.fm's recent-track endpoint is public. Revoking authorization at Last.fm does not reliably stop those reads. Users must use Rescened's pause or disconnect controls. Disconnect fences in-flight jobs and schedules private evidence cleanup. Signed Clerk `user.deleted` events and owner-existence checks provide account-deletion cleanup. The webhook runs one transaction (`lib/accountDeletion.js` plus the listening cleanup) that deletes auth attempts, automatic-listen receipts and fences, diary entries and their `ListenCreation` receipts, boards with their saved albums and listen memberships, the user's likes, follows in both directions, notifications the user sent or received, and the profile. The same transaction deletes the user's Last.fm connection, including the username, with its scrobbles, detections, and detection evidence. It also clears connection references from queued jobs. Account deletion therefore does not wait for the worker. Disconnect still relies on the worker's cleanup job. Reviews stay public but are anonymized: their author becomes a server-only placeholder that API responses show as `userId: null` and "deleted user", that resolves to no profile or review list, and that receives no notifications. Their private idempotency key is cleared, and other users' likes on them remain. Album submissions and moderation history are append-only and are kept unchanged. Without transaction-capable MongoDB, the webhook returns `503 CLEANUP_UNAVAILABLE` and changes nothing, so Clerk retries delivery.

Normalized scrobbles retain exact timestamps only in owner-private records for at most 30 days from playback. Reads enforce expiration as well as MongoDB TTL deletion, since TTL deletion is asynchronous. Production does not retain complete raw provider responses. Moderator cases retain reusable artist/album metadata, source evidence, encounter totals, and a distinct-listener count, without usernames, listening sequences, or exact listening timestamps. Case and decision dates are review provenance, not playback dates.

## Configuration and launch

All four feature flags default to disabled:

| Variable | Purpose |
| --- | --- |
| `LASTFM_CONNECTION_ENABLED=true` | Permit new verified connections and resumes. |
| `LASTFM_SYNC_ENABLED=true` | Permit background recent-track reads. |
| `LASTFM_DISCOVERY_ENABLED=true` | Permit candidate discovery and provider metadata reads. |
| `ALBUM_MAPPING_MODERATION_ENABLED=true` | Permit mapping decisions by existing moderators. |
| `LISTENING_DETECTION_ENABLED=true` | Permit private album-listen detection jobs for pilot users. Detection never writes diary entries. |
| `LISTENING_AUTO_DIARY_ENABLED=true` | With detection enabled, let pilot owners opt in to automatic diary entries. Off by default; each owner must also opt in. |
| `LASTFM_DEEP_SWEEP_ENABLED=true` | With sync enabled, permit the daily 14-day refetch for late, back-dated scrobbles. |
| `LASTFM_PILOT_USER_IDS` | Explicit comma-separated Clerk user IDs eligible for the pilot. An empty list admits nobody. |
| `MODERATOR_USER_IDS` | Existing moderator allowlist, also used for mapping review. |
| `LASTFM_API_KEY`, `LASTFM_API_SECRET` | Server-only Last.fm application credentials. Legacy `LAST_FM_API` and `LAST_FM_SECRET` names are accepted by the adapter. |
| `LASTFM_CALLBACK_URL` | Absolute frontend callback URL ending at `/account/lastfm/callback`. Use HTTPS except local development. |
| `LASTFM_USER_AGENT`, `MUSICBRAINZ_USER_AGENT` | Identifying application/contact user agents for provider traffic. |
| `CLERK_WEBHOOK_SIGNING_SECRET` | Signing secret for the Clerk deletion webhook endpoint. |
| `MONGO_URI`, `CLERK_SECRET_KEY` | Existing server-side database and Clerk configuration, also available to the worker. |

`LASTFM_TIMEOUT_MS`, `LASTFM_RETRIES`, and `LASTFM_REQUESTS_PER_MINUTE` tune bounded provider behavior. Keep these server-side; never place credentials or allowlists in Vite variables. Provider calls are opt-in runtime behavior, not part of normal tests.

Before enabling any pilot user:

1. Confirm Last.fm application name, description, callback registration, attribution and data-use requirements against its [web authentication documentation](https://www.last.fm/api/webauth), [recent-track documentation](https://www.last.fm/api/show/user.getRecentTracks), and [API terms](https://www.last.fm/api/tos). Commercial/research use requires the provider's stated contact process. This repository does not establish permission for a particular deployment.
2. Provision transaction-capable MongoDB, application credentials, and a verified Clerk webhook destination at `/webhooks/clerk/listening`. The webhook route verifies the original raw bytes before JSON parsing. Do not log webhook bodies or callback request query strings in reverse proxies, analytics, error reporting, or access logs. Serve the callback with `Referrer-Policy: no-referrer` and `Cache-Control: no-store` at the frontend host.
3. Set a small explicit pilot allowlist. Initialize application indexes and start one supervised worker. No worker runs inside an API process.
4. Validate signed-in connect, status, pause/resume, disconnect, webhook delivery, throttling and retained-event resolution in the named pilot environment. Live provider verification and deployment are separate operator steps; repository tests use synthetic providers and temporary databases.

Provide environment variables through the deployment environment or an external credentials file. The worker and operator commands do not implicitly load the repository `.env`. For local development only, `npm run listening:worker:dev` starts the worker with the root `.env`. On startup failure the worker prints only an error code or class name, such as `MONGO_URI_REQUIRED` or `MongoServerSelectionError`. After startup, a failed pass (for example a MongoDB failover) is logged as `Listening worker pass failed: <code> (attempt N, retrying in Ns)`. The worker then retries with exponential backoff from 5 seconds up to 5 minutes, and resets after the next successful pass. Unfinished jobs keep their lease and are retaken when it expires. The due-sync, sweep, detection-expiry and stale-mapping scans run at most once a minute. Connect and resume enqueue their own first sync. SIGINT and SIGTERM stop the worker promptly, even during a backoff.

```sh
npm run listening:worker
npm run listening:metrics -- --environment pilot
```

Keep the worker running for disconnect cleanup even when reads are disabled. Account-deletion cleanup does not need it. Supervise restarts: startup failures still exit with code 1. Alert on repeated `pass failed` lines. Do not infer successful ingestion from a running process alone.

## Sync and resolution behavior

Mapping queue listener counts are refreshed when new unresolved evidence arrives and exclude evidence expired at that worker pass, even before MongoDB TTL cleanup. They are stored counts, not a live census. Before enabling this release against an existing pilot database, reconcile cases created before `listenerCount` existed; absent counts display as zero and can affect queue ordering. The new production worker does not perform an automatic data backfill.

Active connections are due approximately every five minutes, subject to provider budget and capacity. Each job captures fixed `from`/`to` bounds and paginates the complete window, using a 48-hour overlap for delayed scrobbles. Job progress survives restart; completed cursors never skip unprocessed pages. Now-playing rows are excluded, and repeated pages/retries do not create duplicate events or inflate encounter counts. A same-second identical artist/album/track event is conservatively treated as one event. A repeated delivery that disagrees on a populated MusicBrainz identifier keeps the first values and records each disagreeing field in `identityConflictFields`. Only a disagreeing `trackMbid` marks the event `identityConflict`, which detection does not count. Album and artist IDs do not decide the album (the reviewed text mapping does), and Last.fm often switches them between releases of the same album, so those disagreements are recorded for diagnosis but the event still counts. The detector applies the same rule to duplicates within one evaluation.

Catch-up stops at the 30-day retention boundary and exposes older gaps. Regular sync refetches only a 48-hour overlap. When `LASTFM_DEEP_SWEEP_ENABLED=true`, each active pilot connection also gets a daily sweep job that refetches from the later of 14 days ago and `connectedAt` up to `completedThrough`. It picks up offline or late-uploaded scrobbles, never moves the cursor, records `lastSweepAt`, and runs only when no other job is due. Without the sweep, events delayed beyond the overlap may be missed. The sweep shares the global `lastfm` request budget. If `lastfm_request_budget_exhausted` or `lastfm_rate_limited` errors, cooldowns, or regular-sync lag increase, investigate the sweep first; see [automatic album listens](AUTOMATIC_ALBUM_LISTENS.md). Provider pagination changing during a fetch leaves the window incomplete rather than silently advancing it. Revision and lease fences prevent paused, disconnected, replaced, or expired work from committing. Provider outages leave the normal catalog and manual diary usable.

Only an exact approved normalized provider/track-artist/album-label key resolves at runtime. Normalization applies Unicode NFKC, case folding, trimming and whitespace collapsing; it preserves punctuation and edition qualifiers. Artist names from recent tracks are not assumed to be album artists. Guest-credit variations remain unresolved unless separately reviewed.

A mapping establishes identity to an existing public Rescened `albumId`. It does **not** certify a standard tracklist. `baselineAvailable` requires a current moderator-reviewed MusicBrainz standard baseline; nonempty catalog tracks alone cannot change this. See [baseline review and enrichment](TRACKLIST_BASELINES.md). Standard-baseline counting and its 80% rule remain unimplemented.

## Discovery and moderation

Unresolved names share one case per exact normalized key. The moderator queue ranks cases by distinct listeners first, then encounters, so an album many users play outranks one user's repeat plays. Each new unresolved event recounts the distinct connections holding retained unresolved events for that key; the case stores only that count, never user or connection identifiers, and the count is refreshed only when a new event arrives. Listener and encounter counts affect priority only. Repeated ingestion of the same retained event does not increase that count. Rejected cases remain rejected on subsequent encounters; a moderator refresh or genuinely changed complete provider evidence is required to reopen them.

Discovery first searches the local catalog, including exact title-only candidates under different artist credits. Such differences are shown for review and never create global artist aliases. It may suggest up to five existing albums from exact names, verified MusicBrainz release-to-release-group relationships, or conservative edition-label simplification with track comparison. Search hits are labeled as candidates, not verified release relationships. Trailing deluxe, expanded, bonus-track and anniversary labels may be simplified only for discovery. Live, remix, acoustic, instrumental and re-recorded distinctions remain intact.

Evidence includes provider links and retrieval dates, track counts, shared/missing/extra tracks, duplicate-title ambiguity and identifier conflicts. Track comparisons identify whether they use a reviewed standard baseline or unreviewed catalog tracks. Track overlap is not an approval signal by itself. Provider errors leave discovery incomplete. A complete search with no suitable local result may mark `no_catalog_match`; the moderator can use the existing catalog-submission workflow, which remains a separate publication process.

The mapping workspace is `/moderation/album-mappings`, beside album-submission moderation. Existing moderators can filter the queue, inspect evidence, select another existing catalog album, approve, reject, mark no match, refresh or revoke. Reasons and expected revisions are mandatory. Approval/revocation updates the mapping, case and append-only audit in one transaction; stale commands return 409 and unavailable transactions return 503. Case candidates are a discovery snapshot, but queue and detail reads report each candidate's current `catalogRevision`. A baseline confirmation that fills an album's empty tracks advances that revision, so a mapping reviewed after it approves against the new revision; an approval that still sends the older one returns `CATALOG_REVISION_CONFLICT`.

An approved mapping pins the catalog revision it was reviewed against. A later catalog change leaves it active but stale: the worker and owner reads resolve its events as `unavailable`, and detections are held for `stale_mapping` until a moderator acts. Two changes do not change identity, so they move the mapping to the new revision without review. A baseline confirmation that fills empty tracks does this inside its transaction. A cover backfill write does it right afterwards, in a transaction that also carries the reviewed tracklist baseline forward ([tracklist baselines](TRACKLIST_BASELINES.md)) and queues reprocessing. If that transaction fails, the cover stays committed and the report records `revisionCarryFailed`, which leaves the mapping and baseline stale. Corrections, importer refreshes, and deletions still require review. The queue marks such cases with `mappingStale`, and `GET /moderation/album-mappings?stale=true` lists only them (any other `stale` value returns `INVALID_STALE`). Detail responses add `mapping.currentCatalogRevision` (`null` if the album is gone) and `mapping.stale`. `POST /moderation/album-mappings/:caseId/reconfirm` accepts `{ expectedRevision, expectedCatalogRevision, reason }` for an approved case. It keeps the same album, sets the mapping to the current catalog revision, bumps the mapping and case revisions, appends a `reconfirmed` audit entry, and queues reprocessing, all in one transaction. It returns `CATALOG_REVISION_CONFLICT` when the album moved past the revision the moderator reviewed, `MAPPING_NOT_STALE` when nothing changed, `MAPPING_NOT_ACTIVE` when there is no active mapping, and `CATALOG_ALBUM_NOT_FOUND` when the album was deleted (revoke instead). To point the name at a different album, revoke the mapping and approve again.

Approvals queue retained-event reprocessing for active connections only. Revocation and changed catalog revisions invalidate cached resolution and schedule reevaluation. Owner event reads also check current mapping/catalog validity, so stale cached matches do not remain authoritative while a worker catches up. With `LISTENING_DETECTION_ENABLED=true`, pilot owners can save an IANA time zone (`PUT /connections/lastfm/time-zone`) and read their private detected sessions (`GET /connections/lastfm/detections`); see [automatic album listens](AUTOMATIC_ALBUM_LISTENS.md). Reviewed mappings are separate from `AlbumCatalog`; discovery and moderation never create catalog albums.

## Reviewed seed workflow

Study IDs and `data/listening-study/album-name-mappings.json` are not production identities. There is no automatic import. An operator must independently bind each reusable artist/album name to an existing public UUID-v4 `albumId`.

Prepare a JSON array containing only `artist`, `album`, `albumId`, `reason`, and `sources` (HTTPS source URL strings). Do not include usernames, tokens or listening evidence. A dry-run performs catalog reads, requires existing targets, captures catalog/case revisions, and refuses already mapped keys. As in the catalog importer, a catalog album with no stored `catalogRevision` is treated as revision 1 by seeds, the worker, and owner reads. It does not modify the database or overwrite an existing output file.

```sh
npm run listening:mapping-seeds -- --dry-run \
  --environment pilot --bindings /private/path/bindings.json \
  --output /private/path/mapping-plan.json
```

Review the exact plan and printed SHA-256. Applying requires explicit authorization for that named environment, the same target fingerprint, the reviewed file, and its checksum:

```sh
npm run listening:mapping-seeds -- --apply \
  --environment pilot --confirm-environment pilot \
  --plan /private/path/mapping-plan.json --sha256 REVIEWED_SHA256 \
  --reviewer REVIEWER_ID
```

The apply rechecks all target/case revisions and creates mappings, audit records and reprocessing jobs transactionally. Any conflict rolls back the batch. Keep the plan, checksum and command result as the review record. No seed apply or production database access was performed during implementation.

## Monitoring and verification

`listening:metrics` emits aggregates, not individual names or listening histories. Review sync lag, incomplete windows, deferred jobs/provider errors, unresolved observed names, queue age, revoked mappings, baseline-ready and baseline-unavailable names, and `baselineReviews` status counts ([details](TRACKLIST_BASELINES.md#validation-and-operations)). The coverage denominator is **distinct eligible names observed in retained evidence for active connections**. Its numerator requires an active reviewed mapping with a current existing catalog target. An empty denominator is reported as null coverage.

Normal checks remain offline:

```sh
npm test
npm run test:integration
npm run check:catalog-contract
npm --prefix frontend run lint
npm --prefix frontend run build
```

The integration runner includes the listening worker, API and seed transaction suites using temporary replica sets. The Born to Die study positive/negative tests remain regression evidence: recognizing deluxe labels never makes bonus tracks substitute for missing standard tracks. The persistent pipeline has no diary-write dependency.

Browser verification uses synthetic authenticated users and API responses. Real Last.fm authorization, external webhook delivery, hosted callback logging policy, and production capacity require separate supervised pilot verification before rollout.

### Implementation verification — September 26, 2026

- `npm test`: passed, 349 passed and 54 intentionally skipped; no failures.
- `npm run test:integration`: passed, 76 tests against temporary MongoDB replica sets; no failures or skips. Includes preservation of unavailable blank-track evidence through mapping approval and revocation.
- `npm run check:catalog-contract`: passed.
- `npm --prefix frontend run lint` and `npm --prefix frontend run build`: passed; build reports the existing chunk-size warning.
- Mocked Playwright/Chrome browser checks: passed for pause/resume/disconnect/reconnect, callback query removal and a single exchange, approval then revocation without reload, stale revision errors, queue filtering, and desktop/mobile rendering. No console issues were observed.
- `git diff --check`: passed.

These checks do not establish live Last.fm authorization, hosted callback privacy, webhook delivery, or pilot deployment readiness. No live provider test, seed apply, or production database operation was performed.
