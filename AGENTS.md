# Rescened repository guidance

## The project

ReScened is a place to keep track of the music you listen to, share reviews, organize albums into boards, and discover music through other people. It's built around a community-curated catalog.

- Explain changes through the experience of using the app. Use plain, direct language and concrete examples when they help.
- Keep shipped behavior, local prototypes, feature-flagged work, and future plans distinct. Avoid inflated claims and long inventories of changed files.

## Questions before changes

- Questions such as "how could we do this?" or "is this possible?" are requests for discussion, not permission to edit. Explain the options, tradeoffs, and proposed approach first. Do not change files, configuration, or behavior in response to a question; wait for explicit permission to implement the change.
- Keep any investigation needed to answer the question read-only. Do not delegate implementation or make preparatory edits before that permission is given.

## Use the relevant skills

- Check the project skills under `.agents/skills/` before planning the relevant work, and read and apply the ones that fit. If they are absent from the runtime's skill catalog, open their `SKILL.md` files directly. Do not load every skill for every task or assume a skill was used merely because it exists.
- Use [rescened-verify](.agents/skills/rescened-verify/SKILL.md) during implementation and before handing work to an independent reviewer. Use [rescened-moderation-change-review](.agents/skills/rescened-moderation-change-review/SKILL.md) for submission/moderation changes and [rescened-provider-integration](.agents/skills/rescened-provider-integration/SKILL.md) for provider adapter changes.
- Use [rescened-commit-review](.agents/skills/rescened-commit-review/SKILL.md) for an explicitly requested commit or branch review. For operator tasks, choose [rescened-catalog-rollout](.agents/skills/rescened-catalog-rollout/SKILL.md), [rescened-cover-backfill](.agents/skills/rescened-cover-backfill/SKILL.md), or [rescened-migration-operator](.agents/skills/rescened-migration-operator/SKILL.md) according to the operation. Loading a skill does not authorize its write or apply steps.

## Check lifecycle behavior while implementing

- For changes involving asynchronous work or mutable state, the implementer must identify the applicable failure cases while designing and testing the change: delayed responses, navigation or unmounting, list resets, duplicate requests, concurrent writes, deletion/privacy changes, and failed reloads.
- Exercise applicable cases with focused tests or safe reproductions before independent review. Follow the [verification checklist](.agents/skills/rescened-verify/SKILL.md#check-async-and-lifecycle-cases-before-review), record meaningful coverage gaps, and fix in-scope defects. Independent review is a second check, not the first time these cases are considered. Unrelated documentation-only changes do not require async tests.

## Delegation hierarchy

- The main agent is the coordinator: it owns requirements, architectural decisions, task boundaries, integration, final verification, and the user-facing result.
- Delegate bounded, independent work to subagents when it materially improves progress or review quality. Keep small changes and tightly dependent steps local. Follow [the delegation guide](docs/AGENT_DELEGATION.md) for roles, task briefs, and handoffs.
- Assign responsibilities such as investigation, implementation, review, testing, or documentation rather than depending on a particular model or old role name. Use the delegation tools, roles, and models actually available in the current T3, Codex, or Claude session. Preserve the user's model choices; a configuration file on disk does not prove a role is available.
- The coordinator assigns the checkout, branch and base, exact file ownership, acceptance criteria, and relevant checks before spawning. Subagents report directly to the coordinator and must not delegate further. Use at most three simultaneous subagents, or fewer if the runtime limit requires it.
- Establish whether each agent shares the checkout or has an isolated worktree. Tell every editing subagent to preserve others' edits and report overlapping ownership before writing. Isolated worktrees do not isolate a shared database, ports, or external services. Keep Git mutations, integration, and ownership transfers with the coordinator.
- Give reviewers the actual current diff and relevant code, not just an implementation summary. Keep review read-only unless tests or fixes are explicitly assigned, and rerun affected checks after integrating changes.
- Delegation does not expand authorization. All agents must preserve the catalog, security, provider, and data-operation rules below. Database apply steps still require explicit user authorization for the named target.

## Pull request writing

- Keep titles short and specific. Open the description with what was wrong or missing and what changes for the person using the app. Use plain language, short paragraphs, or a few bullets; do not lead with a file-by-file summary.
- Include implementation details only when they explain a decision, risk, or review requirement. Add the checks actually run and any relevant gaps, feature flags, or rollout steps. Keep model review separate from executed tests. Omit filler and empty sections; never invent impact, measurements, or verification.
- Before filing, verify the intended branch and base, inspect the complete scoped diff, and check for an existing PR. For stacked work, identify the actual parent branch rather than assuming `main` or choosing a base from commit titles alone.
- Keep existing publication and approval requirements in force. Writing a PR description does not authorize pushing, filing, changing draft status, merging, or deploying. Shared workflow permission conflicts need to be resolved explicitly, not by choosing the more permissive version.

## Project shape

- The product and npm packages are named **Rescened**. The checkout or remote may still use the legacy name `albumboxd`; do not rename paths, remotes, packages, or product copy unless the task explicitly requires it.
- The repository root is a CommonJS Node.js/Express/Mongoose API. `frontend/` is a separate React/Vite ES-module package.
- Treat the root and `frontend/` as separate npm projects with separate lockfiles. Run commands from the correct package and preserve both lockfiles when dependencies change.
- Root `.env` values are server-side; `frontend/.env` is separate and may contain only browser-safe `VITE_*` values. Never expose `MONGO_URI`, `CLERK_SECRET_KEY`, moderator IDs, or other server secrets through Vite configuration or client code.

## Development worktrees

- Use the [shared-development worktree workflow](docs/WORKTREES.md) for new Rescened worktrees unless the user requests another environment. Prefer the helper's `create`, or enroll an externally created linked tree with `setup`.
- The helper's creation base is the repository-local `rescened.worktreeBase` setting when present, otherwise `origin/main`; an explicit `--base` wins. When creating through Git or an editor instead, inspect that setting and select the same base explicitly. Do not silently branch from an older checkout that lacks the setup.
- Reuse the approved private development profile outside all checkouts. Do not copy `.env` files, credentials, or user allowlists into a tree. Start only the paired API/Vite preview; this workflow does not authorize workers, provider ingestion, or database copies/resets.
- Before starting or restarting a preview, verify its checkout, branch, paired ports, and owning process. Reuse a healthy preview only when it matches the task's code and configuration. Never kill an unrelated process, use a broad `pkill`, or let the frontend silently move to another port.
- Use the helper's printed URL and verify the paired API's `/health` reports `status: "ok"`, then check the relevant page. Keep requested feature flags explicit and follow the current checkout's [worktree guide](docs/WORKTREES.md) rather than copying commands from another branch.
- The development database is shared and writable. Startup can initialize indexes, and ordinary app actions can change data. A preview request does not authorize a worker, ingestion, migration, reset, or unrelated data operation.
- Hand off the preview URL, relevant flags, checks performed, and whether it is still running. Leave a requested user preview available; stop disposable test processes through their owning session without stopping unrelated previews.
- Creation and cleanup use different safeguards: removal still requires commits contained in `origin/main` unless the user deliberately chooses another cleanup base. Preserve dirty/ignored user files and follow the guide's explicit cleanup checks.

## Catalog and identity invariants

- `AlbumCatalog` is the authoritative public catalog. Search, album detail, reviews, likes, profiles, activity, and boards use local catalog records.
- Public albums use immutable Rescened UUID-v4 `albumId` values. MongoDB `_id` values are internal relation and pagination keys; never expose them as public resource identifiers.
- Keep public IDs distinct by domain: use `albumId`, `trackId`, and `submissionId` as defined by their models. Never place an upstream provider ID in `albumId`.
- External search results are discovery candidates, not catalog albums. They must remain visibly distinct and cannot be saved, reviewed, liked, or opened as `/album/:albumId`. Only approved community publication or the catalog importer may create a public album.
- Preserve provider-neutral catalog behavior. Spotify API credentials, Spotify catalog identity, and Spotify metadata dependencies must not return. User profile links to Spotify are the narrow allowed exception. `npm run check:catalog-contract` helps detect known regressions but is not exhaustive; review new paths and extend the guard when its scan roots or rules do not cover them.
- Preserve field provenance and ownership. Automated imports must not overwrite manual or community-owned fields, clear an existing cover with a blank value, or delete albums merely because they are absent from a later dataset.
- Album-bearing social responses should resolve current display metadata from `AlbumCatalog` instead of adding new denormalized album snapshots.
- A user's saved shelf is the deduplicated union of albums across every board they own. Removing one board membership must not make an album appear unsaved while another owned board still contains it.

## API, authorization, and moderation

- Clerk authentication and server-side authorization are the security boundary. A protected frontend route is never sufficient authorization for an API mutation.
- Contributor mutations require `COMMUNITY_SUBMISSIONS_ENABLED=true`. Moderator commands require `COMMUNITY_MODERATION_ENABLED=true`, Clerk authentication, and membership in `MODERATOR_USER_IDS`. Preserve the existing read behavior when a mutation flag is disabled.
- Normalize and validate request bodies before writes, reject unknown or client-owned workflow fields, and apply the relevant rate limit before persistence.
- Preserve stable HTTP status/error-code contracts and `Retry-After` behavior when changing endpoints or frontend error handling.
- Submission revisions and moderation history are append-only. Keep status transitions server-authored and conditional; stale or concurrent commands must return conflicts rather than silently overwrite state.
- Pending, needs-changes, rejected, duplicate, and withdrawn submissions are not public catalog records. Approval is transactional and idempotent: catalog publication, submission transition, and audit history succeed or fail together.
- Catalog import and moderation approval require a transaction-capable replica set or sharded MongoDB deployment. Do not add unsafe create-then-update fallbacks for standalone MongoDB.

## External providers and tests

- Isolate provider integrations behind explicit adapters. Put new user-facing provider paths behind disabled-by-default feature flags; operator-only fetch/import CLIs remain explicitly invoked commands. Normalize provider responses before they reach routes or UI, and preserve the local-catalog path when an upstream service times out, rate-limits, returns malformed data, or is unavailable.
- Use identifying user agents, bounded timeouts/retries, `Retry-After`, request gating, and caching in accordance with the existing provider modules. Do not introduce automatic retry loops in the UI.
- Normal tests must not contact live providers. Use checked-in fixtures for provider behavior; run live-provider tests only when the user explicitly requests them.
- Preserve source licensing and provenance. MusicBrainz/ListenBrainz core data and Cover Art Archive images have different rights boundaries; linked artwork is not implicitly licensed for copying or rehosting.

## Data-changing operator work

- Catalog imports, cover backfills, and legacy migrations are dry-run-first workflows. Inspect the selected environment and generated reports before any apply step.
- A catalog import applies the exact reviewed, checksummed dataset; a legacy migration applies the exact sealed plan. Cover backfill applies only after review of its dry-run report, then intentionally re-resolves candidates under guarded writes. Every apply requires explicit user authorization for the named target. Never infer production-write permission from a request to inspect, plan, validate, or dry-run.
- Retain checksums and reports. Distinguish a rolled-back transaction from a committed database change whose report finalization or later verification failed.
- Keep database backups, restored legacy data, credentials, and `.env` contents out of the repository. Never extract a sensitive legacy archive into the working tree or rewrite shared Git history as an incidental cleanup.

## Verification

- Run checks proportional to the changed surface and report skipped or unavailable checks explicitly.
- Backend or shared JavaScript changes: `npm test`.
- MongoDB transaction, concurrency, import, approval, backfill, or migration changes: `npm run test:integration` in addition to focused tests.
- Catalog identity, provider, importer, search, or album-bearing surface changes: `npm run check:catalog-contract`.
- Frontend changes: `npm --prefix frontend run lint` and `npm --prefix frontend run build`.
- A full release/readiness gate is: `npm test`, `npm run test:integration`, `npm run check:catalog-contract`, `npm --prefix frontend run lint`, and `npm --prefix frontend run build`.
- Do not treat a dated checked-in report, old test count, or successful server startup as proof of the current database state. When running locally, `/health` must report `status: "ok"`, not `degraded`.

## Documentation

- Update the relevant maintained guide when behavior, configuration, data contracts, operator steps, or rollout expectations change. Do not duplicate an entire runbook in a second document.

## Code Review Rules

- Flag public Mongo IDs, provider results masquerading as catalog albums, authorization enforced only in the UI, non-transactional publication fallbacks, live-network unit tests, or data applies that bypass reviewable artifacts. Safe paths are public Rescened IDs, a distinct external-candidate shape, server-side checks, transaction-or-503 behavior, captured fixtures, and an exact reviewed dry-run artifact.
