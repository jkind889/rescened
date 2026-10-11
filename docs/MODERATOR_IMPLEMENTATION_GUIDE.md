# Moderator Implementation Guide

Status: Current end-to-end walkthrough; rollout and verification caveats called out below

Last reviewed: 2026-09-02

This guide explains how the Rescened moderator code fits together and what happens during each request. It is a companion to the [Phase 2 submission contract](./PHASE_2_SUBMISSIONS.md), not a second API specification. When this guide and the contract differ, verify the current code and update both documents in the same change.

The [central error and status code reference](./ERROR_CODES.md) is the maintained cross-workflow index for API codes, rate limits, provider diagnostics, operator reports, and process exits.

The backend now recognizes two submission types. A `new_album` approval either creates a catalog album or links without overwriting an existing album. A `catalog_correction` approval applies an explicit subset of proposed field groups to one existing album. The anonymous approved-submission feed is implemented on the contributor router, not the moderator router.

The React workflow now includes a contributor correction form, baseline/current/proposed moderator diff, `applyFields` selection, a visible submission-type queue filter, and a public approved-feed page. Historical approval/catalog-revision reconciliation is implemented as a dry-run-first operator command, and dedicated replica-set correction coverage is included in the integration suite. Final rollout still requires running the reviewed reconciliation artifact in the target environment and completing a signed-in smoke pass.

## The sixty-second mental model

Remember these six rules:

1. The moderator queue and detail are private reads. They require Clerk authentication and a server-side moderator allowlist, but they remain available when moderator writes are disabled.
2. Every moderator command uses `POST`. A first state-changing command must target a pending submission; an already-approved approval retry is the deliberate idempotent exception. Request changes, reject, and mark duplicate each perform one conditional `AlbumSubmission` update.
3. First-time approval branches on server-owned `submissionType`. A new-album approval creates or links; a correction approval applies only the requested `applyFields` to its fixed target.
4. Every first-time approval is transactional. The catalog write or link, submission transition, approval metadata, and audit event commit together. An already-approved retry is read-only and returns before opening a transaction.
5. Supplying `albumId` for a new album means **link without overwriting**. A correction is a separate workflow guarded by the target's internal `catalogRevision`; it never changes `albumId`, `_id`, or `catalogSource`.
6. The frontend renders both approval modes, but the Express API still owns authorization, type selection, stale-write detection, validation, and publication safety.

## Vocabulary that is easy to mix up

| Term | Meaning |
| --- | --- |
| `submissionId` | Public UUID for the private community workflow record. Moderator route parameters use this ID. |
| `albumId` | Public Rescened UUID for a usable `AlbumCatalog` record. It is never an upstream provider ID. |
| Mongo `_id` | Internal relation and cursor key. It is used inside queries and references but is not an API resource ID. |
| Duplicate signal | Advisory evidence found by the server. It does not change state by itself. |
| Mark duplicate | A terminal moderator decision that points to another approved community submission. |
| Link approval | Approve while selecting an existing catalog `albumId`; no album metadata changes. |
| Create approval | Approve without `albumId`; the service creates a new catalog album. |
| `submissionType` | Server-owned discriminator: `new_album` or `catalog_correction`. Existing submissions default to `new_album`. |
| Catalog correction | A private proposal against one existing album. Approval applies a non-empty subset of its proposed field groups. |
| `applyFields` | Moderator-selected field groups to apply for a correction. It is invalid for ordinary new-album approval. |
| `catalogRevision` | Internal optimistic-concurrency token. A correction must match its stored baseline and increments the token once. |
| Publication type | `catalog_created`, `catalog_linked`, or `catalog_corrected`; stored with immutable `approvedAt` for the public feed. |

## Code map

| File | Responsibility |
| --- | --- |
| `server.js` | Installs global middleware and mounts the moderator router at `/moderation/album-suggestions`. |
| `routes/moderation.js` | Authentication, moderator authorization, queue/detail reads, command routes, conditional non-approval transitions, and HTTP error mapping. |
| `routes/utils/moderation.js` | Strict command-body normalization, filter/cursor parsing, moderator error classes, UUID validation, and transaction-unavailable detection. |
| `routes/suggestions.js` | Contributor create/correction/history/detail/revise/withdraw API plus the anonymous approved feed. |
| `routes/utils/approval.js` | Idempotent, transaction-backed approval; new-album create/link behavior; correction patches; duplicate/reference conflict checks; catalog provenance. |
| `routes/utils/submissions.js` | Moderator allowlist parsing, new-album and correction normalization, duplicate discovery, private serialization, and approved-feed serialization/cursors. |
| `routes/utils/rateLimit.js` | Global IP limiter and the per-moderator command limiter. |
| `routes/utils/albumCatalog.js` | Catalog input normalization, UUID generation, public album serialization, lookup, and create-only persistence. |
| `models/AlbumSubmission.js` | Workflow states, typed revisions, correction baselines, approval/feed metadata, audit events, internal catalog references, indexes, and append-only update safeguards. |
| `models/AlbumCatalog.js` | Authoritative public album data, Rescened IDs, external-reference uniqueness, field provenance, and internal `catalogRevision`. |
| `lib/catalogImport/persistence.js` and `scripts/backfillMissingAlbumCovers.js` | Maintained catalog writers that guard and advance `catalogRevision` when they mutate an existing album. |
| `frontend/src/Pages/ModerationSuggestions.jsx` | Queue/detail data loading, filters, routing, command requests, feedback, and refresh behavior. |
| `frontend/src/Components/ProtectedRoute.jsx` | Signed-in UI gate only; it does not authorize moderators. |
| `frontend/src/Pages/SuggestionEditor.jsx` and `frontend/src/Components/Community/CorrectionForm.jsx` | New correction creation/revision entry point, field-group editor, evidence collection, and request construction. |
| `frontend/src/Pages/ApprovedSuggestions.jsx` | Anonymous `/community/approved` page and cursor pagination. |
| `frontend/src/Components/Community/ModeratorDecision.jsx` | Type-aware decision form, correction field selection, new-album duplicate resolution, client validation, and request construction. |
| `frontend/src/Components/Community/SubmissionDetails.jsx` | Proposal/evidence/history presentation plus correction baseline/current/proposed diffs and stale markers. |
| `frontend/src/features/community/community.js` | Shared response parsing, stable API-error extraction, and `Retry-After` handling. |
| `tests/moderation.test.js` | Fast route and approval contract tests with mocked persistence. |
| `tests/deferredSubmissions.test.js` | Focused mocked tests for correction normalization/application and approved-feed privacy/cursors. |
| `tests/moderation.integration.test.js` | Replica-set-backed transaction, rollback, concurrency, provenance, and model-invariant tests. |

## Request pipeline

```mermaid
flowchart TD
    UI[Moderator UI with Clerk token] --> API[/moderation/album-suggestions]
    API --> AUTH[authenticate]
    AUTH --> ALLOW[moderatorOnly]
    ALLOW --> KIND{Read or command?}
    KIND -->|Queue or detail read| READ[Query and sanitize submission data]
    KIND -->|POST command| FLAG[moderationEnabled]
    FLAG --> LIMIT[Per-moderator rate limit]
    LIMIT --> BODY[Strict command-body normalization]
    BODY --> SIMPLE{Approval?}
    SIMPLE -->|No| TRANSITION[Conditional single-document transition]
    SIMPLE -->|Yes| APPROVAL[approveAlbumSubmission]
    APPROVAL --> TYPE{submissionType}
    TYPE -->|new_album| COVER[Optional cover resolution before transaction]
    COVER --> NEWTX[Mongo transaction: recheck, create or link, approve, audit]
    TYPE -->|catalog_correction| FIELDS[Validate applyFields]
    FIELDS --> CORTX[Mongo transaction: revision guard, patch album, approve, audit]
```

Server-wide middleware runs before the router: JSON parsing, CORS, the global IP rate limit, and Clerk middleware. The route-level checks then run in the order shown above. This ordering means an anonymous caller cannot consume the moderator-specific user bucket, and a disabled command cannot reach persistence. Only new-album creation may call the cover resolver; correction approval is provider-free.

## Authentication, authorization, flags, and limits

The frontend `ProtectedRoute` checks only whether someone is signed in. It does not know the server-side moderator allowlist and must not be treated as authorization.

The backend checks are:

| Check | Applies to | Failure |
| --- | --- | --- |
| Clerk `userId` from `getAuth(req)` | Every moderator route | `401 UNAUTHORIZED` |
| Membership in comma-separated `MODERATOR_USER_IDS` | Every moderator route | `403 MODERATOR_REQUIRED` |
| `COMMUNITY_MODERATION_ENABLED=true` | Commands only | `503 MODERATION_DISABLED` |
| Global limit: 300 requests per IP per five minutes | All API routes except `/health` | `429 RATE_LIMITED` |
| Moderator limit: 120 commands per user per ten minutes | Moderator commands only | `429 RATE_LIMITED` |

The two read routes deliberately ignore `COMMUNITY_MODERATION_ENABLED`, so moderators can inspect the queue and history while writes are paused. Moderator commands do not consult `COMMUNITY_SUBMISSIONS_ENABLED`; that separate flag controls contributor mutations.

Both rate limiters use process memory. Multiple API processes therefore do not share counters.

## Queue read

```http
GET /moderation/album-suggestions
```

The queue accepts:

- `status`: comma-separated workflow states; defaults to `pending`.
- `submissionType`: optional exact `new_album` or `catalog_correction` filter.
- `hasPossibleDuplicate`: `true` or `false`.
- `submittedByUserId`: exact Clerk user ID.
- `limit`: 1–50; defaults to 20.
- `cursor`: the opaque cursor from the previous page.

The query sorts oldest activity first by `{ updatedAt: 1, _id: 1 }`. The cursor contains those two ordering values and advances with `updatedAt > cursor.updatedAt`, then `_id > cursor.id` for timestamp ties. The ObjectId remains encoded and is never returned as a standalone resource identifier.

The cursor is opaque but unsigned, and it does not encode the active filter set. Reusing it after changing status, submission type, duplicate, or submitter filters can reposition or skip queue results. The frontend correctly clears pagination when filters are applied; other clients should do the same. Cursor tampering cannot bypass the moderator allowlist.

The route requests `limit + 1` records to determine whether another page exists. It populates a correction's target album, serializes the first page with the common submission serializer, then adds `sourceCount` and unique `sourceTypes`. Queue entries omit revision and moderation-history arrays. A correction entry includes `targetAlbum`, `baseCatalogRevision`, `baseValues`, and `proposedChanges`; selecting the record opens the full baseline/current/proposed review diff.

## Detail read

```http
GET /moderation/album-suggestions/:submissionId
```

`findDetail()` loads the submission and populates:

- The possible existing catalog album.
- The approved catalog album, if any.
- The correction target catalog album, if any.
- A duplicate target submission and its approved album.
- Candidate submissions found during duplicate discovery.

The response has two branches:

```text
suggestion
  -> submissionType and full current proposal
  -> supporting evidence and external references
  -> revision snapshots
  -> moderation history
  -> public candidate/approved album IDs where available
  -> for corrections: target album, baseline revision/values/provenance, and proposed changes

duplicateCandidates
  -> catalogAlbums[] with public album IDs and core metadata
  -> submissions[] with public submission IDs and limited workflow metadata
```

`duplicateCandidates()` deliberately rebuilds sanitized objects. It does not return raw match keys, catalog ObjectIds, or submission ObjectIds. Correction `baseProvenance` is included only because moderator detail calls the serializer with `moderator: true`; ordinary contributor serialization omits that internal audit context.

## Command routes

Command normalization allows only the documented JSON fields. Unknown fields are rejected before persistence; the client cannot submit status, reviewer identity, revision numbers, or audit events.

One current route-level quirk is `normalizeCommandBody(req.body || {}, action)`: a JSON `null` body is coerced to `{}`. New-album approval therefore treats `null` like an empty create-approval command. Correction approval still fails because it requires `applyFields`, and commands requiring a reason also fail. Clients should always send a JSON object.

| Command | Body | Current transition/effect |
| --- | --- | --- |
| `POST /:submissionId/request-changes` | `{ reason }` | `pending → needs_changes` |
| `POST /:submissionId/reject` | `{ reason }` | `pending → rejected` |
| `POST /:submissionId/mark-duplicate` | `{ duplicateOfSubmissionId, reason }` | `pending → duplicate` |
| `POST /:submissionId/approve` for `new_album` | `{ albumId?, confirmPossibleDuplicate?, reason? }` | `pending → approved` plus catalog create/link |
| `POST /:submissionId/approve` for `catalog_correction` | `{ applyFields, reason? }` | `pending → approved` plus guarded field patch |

Reasons are trimmed and capped at 1,000 characters. They are required for request changes and reject. Approval and mark-duplicate reasons are optional; a blank duplicate reason is stored as "Duplicate of an approved suggestion." Public IDs must be UUID v4 values. Correction `applyFields` must be a non-empty, duplicate-free subset of the correction's proposed field groups. A correction approval rejects `albumId` and any supplied duplicate-confirmation option. The approval service rejects `applyFields` on a new-album request, so the two approval contracts cannot be mixed.

These are `POST` commands because the client is asking the server to perform a workflow transition and append server-authored audit data. The request is not a complete replacement representation for either the submission or album. Approval is nevertheless application-level idempotent, as described below.

### The shared non-approval transition

Request changes, reject, and mark duplicate all call `transition()` in `routes/moderation.js`:

1. Normalize and validate the action body.
2. Read the submission by public `submissionId`.
3. Require its current status to be `pending`.
4. For mark duplicate, load the target submission and require another `approved` submission with an `approvedAlbumCatalogId`.
5. Run `findOneAndUpdate()` with `{ submissionId, status: "pending", currentRevision }`.
6. Set the new state and append one server-authored moderation event.
7. Reload and return moderator detail.

The conditional filter protects against another command winning after the preliminary read. If it no longer matches, the route returns `409 STATE_CONFLICT`. Repeating a successful non-approval command returns a terminal-state conflict rather than appending a second audit event.

These commands touch only one submission document, so they do not open a Mongo transaction. Approval uses a transaction because it coordinates `AlbumCatalog` and `AlbumSubmission` writes.

### Mark duplicate versus link approval

This distinction is a common source of confusion:

- Use **mark duplicate** when another approved *community submission* is the canonical workflow record. The command accepts that other public `submissionId`.
- Use **approve with `albumId`** when the album already exists in the catalog, regardless of whether it came from an import, manual entry, or another community approval.
- A catalog-only match is not a valid `duplicateOfSubmissionId` target.

The current duplicate-target check verifies approved status and a non-null album reference. It does not re-read the referenced catalog album itself, so a dangling `approvedAlbumCatalogId` is a known integrity edge case rather than an expected state.

## Approval in detail

The route normalizes the small command body, then delegates all publication behavior to `approveAlbumSubmission()`. The service first reads the submission without a session. If it is already approved, the service returns the existing album with `idempotent: true` before cover work, type-specific body validation, or a new transaction. A first approval must still be pending.

### New-album create or link

| Situation | Result |
| --- | --- |
| `albumId` is present | Load that exact local catalog album and link it. Do not apply proposal metadata, cover, or references to it. |
| `albumId` is absent and there are no blocking duplicate signals | Create a new community catalog album. |
| Exact catalog identity exists and `albumId` is absent | Return `409 EXACT_CATALOG_MATCH` with safe candidate album IDs. Confirmation cannot override an exact identity. |
| Advisory duplicate signals exist, `albumId` is absent, and confirmation is false | Return `409 POSSIBLE_DUPLICATE_CONFIRMATION_REQUIRED`. |
| Advisory duplicate signals exist and `confirmPossibleDuplicate` is true | Create a distinct catalog record after the moderator's explicit acknowledgement. |

Selecting an existing `albumId` is always link-only behavior. It is not a partial update and never turns the submitted album snapshot into a blanket replacement.

For a create approval without a direct submitted cover URL, the service may perform best-effort Cover Art Archive resolution before starting the transaction. A submitted `coverSourceUrl` has highest precedence and is never fetched; link approval skips resolution; provider failure does not block approval. Because this work happens before the transaction, the service records the submission revision and `updatedAt` and rechecks both inside the transaction.

The new-album transaction then:

1. Re-reads the submission and handles a concurrently completed approval idempotently.
2. Requires the same pending revision.
3. Recomputes duplicate signals, including exact references derived during cover resolution.
4. Enforces explicit selection for exact matches and explicit confirmation for advisory matches.
5. Loads the selected album or creates a normalized album.
6. Sets the submission to approved, stores the internal album reference, clears duplicate linkage, sets `approvedAt`, records `catalog_created` or `catalog_linked`, and appends one approval event with the same timestamp.

A created catalog record receives a Rescened UUID, generated track UUIDs, normalized public metadata, accepted non-Spotify references, `catalogSource: "community"`, `catalogRevision: 1`, and field-level community provenance. Cover precedence is submitted direct URL, resolved Cover Art Archive URL, then blank. Supporting evidence and country remain private.

### Catalog-correction approval

A correction is created against a fixed local album and captures that album's `catalogRevision`, values, and provenance for only the proposed field groups. Revision refreshes the baseline from the then-current target. The allowed groups are `title`, `artists`, `releaseType`, `releaseDate`, `label`, `cover`, `tracks`, and additive `externalReferences`.

The moderator sends a non-empty `applyFields` subset. Omitted proposed groups are intentionally left unchanged and recorded as unapplied. Correction approval makes no provider request and accepts neither a replacement target nor duplicate confirmation.

Inside one transaction, the correction branch:

1. Re-reads the pending submission and its fixed target album.
2. Requires the target's current `catalogRevision` to equal the stored baseline; otherwise it returns `409 CATALOG_CHANGED` rather than rebasing silently.
3. Revalidates that `applyFields` still refers only to the current proposal.
4. Checks additive external references against other catalog albums.
5. Builds a server-owned patch, validates the complete resulting `AlbumCatalog` document, and conditionally updates the same `_id`/`albumId` at the expected revision.
6. Increments `catalogRevision` exactly once and replaces provenance only for applied fields.
7. Sets the submission to approved, links the same target album, writes `approvedAt` and `catalog_corrected`, and appends one approval event containing proposed, applied, and unapplied fields plus the before/after revisions.

The patch preserves public `albumId`, Mongo `_id`, `catalogSource`, omitted catalog fields, omitted provenance, and every social relation that already points at the album. Artist and release-date groups are applied as coherent tuples. Tracks are a complete replacement list with target-owned track IDs preserved and new UUIDs assigned during correction normalization. External references are additive only. A correction cover is a reviewed nonblank HTTPS URL and is neither fetched nor resolved through a provider.

An external-reference collision returns `409 CATALOG_REFERENCE_CONFLICT`; a missing target returns `409 CATALOG_TARGET_MISSING`; an invalid or stale baseline returns `409 CATALOG_BASELINE_INVALID` or `409 CATALOG_CHANGED`. Any failure rolls back both album and submission writes.

### Shared transaction and retry guarantees

Every first-time approval requires a transaction-capable replica set or sharded MongoDB deployment. Catalog creation/link/correction, the submission transition, approval feed metadata, and the audit append succeed or roll back together. Transaction-unavailable errors become `503 APPROVAL_UNAVAILABLE`; there is no create-then-update fallback.

There are four related concurrency protections:

- **Conditional transitions:** non-approval commands and the final approval transition filter by pending status and current revision.
- **Mongo transaction:** first-time approval makes catalog and workflow publication atomic.
- **Catalog revision guard:** correction, import refresh, and cover backfill condition on the revision they read and advance it on a successful maintained mutation.
- **Idempotent completed approval:** a retry returns the already linked album without another patch, provider call, catalog row, or audit event.

Existing catalog rows must be reconciled to an explicit positive `catalogRevision` before correction rollout. Likewise, historical approvals need reviewed `approvedAt` and publication-type backfill before they can appear in the feed. The runtime does not guess either value.

The model's `findOneAndUpdate`/`updateOne` middleware rejects updates that replace, unset, pull, pop, or non-append-position the `revisions` and `moderationHistory` arrays. Route behavior plus this middleware protects maintained query-update paths. Replacement APIs and raw database writers are outside that safeguard, so direct database access must still be restricted.

## Frontend mental model

The related React routes are:

```text
/moderation/album-suggestions
/moderation/album-suggestions/:submissionId
/suggestions/corrections/:albumId
/suggestions/:submissionId/revise
/community/approved
```

`Navbar.jsx` links everyone to the Community feed and signed-in users to Suggestions. It still has no dedicated moderator-desk link; the moderator path merely marks Suggestions active. A moderator opens `/moderation/album-suggestions` directly or through another supplied link. A signed-in non-moderator can load the page shell, but the first API `403` replaces the workspace with the restricted-access state.

`ModerationSuggestions.jsx` owns orchestration:

- Gets a Clerk token and attaches it as `Authorization: Bearer ...`.
- Fetches and filters the oldest-first queue, including the visible `submissionType` filter for new albums versus catalog corrections.
- Uses abort controllers and request IDs so stale responses do not overwrite newer state.
- Appends cursor pages and deduplicates them by public `submissionId`.
- Loads the selected detail record from the route parameter.
- Sends every command as `POST`, merges the returned suggestion into local state, and refreshes the queue.
- Treats a `403` from either queue or detail as loss of moderator access for the whole workspace.
- Refreshes detail after ordinary `409` conflicts, while keeping exact/advisory duplicate conflicts in place so the moderator can resolve them in the form.

If Clerk reports a signed-in session but `getToken()` returns no token, the page shows its normal request error/retry state; it does not perform another sign-in redirect. Signed-out routing is handled earlier by `ProtectedRoute`.

`ModeratorDecision.jsx` owns form state:

- Shows commands only while the submission is pending.
- Requires reasons client-side where appropriate, while relying on the server to repeat validation.
- For `new_album`, lets the moderator choose a candidate/existing album ID, disables duplicate confirmation when one is selected, and shows exact/advisory match instructions.
- For `catalog_correction`, initializes checkboxes from every proposed field group, displays whether each diff is stale, requires at least one selection, and sends `{ applyFields, reason? }` without album or duplicate fields.
- Offers approved duplicate candidates and a free-text suggestion-ID field. The server, not the form, enforces that the submitted ID belongs to another approved suggestion with an album reference.

`SubmissionDetails.jsx` renders proposal/target metadata, evidence, revision history, activity history, and sanitized duplicate candidates. For corrections it renders the server-computed `correctionDiff` as baseline, current catalog value, proposed value, and a stale marker for each group. With `showContributor`, the moderator view also shows contributor and moderation actor IDs.

`AlbumDetail.jsx` offers signed-in users “Suggest a correction.” `SuggestionEditor.jsx` loads the exact local album, switches to `CorrectionForm`, and posts the selected groups plus one evidence source to `/suggestions/corrections`. When revising a stored correction, it reuses the same form and the type-aware revise endpoint. The backend still validates every group, target, and source.

`ApprovedSuggestions.jsx` loads the anonymous feed without a Clerk token, renders current catalog cards, and pages with the opaque cursor. It deduplicates appended events by `submissionId` and has loading, empty, retry, and end states.

The frontend still depends on a configured Clerk session and running API for a signed-in smoke test. Lint/build cannot prove that hosted authentication and the live catalog request are configured, so use the signed-in verification checklist below before rollout.

The new-album album-ID input continues to mean “link without overwriting.” Its direct-cover note applies only when approval creates a record. Link approval ignores proposal metadata; correction cover changes appear in the explicit correction diff and patch.

## Responses and errors

Non-approval commands reload detail and currently return:

```text
{ suggestion, duplicateCandidates }
```

Approval returns:

```text
{ suggestion, album, albumUrl, idempotent }
```

For a correction, `suggestion.publicationType` becomes `catalog_corrected`, and its appended approval event includes the field-application summary. The normalized `album` is the updated current catalog record. Public feed reads use a separate minimal response and never reuse moderator detail.

Common failures:

| Status/code | Meaning and usual next step |
| --- | --- |
| `401 UNAUTHORIZED` | No Clerk user ID reached the route. Sign in or inspect token/middleware configuration. |
| `403 MODERATOR_REQUIRED` | The exact Clerk user ID is missing from `MODERATOR_USER_IDS`. |
| `400 INVALID_MODERATION_REQUEST` | Body, reason, ID, filter, limit, or correction `applyFields` is malformed, or an unknown field was supplied. |
| `400 INVALID_CURSOR` | Discard the cursor and reload the first queue page. |
| `409 INVALID_SUBMISSION_STATE` | The record is no longer pending; reload detail. |
| `409 STATE_CONFLICT` | Another change won after the preliminary read; reload detail and queue. |
| `409 INVALID_DUPLICATE_TARGET` | Choose another approved submission with an album reference. |
| `409 EXACT_CATALOG_MATCH` | Select one of the returned catalog album IDs and approve again. |
| `409 POSSIBLE_DUPLICATE_CONFIRMATION_REQUIRED` | Review candidates, then link an album or explicitly confirm creation. |
| `409 CATALOG_ALBUM_NOT_FOUND` | The manually supplied album ID does not resolve locally. |
| `409 CATALOG_CHANGED` | A correction target no longer matches its stored catalog revision; request a contributor revision instead of rebasing silently. |
| `409 CATALOG_BASELINE_INVALID` | A correction lacks a usable positive catalog baseline. |
| `409 CATALOG_TARGET_MISSING` | The correction's fixed target album no longer exists. |
| `409 CATALOG_REFERENCE_CONFLICT` | An external reference selected for correction is already owned by another catalog album. Safe candidate album IDs may appear in `details`. |
| `503 MODERATION_DISABLED` | Reads still work, but `COMMUNITY_MODERATION_ENABLED` is off. |
| `503 APPROVAL_UNAVAILABLE` | MongoDB cannot run the required transaction; use a replica set or sharded deployment. |
| `429 RATE_LIMITED` | Respect `Retry-After` or `retryAfterSeconds` before retrying. |

Unexpected errors use the route's operation-specific fallback message and status 500; private database/provider details are not returned to the client.

## Debugging by symptom

| Symptom | Check first |
| --- | --- |
| The moderator page shell loads, then shows restricted access | `ProtectedRoute` verifies sign-in only. Compare the signed-in Clerk ID exactly with `MODERATOR_USER_IDS`. |
| Queue/detail works but every command returns 503 | Check `COMMUNITY_MODERATION_ENABLED=true`; reads intentionally ignore this flag. |
| Approval returns `APPROVAL_UNAVAILABLE` | Confirm `MONGO_URI` targets a transaction-capable replica set or sharded deployment. |
| Approval keeps returning `EXACT_CATALOG_MATCH` | `confirmPossibleDuplicate` cannot override exact identity. Send the correct existing `albumId`. |
| Approval requests duplicate confirmation | Review candidate records; send `albumId` to link or `confirmPossibleDuplicate: true` to create intentionally. |
| The selected existing album did not receive proposal metadata | This is expected link behavior. Updating it requires a separate `catalog_correction` submission and explicit `applyFields`. |
| A correction has no selectable fields | Reload detail and confirm `proposedChanges` and server-computed `correctionDiff` are present. The decision form derives its checkboxes from those proposed groups. |
| A suggestion revision page fails before loading | Inspect the current `correctionFlow` declaration in `SuggestionEditor.jsx`; it references `submission` before that state variable is initialized. Lint/build do not execute the route. |
| Correction approval returns `CATALOG_CHANGED` | The target was mutated after the stored baseline. Ask for a revision so the contributor and moderator review current values. |
| Older approvals do not appear in `/suggestions/approved` | The feed requires explicit `approvedAt` and publication type. Run the reviewed historical reconciliation before rollout. |
| No cover was published | Direct URL may be blank and CAA resolution is best effort. Approval is intentionally not blocked by artwork failure. |
| A decision returns a state conflict | Another command or revision changed the record. Reload before retrying. |
| A command returns 429 | Read the `Retry-After` header; the moderator bucket is per authenticated user and process. |
| A catalog album exists while the submission stayed pending | This should be impossible through the approval service. Run the transaction/rollback integration tests and investigate direct database writers. |

## Tests and safe verification

For a focused moderator backend check:

```sh
node --test tests/submissions.test.js tests/moderation.test.js tests/deferredSubmissions.test.js
```

These suites use mocked persistence for route, normalization, serialization, authorization, queue, command, and approval contracts. `tests/deferredSubmissions.test.js` covers typed correction normalization, feed privacy/current-catalog behavior/cursor progress, reconciliation planning, and selected-field correction application. Route-level create/revise and strict moderator command coverage remains in the existing submission/moderation suites.

For real Mongo transaction behavior:

```sh
npm run test:integration
```

The integration runner enables `RUN_MONGO_INTEGRATION=true` and starts an in-memory replica set. The moderation integration file proves create/link atomicity, retries, rollback, provenance, append-only invariants, selected-field correction publication, and stale-revision rejection. Reference-conflict, concurrent-correction, and idempotent-correction cases remain sensible follow-up coverage if those behaviors are expanded.

For any album-bearing or identity change, also run:

```sh
npm run check:catalog-contract
```

After frontend moderator changes, run:

```sh
npm --prefix frontend run lint
npm --prefix frontend run build
```

There is currently no dedicated moderator component-test suite, so lint/build should be paired with a manual queue/detail/decision smoke test.

## Safe change checklist

When changing moderator behavior:

1. Update strict request normalization before accepting a new body field.
2. Keep Clerk authentication and allowlist checks on every private route.
3. Keep commands server-authoritative and pending-state conditional.
4. Branch approval from stored `submissionType`, not a client-selected mode.
5. Use a transaction for any command that writes both the catalog and submission.
6. Guard correction writes with `catalogRevision` and increment it exactly once.
7. Preserve public UUIDs, `catalogSource`, omitted fields, and social relations; never expose Mongo IDs.
8. Append revision and moderation history; never replace or trim it.
9. Write `approvedAt`, publication type, and the approval event together.
10. Return stable conflict and feature-disabled codes so the frontend can recover correctly.
11. Keep provider calls bounded and outside database transactions, then recheck state before writing. Corrections should make no provider calls.
12. Update backend tests, integration tests, frontend error handling, the Phase 2 contract, and this guide together.
13. Run the catalog contract guard for approval, identity, provider, or album-bearing changes.

## Current backend state and rollout gaps

| Capability | Current state |
| --- | --- |
| Private moderator queue/detail | Implemented, including backend and visible submission-type filtering plus correction diffs |
| Request changes, reject, and mark duplicate | Implemented |
| Transactional create approval | Implemented |
| Link-only approval to existing `albumId` | Implemented |
| Transactional selected-field correction | Backend and contributor/moderator UI implemented under [Moderator-approved catalog corrections](./PHASE_2_SUBMISSIONS.md#moderator-approved-catalog-corrections); reviewed existing-row reconciliation and correction-specific integration proof are implemented |
| Public approved-submission feed | Backend `GET /suggestions/approved`, minimal serializer, reconciliation command, and `/community/approved` page implemented |
