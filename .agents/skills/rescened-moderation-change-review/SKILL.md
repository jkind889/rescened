---
name: rescened-moderation-change-review
description: Implement or review Rescened community album submission and moderation behavior across backend and frontend. Use for workflow states, approval publication, privacy, and tests; not generic imports, unrelated authentication, or editorial decisions.
---

# Review Rescened moderation changes

Preserve the submission aggregate, authorization/privacy boundary, and single approval-to-catalog publication boundary while implementing or reviewing community workflow changes.

Read the backend [submission and moderation contract](../../../docs/PHASE_2_SUBMISSIONS.md). For UI work, also read the [moderator frontend walkthrough](../../../docs/MODERATOR_IMPLEMENTATION_GUIDE.md#frontend-mental-model). Trace affected behavior through the [aggregate](../../../models/AlbumSubmission.js), [contributor routes](../../../routes/suggestions.js), [moderator routes](../../../routes/moderation.js), [submission helpers](../../../routes/utils/submissions.js), and transactional [approval service](../../../routes/utils/approval.js) rather than reviewing one layer in isolation.

## Preserve the workflow contract

- Treat the server as authoritative for identity, status, revision, moderation events, and allowed actions. Derive contributor and reviewer IDs from Clerk authentication; reject client-supplied status, reviewer, revision, or audit fields.
- Permit only the documented transitions: create to `pending`; owner revision from `needs_changes` to `pending`; owner withdrawal from `pending` or `needs_changes`; and moderator commands from `pending` to `needs_changes`, `approved`, `rejected`, or `duplicate`. Do not add arbitrary status setters. Handle an approved retry through the idempotent approval path, not a new transition.
- Keep contributor mutations behind `COMMUNITY_SUBMISSIONS_ENABLED` and moderator commands behind `COMMUNITY_MODERATION_ENABLED`. Reads remain available while those flags are off. Flags do not replace authentication or authorization.
- Require Clerk authentication for every route. Owner detail is visible only to the owner or an allowlisted moderator; an authenticated outsider receives `404` to avoid confirming a private submission. Moderator reads and commands use the server-only `MODERATOR_USER_IDS` allowlist, with the documented anonymous and non-moderator responses.

## Protect public identity and privacy

- Expose immutable UUID-v4 `submissionId` and public `albumId` values. Keep MongoDB `_id`, internal catalog/submission ObjectIds, raw match keys, and duplicate-signal records internal. Opaque cursors may encode `_id`, but clients only pass them back unchanged.
- Serialize through the established helpers. Limit candidate submissions to sanitized metadata and never expose another contributor's private proposal through duplicate discovery.
- Keep supporting evidence and submission-only fields private. Submission history is an authenticated workflow surface, not a public approved-submission feed.
- Frontend route guards and hidden controls are usability measures only. Render server responses as authoritative after mutations and surface conflict, disabled-feature, and transaction-unavailable responses.

## Preserve aggregate history and concurrency

- Revisions are complete snapshots and both `revisions` and `moderationHistory` are append-only. Use supported `$push` behavior; do not replace, remove, trim, sort, or rewrite history. Keep terminal submissions for audit and duplicate detection.
- Contributor revision updates must match owner, `needs_changes`, and the previously read `currentRevision`; stale updates return `409 REVISION_CONFLICT`. Withdrawals and moderator commands must condition on the current allowed state and return `409 STATE_CONFLICT` when raced.
- Every successful state command appends exactly one matching audit event. Failed, stale, and idempotent retries must not append extra history.

## Keep duplicate decisions explicit

- Duplicate candidates are advisory. Never auto-link a candidate or treat a fingerprint/fuzzy match as approval.
- Exact catalog-reference matches require an explicit public `albumId`. Creating a new album when advisory matches remain requires `confirmPossibleDuplicate=true`.
- `mark-duplicate` must identify another approved submission with a usable catalog album. Recheck duplicate state within approval rather than trusting stale client data.
- Keep strict request shapes and preserve the established validation and conflict error codes so the UI can present actionable server feedback.

## Keep publication transactional and idempotent

- Only successful approval may create or link an `AlbumCatalog` record. Pending, `needs_changes`, rejected, duplicate, and withdrawn metadata must remain absent from public catalog and social queries.
- Perform catalog create/link, submission transition, and approval audit append in one MongoDB transaction. If transactions are unavailable, return `503 APPROVAL_UNAVAILABLE`; never substitute create-then-update behavior.
- Retrying an already approved submission returns the same catalog album without another catalog row, audit event, or artwork lookup. Recheck pending revision after any pre-transaction artwork lookup.
- Linking an existing album must not overwrite it. New community records use normalized fields, public local IDs, and field-level provenance. Do not publish supporting evidence or other private submission fields.

## Verify at the affected layers

During implementation, use [the pre-review async and lifecycle checklist](../rescened-verify/SKILL.md#check-async-and-lifecycle-cases-before-review). For the affected workflow, exercise case switching during pending requests, overlapping bulk/individual commands, stale revisions, retries, deletion/privacy changes, and failed conflict reloads as applicable. The implementer must address these before independent review, not leave them for the reviewer to discover.

Add or update tests for every changed invariant and failure path, especially privacy, flag-off behavior, public serialization, invalid transitions, stale/concurrent commands, duplicate confirmation, transaction rollback, idempotent retry, and non-publication before approval.

Use the smallest relevant checks, then broaden in proportion to the change:

```sh
node --test tests/submissions.test.js tests/moderation.test.js
npm test
npm run test:integration
npm run check:catalog-contract
npm --prefix frontend run lint
npm --prefix frontend run build
```

Run the replica-set-backed integration suite when approval, persistence, indexes, rollback, provenance, idempotency, or concurrency changes; note clearly if the environment prevents it or tests are skipped. Run frontend lint and build when UI, routing, client payloads, or response handling changes. The static catalog guard does not replace transaction-backed proof of the publication boundary.

For a review, lead with actionable findings ordered by severity and give tight file/line references, the violated invariant, the concrete failure mode, and the missing or needed test. If no defect is found, state residual risks and any verification not run.
