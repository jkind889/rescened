# Rescened error and status code reference

Last reviewed: 2026-09-03

This is the central reference for application-defined codes emitted by the Rescened HTTP API, browser client, provider adapters, operator commands, and retained reports. Codes are case-sensitive: for example, `MUSICBRAINZ_HYDRATION_FAILED` and `musicbrainz_hydration_failed` belong to different workflows.

Update this file whenever a stable `code`, report reason, workflow status, or command exit meaning is added or changed. Do not add generic Node.js error numbers such as `ENOENT` or `EEXIST`, MongoDB driver codes such as `11000`, or arbitrary third-party error text; those are implementation details rather than Rescened contracts.

## HTTP error shape

Newer APIs return a JSON object with a human-readable `error` and a stable machine-readable `code`:

```json
{
  "error": "Too many review submissions. Please try again soon.",
  "code": "RATE_LIMITED",
  "retryAfterSeconds": 60
}
```

Optional `details` provide structured conflict or validation context. `RATE_LIMITED` also sets the HTTP `Retry-After` header. Client code should branch on `code`, not the wording of `error`.

Some older catalog and social endpoints still return only `{ "error": "..." }`. Their messages are not stable identifiers. When such a response is handled by the community frontend helper, it receives the synthetic code `HTTP_<status>`.

| HTTP status | General meaning in Rescened |
| --- | --- |
| `400` | The request, identifier, filter, cursor, or payload is invalid. |
| `401` | Clerk did not authenticate a user. |
| `403` | The authenticated user lacks access, or a private resource is hidden. |
| `404` | The requested public resource was not found or is intentionally concealed. |
| `409` | Current state, identity, or optimistic-concurrency checks prevent the mutation. |
| `429` | A Rescened rate-limit bucket was exhausted. |
| `500` | An unexpected internal or database failure occurred. Most older routes do not attach a stable code. |
| `502` | An optional upstream provider failed or returned unusable data. |
| `503` | A feature is disabled or required transactional infrastructure is unavailable. |

## HTTP API codes

### Shared, authentication, and feature controls

| Code | Status | Meaning |
| --- | --- | --- |
| `RATE_LIMITED` | `429` | The applicable global or route-specific request bucket is exhausted. Includes `retryAfterSeconds` and `Retry-After`. |
| `UNAUTHORIZED` | `401` | Clerk did not provide a user ID. This code is explicit on moderator routes; some older authenticated routes return a code-less `401`. |
| `MODERATOR_REQUIRED` | `403` | The authenticated user is not in `MODERATOR_USER_IDS`. |
| `SUBMISSIONS_DISABLED` | `503` | Contributor submission mutations are disabled by `COMMUNITY_SUBMISSIONS_ENABLED`. |
| `MODERATION_DISABLED` | `503` | Moderator mutations are disabled by `COMMUNITY_MODERATION_ENABLED`. |
| `APPROVAL_UNAVAILABLE` | `503` | Approval cannot run because transaction-capable MongoDB is unavailable. No publication fallback is attempted. |
| `REVIEW_DELETION_UNAVAILABLE` | `503` | Review deletion cannot run because transaction-capable MongoDB is unavailable. No cascade write is attempted. |
| `REVIEW_LIKE_UNAVAILABLE` | `503` | Review-like and notification mutation cannot run because transaction-capable MongoDB is unavailable. |
| `REVIEW_PIN_UNAVAILABLE` | `503` | Pinning a review cannot run because transaction-capable MongoDB is unavailable. |
| `POPULAR_REVIEWS_UNAVAILABLE` | `503` | Popular review-history pagination cannot obtain a MongoDB snapshot, snapshot reads are unsupported, or the page exceeds its database time budget. No live-ranking fallback is used. |
| `DIARY_WRITE_UNAVAILABLE` | `503` | A diary or listen-membership mutation requires MongoDB transactions. No partial fallback writes are attempted. |
| `BOARD_WRITE_UNAVAILABLE` | `503` | Board saves, album removals, deletion, or board pinning require MongoDB transactions. |

### Request validation and lookup

| Code | Status | Meaning |
| --- | --- | --- |
| `INVALID_CURSOR` | `400` | An opaque contributor, approved-feed, or moderator pagination cursor could not be decoded or validated. |
| `INVALID_SUBMISSION` | `400` | A suggestion or correction payload, value, URL, date, count, or persisted submission fails validation. |
| `INVALID_MODERATION_REQUEST` | `400` | A moderation body, filter, limit, public ID, reason, or `applyFields` selection is invalid. |
| `INVALID_BOARD_ID` | `400` | A board mutation supplied a client-owned `boardId` or Mongo `_id`; board IDs are server-generated UUID-v4 values. |
| `INVALID_REVIEW_ID` | `400` | A review mutation received a malformed or client-supplied public UUID-v4 `reviewId`; Mongo ObjectIds are rejected. |
| `INVALID_REVIEW_CURSOR` | `400` | A review-list pagination cursor could not be decrypted, does not match its list/sort or supported version, or refers to an expired popular-ranking snapshot. Reload the list from its first page. |
| `INVALID_REVIEW_SORT` | `400` | A review list requested a sort other than `recent` or `popular`. |
| `INVALID_IDEMPOTENCY_KEY` | `400` | A review or diary creation request omitted or supplied a malformed UUID-v4 `Idempotency-Key`. |
| `INVALID_DIARY_REQUEST` | `400` | A diary/board mutation contains unsupported fields, or a diary filter, limit, or board list is invalid. |
| `INVALID_LISTEN_ID` | `400` | A listen identifier is not a public UUID-v4. |
| `INVALID_ALBUM_ID` | `400` | A diary album identifier is not a public UUID-v4. |
| `INVALID_LISTEN_DATE` | `400` | A calendar date is invalid, a listen is in the future in the supplied timezone, or a date range is reversed. |
| `INVALID_TIME_ZONE` | `400` | Creation or date correction omitted or supplied an invalid IANA timezone. |
| `INVALID_DIARY_CURSOR` | `400` | A diary cursor is malformed, cannot be authenticated, or belongs to a different user/filter scope. |
| `LISTEN_NOT_FOUND` | `404` | The requested listen does not exist or is not owned by the caller. Deletion instead returns a successful no-op to conceal ownership. |
| `BOARD_NOT_FOUND` | `404` | A transactional board operation or diary filter targets a missing or unowned board. |
| `ALBUM_NOT_FOUND` | `404` | A diary request references a catalog album that does not exist. |
| `DEFAULT_BOARD_REQUIRED` | `400` | The default saved-albums board cannot be deleted. |
| `IDEMPOTENCY_CONFLICT` | `409` | A diary creation key was already used with different canonical input. |
| `LISTEN_DELETED` | `409` | A creation retry refers to a listen that was subsequently deleted; the retained receipt prevents resurrection. |
| `DIARY_REQUEST_FAILED` | `500` | An unexpected diary route failure; internal database details are not exposed. |
| `INVALID_PINNED_REVIEW` | `400` | A requested pinned review is malformed or is not owned by the profile being updated. |
| `REVIEW_NOT_FOUND` | `404` | A review-like request targeted a review that no longer exists. |
| `SUGGESTION_NOT_FOUND` | `404` | A moderator-visible submission does not exist. Contributor detail and mutation routes currently preserve a code-less `404` to conceal ownership. |
| `CATALOG_TARGET_NOT_FOUND` | `404` | A new correction references a public catalog album that does not exist. |
| `CATALOG_ALBUM_NOT_FOUND` | `409` | An approval command supplies an `albumId` that does not resolve to a usable catalog album. |
| `CATALOG_TARGET_MISSING` | `409` | A previously created correction has lost its target album before revision or approval. |

### Submission and moderation conflicts

| Code | Status | Meaning |
| --- | --- | --- |
| `INVALID_SUBMISSION_STATE` | `409` | The requested revision, withdrawal, moderation action, or approval is invalid from the current workflow state. |
| `REVISION_CONFLICT` | `409` | Another contributor update won the conditional revision write. Reload before retrying. |
| `STATE_CONFLICT` | `409` | A general conditional status/revision update lost a race. Reload before retrying. |
| `INVALID_DUPLICATE_TARGET` | `409` | `duplicateOfSubmissionId` is not another approved submission with a usable catalog album. |
| `EXACT_CATALOG_MATCH` | `409` | An exact catalog identity already exists; the moderator must explicitly select its public `albumId`. |
| `POSSIBLE_DUPLICATE_CONFIRMATION_REQUIRED` | `409` | Advisory duplicate signals exist; the moderator must link a catalog album or explicitly confirm creation. |
| `CATALOG_CHANGED` | `409` | A correction target changed after submission or during its guarded update. |
| `CATALOG_BASELINE_INVALID` | `409` | A correction does not retain a usable positive catalog-revision baseline. |
| `CATALOG_REFERENCE_CONFLICT` | `409` | A proposed external reference is already owned by another catalog album. |
| `APPROVAL_CONFLICT` | `409` | Approval produced no consistent result, or an already-approved suggestion conflicts with the requested album. |
| `APPROVAL_INCONSISTENT` | `409` | A submission says it is approved, but its linked catalog album is missing or unusable. |

### External MusicBrainz search

| Code | Status | Meaning |
| --- | --- | --- |
| `INVALID_EXTERNAL_SEARCH` | `400` | The query, limit, or release-group MBID is invalid. |
| `RATE_LIMITED` | `429` | The Rescened external-search bucket is exhausted; this is not a MusicBrainz response code. |
| `EXTERNAL_SEARCH_UNAVAILABLE` | `502` | MusicBrainz failed, timed out, or returned data that could not be normalized. Local catalog search remains available. |
| `EXTERNAL_SEARCH_DISABLED` | `503` | `EXTERNAL_ALBUM_SEARCH_ENABLED` is off. |

The route deliberately maps internal provider codes to the smaller public vocabulary above so raw upstream details do not leak to clients.

## Rate-limit reference

All listed route-specific buckets are cumulative with the global bucket. Authenticated mutation limiters run after authentication, so anonymous `401` requests do not consume another user's bucket, but before validation and database work.

| Bucket | Protected routes | Key | Budget |
| --- | --- | --- | --- |
| Global API | Every API route except `/health` | IP | 300 requests per 5 minutes |
| Local search | `GET /search/search` | IP | 90 requests per minute |
| External search | `GET /search/external`, `GET /search/musicbrainz/release-group/:mbid` | IP | 30 requests per minute |
| Album save | `POST /boards/:boardId/albums` | authenticated user | 30 attempts per 10 minutes |
| Diary mutation | `POST /diary`, `PATCH`/`DELETE /diary/:listenId`, `PUT`/`DELETE /boards/:boardId/listens/:listenId` | authenticated user | 30 attempts per 10 minutes |
| Review create | `POST /reviews/review` | authenticated user | 6 attempts per 10 minutes |
| Review mutation | `PATCH` and `DELETE /reviews/review/user/:id` | authenticated user | 30 attempts per 10 minutes |
| Like mutation | `PUT /likes/album/:albumId`, `PUT /likes/review/:reviewId` | authenticated user | 120 attempts per 10 minutes |
| Suggestion create | `POST /suggestions`, `POST /suggestions/corrections` | authenticated user | 6 attempts per 10 minutes |
| Suggestion mutation | `POST /suggestions/:submissionId/revise`, `POST /suggestions/:submissionId/withdraw` | authenticated user | 20 attempts per 10 minutes |
| Moderation mutation | Request-changes, reject, duplicate, and approve commands | authenticated moderator | 120 attempts per 10 minutes |

The current implementation uses in-process memory. Counters reset on restart and are not shared between workers or instances. `TRUST_PROXY_HOPS` must match the real proxy chain so IP keys are neither collapsed onto the proxy nor client-spoofable. Unexpected limiter infrastructure errors currently log and fail open; ordinary exhausted buckets fail closed with `429 RATE_LIMITED`.

Source: [`routes/utils/rateLimit.js`](../routes/utils/rateLimit.js).

## Frontend-only codes

These values are created inside the browser and are never promised as server responses.

| Code | Meaning |
| --- | --- |
| `HTTP_<status>` | The server returned an error status without an application code, such as `HTTP_404`. |
| `NETWORK_ERROR` | `fetch` failed at the transport layer, commonly because of connectivity or CORS. |
| `REQUEST_FAILED` | Generic non-network client request failure. |
| `INVALID_RESPONSE` | A successful response could not be read as the expected JSON. |
| `MISSING_SUBMISSION_ID` | The suggestion editor route has no submission identifier. |
| `MISSING_ALBUM_ID` | The correction editor route has no catalog album identifier. |
| `ALBUM_ALREADY_IN_CATALOG` | An external candidate resolved to an existing local catalog album. |

Source: [`frontend/src/features/community/community.js`](../frontend/src/features/community/community.js) and [`frontend/src/Pages/SuggestionEditor.jsx`](../frontend/src/Pages/SuggestionEditor.jsx).

## Provider adapter codes

### Interactive MusicBrainz adapter

These are internal diagnostics. Public external-search routes normally translate them to `INVALID_EXTERNAL_SEARCH` or `EXTERNAL_SEARCH_UNAVAILABLE`.

| Code | Meaning |
| --- | --- |
| `MUSICBRAINZ_SEARCH_FAILED` | Generic interactive search-adapter failure. |
| `MUSICBRAINZ_INVALID_SEARCH_RESPONSE` | A search response is malformed or contains no usable release groups. |
| `MUSICBRAINZ_INVALID_RELEASE_GROUP` | An exact release-group response cannot be validated or normalized. |
| `MUSICBRAINZ_REQUEST_FAILED` | The shared provider request layer failed. |
| `MUSICBRAINZ_PROVIDER_ERROR` | An unexpected provider or adapter error occurred. |
| `INVALID_EXTERNAL_SEARCH` | Adapter input query, limit, or MBID is invalid. |

Source: [`lib/musicBrainzSearch.js`](../lib/musicBrainzSearch.js).

### Cover Art Archive resolver reasons

Lowercase values are row-level resolver outcomes, not HTTP API codes.

| Code | Meaning |
| --- | --- |
| `no_identity` | No valid exact MusicBrainz or barcode identity was supplied. |
| `conflicting_identity` | Supplied identities conflict or include invalid identity data. |
| `barcode_ambiguity` | A barcode resolves to more than one release group. |
| `metadata_mismatch` | Barcode-resolved title or artist does not match the supplied metadata. Backfill normalizes this to `conflicting_identity`. |
| `no_approved_front` | Cover Art Archive has no approved front image for the identity. |
| `no_500px_image` | No usable 500-pixel front image is available. |
| `transient_provider_failure` | A timeout, network failure, retryable response, or exhausted retry occurred. |
| `invalid_response` | A provider response is malformed or unusable. |
| `reference_conflict` | The resolved release identity is owned by another catalog album. |
| `concurrent_update` | The album changed before the optimistic cover write. |
| `cover_art_resolver_error` | Generic resolver exception. |
| `provider_http_error` | Non-transient provider HTTP failure before backfill normalization. |

Backfill aliases `timeout`, `network_error`, `provider_failure`, `retry_exhausted`, and `unavailable` to `transient_provider_failure`. It aliases `provider_http_error`, `bad_response`, and `malformed_response` to `invalid_response`.

Source: [`lib/coverArtArchive.js`](../lib/coverArtArchive.js) and [`scripts/backfillMissingAlbumCovers.js`](../scripts/backfillMissingAlbumCovers.js).

## Catalog fetch, validation, and import codes

### Dataset validation and quarantine

| Code | Meaning |
| --- | --- |
| `INVALID_ENVELOPE` | The top-level dataset object or schema envelope is invalid. |
| `UNSUPPORTED_SCHEMA_VERSION` | `schemaVersion` is unsupported. |
| `UNKNOWN_FIELD` | A schema object contains an unexpected property. |
| `MISSING_FIELD` | A required schema property is absent. |
| `INVALID_ALBUM` | An album row fails schema validation. |
| `UNNORMALIZED_TEXT` | Text is untrimmed or contains control characters. |
| `ARTIST_DISPLAY_MISMATCH` | `artistDisplayName` does not equal the joined artist credits. |
| `INVALID_RELEASE_DATE` | The release date is not a real supported partial calendar date. |
| `INVALID_DATE_TUPLE` | Release date, precision, and year disagree. |
| `MISSING_SELECTED_RANGE_SIGNAL` | The chosen range has no corresponding selection signal. |
| `INVALID_CAA_REFERENCE` | Cover Art Archive identity or canonical URL is inconsistent. |
| `INVALID_SOURCE_TIMESTAMP` | A provider fetch timestamp is invalid. |
| `INVALID_GENERATED_AT` | Dataset generation time is invalid. |
| `DUPLICATE_SELECTION_RANGE` | A selection range appears more than once. |
| `INVALID_RANGE_LIMIT` | A range's candidate limit is below its quota. |
| `INVALID_RANGE_DATES` | Range dates are incomplete, invalid, or reversed. |
| `INVALID_RANGE_TIMESTAMP` | A range fetch timestamp is invalid. |
| `MISSING_SELECTION_RANGE` | The required `all_time`, `year`, or `month` range is absent. |
| `INVALID_QUOTA_TOTAL` | Range quotas do not equal `targetAlbumCount`. |
| `INVALID_ALBUM_COUNT` | The album-row count does not equal `targetAlbumCount`. |
| `DUPLICATE_SOURCE_KEY` | A MusicBrainz release-group identity is repeated. |
| `RANK_EXCEEDS_CANDIDATE_LIMIT` | A selection rank exceeds the declared candidate limit. |
| `PRIMARY_ARTIST_CAP_EXCEEDED` | Accepted rows exceed `maxPerPrimaryArtist`. |
| `RANGE_QUOTA_EXCEEDED` | Accepted rows exceed a selection range's quota. |
| `NO_VALID_ALBUMS` | No valid rows remain after validation/quarantine. |
| `DATASET_READ_FAILED` | The input path is missing, unreadable, or not a regular file. |
| `DATASET_TOO_LARGE` | The input exceeds the 25 MiB limit. |
| `MALFORMED_JSON` | The input is not valid JSON. |

Source: [`lib/catalogImport/dataset.js`](../lib/catalogImport/dataset.js).

### ListenBrainz/MusicBrainz catalog fetch

These lowercase values appear in fetch reports and rejection records.

| Code | Meaning |
| --- | --- |
| `catalog_fetch_failed` | Generic catalog-fetch failure. |
| `http_error` | An upstream HTTP response was unsuccessful. |
| `invalid_json_response` | An upstream response was not valid JSON. |
| `request_timeout` | An upstream request timed out. |
| `network_error` | An upstream network request failed. |
| `invalid_listenbrainz_ranking` | ListenBrainz did not return the required release-group ranking. |
| `listenbrainz_range_mismatch` | ListenBrainz returned a different range than requested. |
| `invalid_release_group_mbid` | A candidate does not contain a valid release-group MBID. |
| `invalid_listen_count` | A listen count is not a non-negative integer. |
| `invalid_musicbrainz_release_group` | Hydrated MusicBrainz release-group data is invalid. |
| `musicbrainz_identity_mismatch` | Hydrated identity differs from the selected candidate. |
| `missing_artist_credits` | A release group has no artist credits. |
| `artist_credits_too_large` | A release group has more than 64 artist credits. |
| `invalid_artist_credit` | An artist credit lacks a valid identity or name. |
| `artist_credit_name_too_long` | An artist-credit name exceeds 300 characters. |
| `artist_join_phrase_too_long` | An artist join phrase exceeds 32 characters. |
| `invalid_artist_display_name` | Computed artist display text is empty or exceeds 500 characters. |
| `invalid_release_group_title` | Release-group title is empty or exceeds 500 characters. |
| `selected_range_signal_missing` | The selected range is missing from the mapped signals. |
| `invalid_mapped_album` | Provider data maps to a row that fails the strict dataset contract. |
| `musicbrainz_hydration_failed` | Fallback rejection when MusicBrainz hydration fails without a more specific code. |
| `primary_artist_cap` | The selected release exceeds the primary-artist cap. |
| `catalog_quota_unfilled` | The configured catalog mix could not be filled. |
| `invalid_dataset_id` | The generated dataset ID is not a UUID. |
| `generated_dataset_invalid` | The generated dataset fails final strict validation. |
| `artifact_destination_not_file` | A fetch artifact destination exists but is not a regular file. |

Source: [`lib/catalogImport/listenBrainz.js`](../lib/catalogImport/listenBrainz.js).

### Import preflight, apply, and artifacts

| Code | Meaning |
| --- | --- |
| `CATALOG_IMPORT_FAILED` | Generic import failure. |
| `DATASET_VALIDATION_FAILED` | Generic validation-command failure. |
| `INVALID_ARGUMENTS` | CLI flags or values are missing, duplicated, unknown, or contradictory. |
| `INVALID_ARTIFACT_PATHS` | Input and report paths collide. |
| `INVALID_VALIDATION_RESULT` | Import preflight did not receive a usable validation result. |
| `INVALID_IMPORT_PLAN` | Apply did not receive a usable preflight plan. |
| `MISSING_SOURCE_KEY` | A preflight row lacks its release-group identity. |
| `EXISTING_REFERENCE_CONFLICT` | More than one existing row, or another owner, claims a source reference. |
| `EXISTING_CATALOG_CONFLICT` | A matching catalog row is owned by a manual or community source and is not overwritten. |
| `DUPLICATE_MUSICBRAINZ_REFERENCE` | Two rows in the same batch claim the same MusicBrainz identity. |
| `FINAL_DOCUMENT_SEMANTIC_INVALID` | A merged row violates date, reference, or cover invariants. |
| `MODEL_VALIDATION_FAILED` | A merged catalog row fails Mongoose validation. |
| `CONCURRENT_CATALOG_CHANGE` | An imported row changed between preflight and its guarded write. |
| `TRANSACTION_UNAVAILABLE` | Transaction-capable MongoDB is unavailable. |
| `TRANSACTION_ROLLED_BACK` | The import transaction did not commit. |
| `MISSING_MONGO_URI` | `MONGO_URI` was not supplied. |
| `ARTIFACT_STAGE_FAILED` | A report artifact could not be staged safely. |
| `ARTIFACT_FINALIZATION_FAILED` | One or more staged artifacts could not be finalized before a database commit. |
| `IMPORT_COMMITTED_ARTIFACT_FINALIZATION_FAILED` | Database writes committed, but final report publication failed. Do not treat this as a rollback. |
| `IMPORT_COMMITTED_SESSION_CLEANUP_FAILED` | Database writes committed, but Mongo session cleanup failed. Do not treat this as a rollback. |

Source: [`lib/catalogImport/persistence.js`](../lib/catalogImport/persistence.js), [`scripts/validateCatalogDataset.js`](../scripts/validateCatalogDataset.js), and [`scripts/importCatalogDataset.js`](../scripts/importCatalogDataset.js).

## Cover backfill command codes

| Code | Meaning |
| --- | --- |
| `COVER_BACKFILL_FAILED` | Generic fatal backfill failure. |
| `INVALID_ARGUMENTS` | CLI flags are invalid, duplicated, or contradictory. |
| `RESOLVER_UNAVAILABLE` | The Cover Art Archive resolver cannot be loaded or invoked. |
| `DATABASE_WRITE_FAILED` | MongoDB did not acknowledge a guarded cover update. |
| `MISSING_MONGO_URI` | `MONGO_URI` was not supplied. |

Row statuses are `resolved` in dry-run mode, `updated` after a successful apply, `unresolved` when no safe cover is available, `conflict` when identity or optimistic-concurrency checks fail, and `failed` for a row-scoped provider failure. The report schema also counts `skipped`, although the current implementation does not produce that status.

Source: [`scripts/backfillMissingAlbumCovers.js`](../scripts/backfillMissingAlbumCovers.js).

## Community reconciliation command codes

| Code | Meaning |
| --- | --- |
| `COMMUNITY_RECONCILIATION_FAILED` | Generic reconciliation failure. |
| `INVALID_ARGUMENTS` | CLI flags are invalid, missing, or contradictory. |
| `TARGET_CONFIRMATION_REQUIRED` | Apply was requested without `--confirm-target`. |
| `REPORT_REQUIRED` | Apply was requested without an explicit reviewed report path. |
| `REPORT_READ_FAILED` | The reviewed report cannot be read. |
| `REPORT_NOT_REVIEWABLE` | The supplied artifact is not an eligible dry-run report. |
| `REPORT_INVALID` | The reconciliation plan inside the report is invalid. |
| `AMBIGUOUS_RECONCILIATION` | Historical records require operator review before apply. |
| `TRANSACTION_UNAVAILABLE` | Transaction-capable MongoDB is unavailable. |
| `CONCURRENT_RECONCILIATION` | A catalog row or submission changed after the reviewed plan was created. |
| `TARGET_CONFIRMATION_FAILED` | `--confirm-target` does not equal the connected database. |
| `MISSING_MONGO_URI` | `MONGO_URI` was not supplied. |
| `RECONCILIATION_COMMITTED_SESSION_CLEANUP_FAILED` | Reconciliation committed, but session cleanup failed. Do not treat this as a rollback. |

Source: [`scripts/reconcileCommunityPublication.js`](../scripts/reconcileCommunityPublication.js).

## Review-ID migration command codes

| Code | Meaning |
| --- | --- |
| `REVIEW_ID_MIGRATION_FAILED` | Generic review-ID migration failure. |
| `INVALID_ARGUMENTS` | CLI flags are invalid, missing, or contradictory. |
| `MISSING_MONGO_URI` | `MONGO_URI` was not supplied. |
| `TARGET_CONFIRMATION_REQUIRED` | Apply was requested without `--confirm-target`. |
| `TARGET_CONFIRMATION_FAILED` | The confirmed target does not match the connected database or collection. |
| `REPORT_REQUIRED` | Apply was requested without an explicit reviewed report path. |
| `REPORT_EXISTS` | A dry-run destination already exists and was not replaced. |
| `REPORT_READ_FAILED` | The reviewed report cannot be read. |
| `REPORT_CHECKSUM_MISSING` | The reviewed report’s adjacent SHA-256 artifact is missing. |
| `REPORT_CHECKSUM_MISMATCH` | The reviewed report differs from its file checksum. |
| `PLAN_CHECKSUM_MISMATCH` | The embedded canonical plan checksum differs. |
| `REPORT_NOT_REVIEWABLE` | The artifact is not a review-ID dry-run report. |
| `REPORT_INVALID` | The report’s identity mapping or batch structure is invalid. |
| `UUID_GENERATION_FAILED` | The command could not generate a unique canonical UUID-v4 assignment. |
| `BLOCKING_REVIEW_IDS` | Existing malformed or duplicate review IDs require operator review before apply. |
| `TARGET_BASELINE_MISMATCH` | The reviews collection identity, documents, or planned ID state changed after dry run. |
| `REVIEW_TARGET_DELETED` | A planned review was deleted before its ID could be assigned. |
| `REVIEW_ID_CONFLICT` | A planned review acquired a different ID before assignment. |
| `TRANSACTION_UNAVAILABLE` | A transaction-capable MongoDB deployment is unavailable. |
| `REVIEW_ID_MIGRATION_COMMIT_OUTCOME_UNKNOWN` | MongoDB could not confirm a batch commit. Database changes may have committed; retain the report and progress artifact, then retry only after inspection. |
| `REVIEW_ID_INDEX_CONTRACT_MISMATCH` | An existing `reviewId_1` index does not enforce the required unique full-field contract. |
| `REVIEW_ID_UNIQUE_INDEX_FAILED` | The unique `reviewId_1` index could not be created. |
| `REVIEW_ID_VERIFICATION_FAILED` | Post-apply UUID coverage, uniqueness, or index verification failed. Database changes may already be committed. |
| `PROGRESS_READ_FAILED` | The durable apply-progress artifact cannot be read. |
| `PROGRESS_PLAN_MISMATCH` | The durable apply-progress artifact belongs to another reviewed plan. |
| `PROGRESS_WRITE_FAILED` | The initial apply-progress artifact could not be written before a database write. |
| `REVIEW_ID_MIGRATION_COMMITTED_PROGRESS_WRITE_FAILED` | A batch or index was committed, but its durable progress update could not be written. Do not treat this as a rollback. |
| `REVIEW_ID_MIGRATION_COMMITTED_SESSION_CLEANUP_FAILED` | A batch committed, but session cleanup failed. Do not treat this as a rollback. |
| `REVIEW_ID_MIGRATION_COMMITTED_FAILED` | A database change committed before an otherwise uncategorized later failure. Do not treat this as a rollback. |

Source: [`scripts/migrateReviewIds.js`](../scripts/migrateReviewIds.js). Apply is report-bound and may commit an earlier batch before a later batch, progress write, index build, or verification error. The command marks those failures as committed in its console output; retain the report and progress artifact before retrying.

## Legacy migration codes

### Runtime, plan, apply, and verification

| Code | Meaning |
| --- | --- |
| `LEGACY_MIGRATION_FAILED` | Generic migration failure. |
| `INVALID_ARGUMENTS` | CLI mode or flag combination is invalid. |
| `MISSING_ENV` | A required migration URI or environment value is absent. |
| `SOURCE_NAMESPACE_INVALID` | A source/target URI lacks an explicit safe database namespace, or the connected source is unexpected. |
| `SOURCE_TARGET_COLLISION` | Source and target resolve to the same database. |
| `INVALID_RUN_DIRECTORY` | The requested run directory is dangerously broad. |
| `MIGRATION_LOCKED` | Another process owns the filesystem lock or database lease. |
| `OVERRIDE_INVALID` | The override file, decision, provenance, or identifier is invalid. |
| `INVENTORY_DRIFT` | Current source/target data no longer matches the stored inventory. |
| `INVENTORY_REQUIRED` | A required sealed plan or inventory artifact cannot be read. |
| `CLERK_IDENTITY_CHECK_FAILED` | Required Clerk identity verification failed. |
| `BLOCKING_QUARANTINE` | Unresolved catalog/social conflicts prevent a safe plan. |
| `PLAN_VALIDATION_FAILED` | Generated target documents fail schema or relationship validation. |
| `PLAN_CHECKSUM_MISMATCH` | The supplied or embedded sealed-plan checksum differs. |
| `INDEX_BUILD_FAILED` | A required index cannot be built or conflicts with the expected contract. |
| `TARGET_CONFIRMATION_FAILED` | The named target differs from the connected database or sealed plan. |
| `TARGET_BASELINE_MISMATCH` | The target database changed after planning. |
| `TARGET_DRIFT` | A target key, ledger, or completed-batch state differs from the sealed plan. |
| `BATCH_PRECONDITION_FAILED` | A batch's expected before-state no longer matches. |
| `TRANSACTION_UNAVAILABLE` | Transaction-capable MongoDB is unavailable. |
| `TRANSACTION_ROLLED_BACK` | A migration batch failed without committing. |
| `APPLY_COMMITTED_REPORT_FAILED` | Migration committed, but the apply report could not be written. Do not rerun as though it rolled back. |
| `APPLY_COMMITTED_VERIFICATION_FAILED` | Migration committed, but candidate verification failed. Reconcile the committed state. |
| `RECONCILIATION_FAILED` | Candidate contents or migration ledger do not match the sealed plan. |
| `RELATIONSHIP_INVALID` | Post-migration relationship verification found invalid references. |
| `ARTIFACT_EXISTS` | A sealed artifact already exists and overwrite permission was not given. |

### Catalog crosswalk and provider issues

| Code | Meaning |
| --- | --- |
| `BLOCKING_SOCIAL_ALBUM` | Social records depend on an album that was neither created nor safely reused. |
| `MANUAL_REVIEW_REQUIRED` | Catalog identity cannot be resolved automatically. |
| `MISSING_RELEASE_GROUP` | No release-group identity can be established. |
| `MUSICBRAINZ_URL_LOOKUP_FAILED` | MusicBrainz URL relationship lookup failed. |
| `MUSICBRAINZ_RELEASE_LOOKUP_FAILED` | Release hydration failed. |
| `MUSICBRAINZ_RELEASE_GROUP_LOOKUP_FAILED` | Release-group hydration failed. |
| `MUSICBRAINZ_RELEASE_GROUP_NOT_FOUND` | MusicBrainz has no usable release-group record for the identity. |
| `TARGET_REFERENCE_CONFLICT` | Multiple target albums claim the same MusicBrainz reference. |
| `AMBIGUOUS_EDITION` | Candidate editions have incompatible tracklists and require a decision. |

### Social transform issues

| Code | Meaning |
| --- | --- |
| `UNRESOLVED_REVIEW_ALBUM` | A legacy review cannot be mapped to a catalog album. |
| `INVALID_REVIEW` | A legacy review lacks valid required data. |
| `TARGET_REVIEW_CONFLICT` | The target review identity is already occupied incompatibly. |
| `UNRESOLVED_BOARD_ITEM` | A board item cannot resolve both its board and album. |
| `INVALID_FOLLOW` | A follow record is malformed. |
| `ORPHAN_REVIEW_LIKE` | A review like references a missing review and is archived. |
| `UNRESOLVED_ALBUM_LIKE` | An album like cannot resolve its album or user. |
| `INVALID_NOTIFICATION` | A notification has invalid actors, recipient, or type. |
| `ORPHAN_REVIEW_NOTIFICATION` | A review-like notification references a missing review and is archived. |
| `INVALID_PROFILE` | A profile lacks a usable user identity. |

### MusicBrainz hydration and mapped metadata issues

| Code | Meaning |
| --- | --- |
| `MUSICBRAINZ_INVALID_ARTIST_CREDIT` | Hydrated artist credits lack valid artist identities. |
| `MUSICBRAINZ_INVALID_RELEASE_GROUP` | Hydrated release-group identity/title is invalid. |
| `MUSICBRAINZ_INVALID_MBID` | A release or release-group MBID is invalid. |
| `MUSICBRAINZ_RELEASE_GROUP_MISMATCH` | A hydrated release belongs to a different release group. |
| `MUSICBRAINZ_CACHE_LOCKED` | Another process owns the provider-cache lock. |
| `MUSICBRAINZ_ID_MISMATCH` | A cached or live response identity differs from the requested identity. |
| `MUSICBRAINZ_HYDRATION_FAILED` | A live provider hydration request failed. |
| `INVALID_DISC_POSITION` | A medium/disc number is invalid. |
| `INVALID_TRACK_POSITION` | A track number is invalid. |
| `MISSING_TRACK_TITLE` | A hydrated track has no title. |
| `INVALID_TRACK_DURATION` | A track duration is missing, negative, or nonnumeric. |
| `TRACKLIST_TOO_LARGE` | The mapped tracklist exceeds the model limit. |
| `DUPLICATE_TRACK_POSITION` | More than one track claims the same disc/track position. |
| `MULTIPLE_LABELS` | A release exposes multiple labels and cannot be reduced automatically. |

### Target validation issues

| Code | Meaning |
| --- | --- |
| `FORBIDDEN_LEGACY_FIELD` | An active target document still contains a prohibited generation-1/provider field. |
| `MODEL_VALIDATION_FAILED` | A target document fails its Mongoose model validation. |
| `DUPLICATE_ALBUM_ID` | More than one album has the same public `albumId`. |
| `DUPLICATE_EXTERNAL_REFERENCE` | More than one catalog row owns the same external identity. |
| `DUPLICATE_TRACK_ID` | A catalog album repeats a public `trackId`. |
| `DUPLICATE_TRACK_POSITION` | A catalog album repeats a disc/track position. |
| `DUPLICATE_DEFAULT_BOARD` | A user has more than one default board. |
| `DANGLING_BOARD` | A board item references a missing board. |
| `BOARD_OWNER_MISMATCH` | A board item's user differs from the board owner. |
| `DANGLING_ALBUM` | A board item or review references a missing catalog album. |
| `DUPLICATE_BOARD_ITEM` | A board contains the same album more than once. |
| `DANGLING_REVIEW` | A notification references a missing review. |
| `INVALID_LIKE_TARGET` | A like has neither a valid album nor a valid review target. |
| `DUPLICATE_LIKE` | A user has duplicate likes for one target. |
| `DUPLICATE_FAVORITE_RANK` | A profile repeats a favorite-album rank. |
| `DANGLING_FAVORITE` | A profile favorite references a missing album. |
| `DANGLING_PINNED_REVIEW` | A profile references a missing pinned review. |
| `DANGLING_PINNED_BOARD` | A profile references a missing pinned board. |

Source: [`lib/legacyMigration`](../lib/legacyMigration) and [`scripts/migrateLegacyDatabase.js`](../scripts/migrateLegacyDatabase.js). See [Legacy data migration workflow](./LEGACY_DATA_MIGRATION_WORKFLOW.md) before acting on any migration code.

## Workflow statuses and command exit codes

These are not error codes, but they frequently appear beside them in API responses and reports.

| Workflow | Values |
| --- | --- |
| Submission status | `pending`, `needs_changes`, `approved`, `rejected`, `duplicate`, `withdrawn` |
| Submission type | `new_album`, `catalog_correction` |
| Approval publication type | `catalog_created`, `catalog_linked`, `catalog_corrected` |
| Catalog-fetch report | `running`, `complete`, `incomplete`, `failed` |
| Cover resolver | `resolved`, `unresolved` |
| Cover backfill row | `resolved`, `updated`, `unresolved`, `conflict`, `failed` |
| Import action | `inserted`, `refreshed`, `unchanged` |
| Migration catalog action | `created`, `reused`, `quarantined`, `archived` |
| Migration ledger | `running`, `completed` |

Operator commands use these process exit meanings unless their maintained runbook states otherwise:

| Exit code | Meaning |
| --- | --- |
| `0` | The command completed successfully with no unresolved report entries. |
| `1` | A fatal command, database, transaction, or artifact error occurred. Read the named code and report before retrying. |
| `2` | The command completed but retained quarantined, unresolved, conflicting, or ambiguous entries that require review. |

## Similar names that are intentionally distinct

- `CATALOG_TARGET_NOT_FOUND` is a creation-time `404`; `CATALOG_TARGET_MISSING` is a stale-workflow `409`.
- `REVISION_CONFLICT` is contributor-revision specific; `STATE_CONFLICT` is the general conditional-write conflict.
- Uppercase `MUSICBRAINZ_INVALID_RELEASE_GROUP`, `MUSICBRAINZ_HYDRATION_FAILED`, and `MUSICBRAINZ_INVALID_MBID` are interactive-search or migration diagnostics. Lowercase `invalid_musicbrainz_release_group`, `musicbrainz_hydration_failed`, and `invalid_release_group_mbid` belong to catalog-fetch reports.
- `MISSING_ENV` belongs to the sealed legacy migration workflow. Other operator commands use `MISSING_MONGO_URI`.
- `RECONCILIATION_FAILED` verifies a sealed legacy migration; `COMMUNITY_RECONCILIATION_FAILED` is the community-publication metadata reconciler.
- `DANGLING_ALBUM` covers both board-item and review relationships. `DANGLING_REVIEW` covers notification-to-review relationships.

## Maintenance checklist

When introducing or changing a code:

1. Keep it stable. Prefer uppercase for new HTTP/operator exception codes, and preserve the established lowercase provider/report vocabularies.
2. Document its producer, response/report context, retry semantics, and whether a failure may have committed database changes.
3. Add a focused test for the status, `code`, and any required metadata such as `details` or `Retry-After`.
4. Preserve existing code/status pairs unless an API migration is explicitly planned.
5. Keep provider-native and internal errors behind a small public API vocabulary.
