# Repository verification

Run `npm run verify` from the repository root for the full readiness gate. It runs the existing backend tests, disposable MongoDB integration suites, catalog-contract check, frontend lint, and frontend production build in that order. Root and frontend remain separate npm packages.

## Prerequisites

Use Node 22 or later with npm. Install the locked dependencies with `npm ci` and `npm --prefix frontend ci`. Mongo integration requires permission to bind local sockets and start disposable `mongod` replica-set processes, plus the binary version selected by the existing `mongodb-memory-server` harness already in its normal cache. The gate disables runtime downloads; missing binaries fail the integration stage. Provisioning a binary is a separate environment preparation step, not an offline verification result. No shared or production database is used.

The gate refuses root/frontend `.env` variants (except `.example`, `.sample`, and `.template` files) rather than letting dotenv or Vite load private settings. Preserve existing files; use a clean checkout for verification. Child commands receive only operating-system path/home/temp variables, `NODE_ENV=test` (or `production` for the frontend build), disabled live-test switches, and offline Mongo settings. Inherited credentials, feature flags, Vite variables, `NODE_OPTIONS`, npm configuration variables, and Mongo binary overrides are not forwarded. This is environment isolation for the repository's current checks, not a general network sandbox. Live-provider checks remain separate and require explicit authorization.

## Results

Each stage prints its output, followed by a final `PASSED`, `FAILED`, or `NOT RUN` summary. Ordinary failures do not prevent later stages from running. Missing global prerequisites leave all stages `NOT RUN`; interruption fails the active stage and leaves later stages `NOT RUN`. Exit status is zero only when every required stage passes. A failed or unavailable check is never full-gate success.

Integration uses the existing runner's `--verify` mode to request TAP output. A zero exit alone is insufficient: the gate requires a nonempty test summary with passes and zero failures, skipped tests, cancellations, or TODOs. Default backend-suite skips for explicitly opt-in Mongo/live tests are expected; Mongo coverage comes from the separate integration stage.

On SIGINT/SIGTERM the gate stops scheduling checks, terminates its active child process group on POSIX, and waits for close; after five seconds it escalates to SIGKILL. On Windows it terminates the immediate child only, so full descendant cleanup is not guaranteed. No unrelated process or preview is stopped.

For focused iteration, continue using the individual commands documented in [AGENTS.md](../AGENTS.md) and the [verification skill](../.agents/skills/rescened-verify/SKILL.md). Record current counts, stage failures, and environment gaps when handing work to review. The gate does not add browser tests, dependency audits, CI policy, or proof of live database health.

## Pull request checks

[The Verification workflow](../.github/workflows/verify.yml) runs the same `npm run verify` gate and a separate `npm run test:browser` job for every pull request, pushes to `main`, and manual dispatches. It uses a GitHub-hosted Ubuntu 24.04 runner and Node 22 (the patch release selected by `setup-node`). The workflow becomes available after publication; adding it locally does not enable branch protection or make the check required.

Root and frontend dependencies are installed separately from their lockfiles with lifecycle scripts disabled. Before verification, an explicit preparation step resolves/downloads the locked Mongo harness's default binary with its MD5 check enabled into the normal per-runner cache. That step does not start a database; the integration suites start and clean up their own disposable replica sets. Preparation failures stop the job. The gate keeps runtime downloads disabled and does not skip integration or change frontend production-build behavior. Initial dependency and Mongo provisioning require network access; live-provider checks remain disabled.

The workflow has only `contents: read`, does not persist checkout credentials, and uses no secrets, environments, shared database, cross-run caches, or uploaded artifacts. It runs untrusted PR code only on an ephemeral hosted runner through `pull_request`, never `pull_request_target`. New runs cancel superseded runs for the same PR/ref; the aggregate job has a 20-minute limit and Mongo binary preparation a five-minute limit. The independent browser job has a 15-minute limit, with five-minute limits each for browser provisioning and test execution. Cancellation/timeout aborts the run rather than producing a successful gate. Hosted execution and Linux-specific binary compatibility must be confirmed after publication.

The browser job repeats the two locked, script-disabled npm installs and invokes `node node_modules/playwright/cli.js install --with-deps chromium`. This uses the exact root-lockfile Playwright (currently 1.58.2), with no npx/latest fallback or alternate browser/module path. Provisioning and the browser command start with only HOME and PATH inherited; the test runner further sanitizes its child environment. The official CLI installs the corresponding Chromium/headless shell and uses apt/sudo to prepare its Linux libraries/fonts on the disposable Ubuntu runner. This is broader OS provisioning than a browser download: apt package versions depend on the runner image and current Ubuntu repositories, so it is not a fully hermetic system image. No system packages are installed on a developer machine by the workflow. Provisioning or browser failures fail the job; skipped/empty/incomplete test summaries fail the existing runner. The independent job runs even when the aggregate job fails; neither job uses continue-on-error. Hosted Ubuntu dependency provisioning and browser execution remain unverified until the workflow is published and runs there.

## Explicit synthetic browser suite

After both locked installs, prepare the pinned browser separately with `node node_modules/playwright/cli.js install chromium`, then run `npm run test:browser`. Missing dependencies, browser, forbidden dotenv files, test failures, and skipped/incomplete test summaries fail closed. Browser provisioning needs network access; execution uses only disposable loopback fixture servers, synthetic fetch/auth responses, and real frontend components. Vite runs in middleware mode behind Node HTTP servers bound directly to `127.0.0.1:0`, so the OS assigns and holds each ephemeral port without Vite's 5173 fallback or a reserve/release race. Both HMR and Vite's independent WebSocket server are disabled (`hmr: false`, `ws: false`), so fixtures do not bind port 24678. A fixture-only transform also removes the locked Vite client's automatic HMR connection while retaining its CSS helpers; it fails closed if that connection statement changes; no application preview, database, credentials, or live provider is used. The runner sanitizes inherited configuration just like the aggregate gate. Chromium discovery runs in a fresh process with that same sanitized environment before preflight; the resulting pinned path is passed to the tests. Inherited `PLAYWRIGHT_BROWSERS_PATH` and npm browser-path overrides cannot affect either step. It does not accept alternate browser/module paths.

The command runs the existing artist cover-cycle, discography, biography moderation, and contributor-edition evidence fixtures, a correction-form artist-credit fixture, an artist picker fixture, an artist-linked album suggestion fixture, plus a core component fixture. It covers:

- Cover cycling, reduced motion, pause/focus/visibility, and broken artwork.
- Discography duplicate requests, filter resets, stale pages, and unmount cancellation.
- Biography moderator sign-out, user changes, attribution, staged revision acceptance, and stale-edit conflict/reload/retry.
- Correction-form artist credits: a comma in a name stays one credit, links, roles, and order are preserved, edits and add/remove submit structured credits, draft rows restore (an old comma-joined draft is ignored), and unrelated field groups are unaffected.
- Artist picker: separate Rescened and MusicBrainz result lists, explicit selection only (same-name artists stay distinct, an exact registered MBID selects the Rescened artist), local results while MusicBrainz is throttled or down with no automatic retry, empty and malformed responses, stale answers after a newer search, a query edit, row removal, reset, navigation, and sign-out (answered even after abort), community-artist link validation with no fetch, keyboard-only use, and 390 px overflow.
- Artist links on album suggestions: picker selections on credit rows (Enter in the picker never submits the suggestion), unchanged credit wording, roles and order, renumbered positions after removing a credit, the legacy payload with linking off, restored links on revision, moderator review of each link with evidence and observation time, approval sending the displayed revision (and no link-existing option for linked suggestions), approved resolutions, and 390 px overflow.
- Review posting, navigation during submission, per-user draft isolation and retry with the original payload/key; a board album note save; public biography visibility and exact article/revision/license attribution.

This is rendered component integration with synthetic callbacks, not full application routing, real Clerk sign-out, server authorization, catalog search, album saving to a board, review persistence, or database E2E. Those remain gaps for a later milestone. The existing standalone page-metadata browser check is separate and is not part of this command.

Each run prints a unique temporary artifact directory containing TAP output, Playwright traces, final screenshots, and DOM snapshots from fixture contexts, including assertion failures before cleanup. Use `node node_modules/playwright/cli.js show-trace /path/to/trace.zip` to inspect a trace. Artifacts remain outside the checkout; remove them when no longer needed. CI retains console/TAP output in the job log but does not upload traces, screenshots or DOM files; temporary artifacts disappear with the hosted runner. Missing-browser failures occur before browser artifacts can be captured.

Browser checks remain separate from `npm run verify`; the GitHub workflow runs them in the independent Browser fixtures job. A green aggregate job does not imply a green browser job. Run this explicit command locally for relevant UI changes and report its result separately. Normal `npm test` keeps the opt-in fixtures skipped.

SIGINT/SIGTERM stops the runner's own test process group on POSIX, with a five-second escalation to SIGKILL; unrelated previews are untouched. Windows only guarantees termination of the immediate child, as with the aggregate runner. An interrupted run is a failure and may have only partial artifacts.

## Targeted architecture rules

`npm run check:architecture` checks direct source boundaries with the pinned Espree parser; `-- --help` prints usage. The same checker is enforced by `npm run check:catalog-contract`, including its existing stage in `npm run verify` and CI. Frontend ESLint retains its existing React rules; no blanket effect/timer/comment restrictions are added.

The scan covers JavaScript/JSX under `frontend/src` and `routes` recursively. Diagnostics include file, line, rule, and remediation:

- `ARCH_FRONTEND`: literal imports, re-exports, `require`, and dynamic imports in frontend source cannot escape the frontend package or import Node built-ins, Express, MongoDB/Mongoose, dotenv, or server Clerk packages. Keep browser helpers inside frontend and call the API for server behavior.
- `ARCH_ROUTE_NETWORK`: routes (including route utilities) cannot call `fetch`/`global.fetch`/`globalThis.fetch` directly or import known HTTP clients (`http`, `https`, `http2`, `undici`, `axios`, `node-fetch`, `got`, `superagent`). Remote calls belong in the existing `lib` adapter/service boundaries; provider source URLs and attribution strings remain allowed.
- `ARCH_DELEGATED_PERSISTENCE`: only the existing `artistBiographyModeration.js` and `commentModeration.js` routes are barred from importing models or MongoDB/Mongoose directly. They already delegate to biography/comment moderation services. Other routes currently mix reads/writes with orchestration and are not subject to a newly invented service-layer rule.

Computed module specifiers, parse errors, missing scan roots, and source symlinks fail closed. Ordinary comments and strings are not interpreted as imports. There are no production-code exceptions needed by the current checkout. The checker uses CommonJS syntax for routes and ES modules/JSX for frontend source.

These are direct syntactic/lexical boundaries, not whole-program analysis: aliases, indirect/re-exported dependencies, custom import resolvers, computed network access, new client packages, and arbitrary persistence helpers are not exhaustively traced. The two route restrictions do not prove that a command calls the right service, authenticates a viewer, enforces a feature flag, conditions a write, or uses a transaction. Authorization/concurrency behavior still needs route/service review and executable tests. This milestone adds architecture-tooling regressions, not a new invariant-test or security-audit suite.

## Deterministic persistence invariants

The existing integration gate also runs these bounded invariants against disposable Mongo replica sets, with synthetic biography sources and no live provider calls:

- `tests/moderation.integration.test.js`: discard a committed catalog-correction response, retry in bursts of 1/3/2, and compare persisted catalog/submission records, revision, audit history, notifications, and row counts. A retry after a later correction must preserve that later correction.
- `tests/boardOrder.integration.test.js`: exercise all 24 permutations of four albums through the API; check persisted order, unchanged membership/saved times, previews, stale-retry conflicts, and remove/rejoin order after each permutation.
- `tests/artistBiographies.integration.test.js`: pause a real refresh at a controlled fixture-source barrier, suppress while it waits, and check stale-write rejection, duplicate-command conflicts without extra audits, and continued public suppression through later content and identity refreshes.

These extend existing concurrency tests; they do not exhaust transaction schedules, arbitrary board sizes, network failure modes, or browser/auth flows. The discarded-response case models a committed write whose caller received no usable response; it does not inject a Mongo driver commit-acknowledgement failure. Run them via `npm run test:integration` (or `npm run verify`); ordinary `npm test` skips their Mongo cases.

## Dependency/security snapshots

Dependency audits require current online advisory data and remain separate from the offline gate. See the [2026-11-14 dependency/security review](DEPENDENCY_SECURITY_REVIEW.md) for the reviewed paths, compatible lock updates, residual development advisory, runtime recommendation, install-script policy, and validation limits. A green test gate does not clear unresolved advisories.
