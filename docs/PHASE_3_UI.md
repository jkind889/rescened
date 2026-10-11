# Phase 3 Community Submission UI

Status: New-album, catalog-correction, moderator, and approved-feed UI implemented and building; runtime smoke, one revision-route fix, and data reconciliation remain rollout work.

This document records the contributor, moderator, and public approved-feed screens that sit on top of the Phase 2 submission API. It describes the visible route and workflow boundary only; the [Phase 2 community album submissions contract](./PHASE_2_SUBMISSIONS.md) remains the source of truth for persistence, validation, authorization, status transitions, duplicate signals, and approval publication. For a code-level moderator walkthrough and current constraints, see the [Moderator implementation guide](./MODERATOR_IMPLEMENTATION_GUIDE.md).

## Scope and access

Contributor and moderator workflow screens are signed-in surfaces. The public `/community/approved` page is the deliberate anonymous exception. The frontend may protect navigation with its authenticated route wrapper, but the server remains the authorization boundary for every private request. The UI must not treat a hidden link or route guard as permission to read or mutate a submission.

Contributor detail is owner-scoped by the API. A caller who is neither the owner nor an allowlisted moderator receives the same not-found response as a missing submission. Moderator screens require Clerk authentication and membership in the server-only `MODERATOR_USER_IDS` allowlist. MongoDB identifiers are never a UI-facing identity; use the public `submissionId` and `albumId` values returned by the API.

## Contributor routes and workflows

All contributor routes are below `/suggestions` and use the corresponding Phase 2 endpoints:

| UI route | Visible workflow | API boundary |
| --- | --- | --- |
| `/suggestions` | The contributor's submission history, status, timestamps, revision/duplicate signals where provided, and links to each detail view or the new-submission form. | `GET /suggestions/mine` with its opaque `cursor` and `limit` pagination values. |
| `/suggestions/:submissionId` | One submission's current proposal, evidence, revision history, moderation history, status, and available actions. An active proposal can be withdrawn; a `needs_changes` proposal can be opened in the revision form. | `GET /suggestions/:submissionId`; `POST /suggestions/:submissionId/withdraw` for withdrawal. |
| `/suggestions/new` | Form for a complete proposed album and supporting evidence. Validation and server feedback remain visible to the contributor. | `POST /suggestions`; the server creates a pending submission and returns its detail representation. |
| `/suggestions/corrections/:albumId` | Field-group correction form opened from a local album. It starts with current catalog values, requires at least one selected group and one HTTPS evidence source, and never edits the album directly. | Public album detail read followed by authenticated `POST /suggestions/corrections`. |
| `/suggestions/:submissionId/revise` | Type-aware revision form for a `needs_changes` new album or correction. Submitting it returns the record to pending. | `POST /suggestions/:submissionId/revise`; the server selects normalization from stored `submissionType` and appends a revision. |

Withdrawal is an action on the list/detail UI, not a separate frontend route. The UI should offer it only for `pending` and `needs_changes`; the server rejects terminal or concurrently changed records. Revision is likewise available only after a moderator requests changes; the server, not the client, enforces that state transition.

The contributor list is a private workflow view. It is not a public catalog or approved-submission feed, and creating or revising a proposal does not publish an album.

Unsent editor input is autosaved to browser `localStorage` (`frontend/src/features/community/drafts.js`), keyed by the signed-in Clerk user and by context: a new suggestion, a MusicBrainz prefill (`mbid`), a correction to one `albumId`, or one submission revision. A revision draft never carries over to a later revision. Drafts expire after 30 days, are removed once the form returns to its starting values or the submission succeeds, and the form offers "Discard draft" when it restores one. A restored correction draft keeps only its selected field groups and source; unselected fields reload from the album as it is now. Drafts never reach the server and are only a convenience.

The editor computes `correctionFlow` only after declaring the `submission` state variable, so both new-album and correction revision routes can load their type-specific form. Lint/build cover the bundle; a signed-in smoke pass still belongs in deployment verification.

## Public approved feed

`/community/approved` is anonymous and calls `GET /suggestions/approved` without a Clerk token. It renders one chronological card per approval event using the album's current normalized catalog metadata, supports opaque-cursor “load more,” deduplicates appended events by `submissionId`, and includes loading, empty, retry, and end states. The Navbar exposes it as Community.

## Moderator routes and workflows

Moderator screens are below `/moderation/album-suggestions`:

| UI route | Visible workflow | API boundary |
| --- | --- | --- |
| `/moderation/album-suggestions` | Queue of submissions with status, submitter, evidence summary, revision/timestamps, and possible-duplicate signal. The visible form supports status, duplicate, submitter, cursor, and page-size filters. | `GET /moderation/album-suggestions`; the backend additionally accepts `submissionType`, though the visible form does not expose it yet. |
| `/moderation/album-suggestions/:submissionId` | Full proposal/evidence/history detail and a decision panel. Corrections show baseline, current catalog value, proposal, and stale state per field group. | `GET /moderation/album-suggestions/:submissionId` plus one explicit command endpoint for the selected decision. |

The signed-in user's profile action row includes a `Moderation` link to the queue. This is a navigation affordance only; the protected route and server-side moderator allowlist continue to enforce access.

The decision panel presents the server-supported actions for a pending submission:

- Request changes with a required reason: `POST /moderation/album-suggestions/:submissionId/request-changes`.
- Reject with a required reason: `POST /moderation/album-suggestions/:submissionId/reject`.
- Mark duplicate by selecting or entering another approved `submissionId`, with a required reason: `POST /moderation/album-suggestions/:submissionId/mark-duplicate`.
- Approve a new album with an optional existing `albumId`, possible-duplicate confirmation when required, and optional reason: `POST /moderation/album-suggestions/:submissionId/approve`.
- Approve a correction by selecting at least one proposed field group and sending `applyFields` plus an optional reason to the same endpoint.

The UI should show command validation, conflict, disabled-feature, and approval-unavailable responses as server feedback. A successful approval may return the published catalog album and album URL; the UI may link to that result without treating the submission screen as the public approved feed. The server accepts moderation commands only while the submission is pending and records the authoritative moderation event.

The correction decision form derives selectable groups from `proposedChanges`, initializes them selected, shows server-computed stale markers, and omits new-album album/duplicate controls. The backend revalidates the type and fields and rejects stale catalog revisions even if the UI state is outdated.

## Visual and API boundaries

The visual surface is a workflow UI: status labels, queue/detail panels, evidence and history sections, duplicate-candidate choices, explicit reason fields, loading/empty/error states, and confirmation feedback for state-changing actions. It should make the current status and the next allowed action clear, while preserving the server response as authoritative after each mutation.

The UI calls the Phase 2 HTTP routes and renders their public representations. It does not write MongoDB records, choose reviewer identity, submit arbitrary statuses or audit events, or infer approval from a local optimistic state. Opaque pagination cursors are passed back to the API unchanged. Candidate matches are advisory until a moderator explicitly chooses a supported command.

## Feature flags and deferred work

- `COMMUNITY_SUBMISSIONS_ENABLED=true` enables contributor create, revise, and withdraw mutations. Contributor reads remain available when the flag is off; the UI should surface the server's disabled response for mutation attempts.
- `COMMUNITY_MODERATION_ENABLED=true` enables moderator commands. Moderator reads remain available when the flag is off; the UI should surface the server's disabled response for command attempts.
- `MODERATOR_USER_IDS` is a server-only Clerk allowlist for moderator reads and commands. It must not be used as a client-side authority source.

The two boolean flags are disabled when absent or set to any value other than `true` (case-insensitive, with surrounding whitespace ignored).

The correction editor, album-detail entry point, moderator diff/field selection, public feed page, submission-type queue filter, and Community navigation are present. Remaining rollout work is executing the reviewed historical reconciliation in the target environment plus a signed-in runtime workflow smoke test; a homepage feed section remains optional product work.
