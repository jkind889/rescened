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
