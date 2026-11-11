---
name: rescened-verify
description: Select, run, and interpret Rescened checks during implementation and before independent review, including applicable async and lifecycle cases. Use for backend, MongoDB, catalog-contract, or frontend verification and post-fix checks; live-provider checks remain explicit opt-in.
---

# Verify Rescened changes

Use this skill while designing and implementing the change, not only when a reviewer finds a bug. Build the smallest credible evidence set for the changed surfaces, and follow the required checks in [AGENTS.md](../../../AGENTS.md). Clearly state when the full gate was not run. Treat [the root scripts](../../../package.json) and [the frontend scripts](../../../frontend/package.json) as the maintained command source; update this skill if those scripts change.

## Protect the worktree

Inspect `git status --short`, the relevant diff, and the touched files before choosing checks. The worktree may contain user or concurrent-agent changes.

- Do not stash, reset, checkout, clean, discard, or overwrite unrelated changes to make verification easier.
- Do not run formatters or auto-fixers unless the task calls for those edits.
- Do not claim a failure is pre-existing without evidence from an appropriate baseline or unaffected comparison.

## Check async and lifecycle cases before review

The implementer owns these checks before independent review. Select the cases that apply to the changed behavior; do not add unrelated tests just to complete a checklist. For each applicable risk, establish the expected result and test it or record the specific coverage gap. Briefly explain non-applicability when a case might otherwise reasonably be expected.

| Applicable case | What to exercise and establish |
| --- | --- |
| Delayed or out-of-order responses | Start request A, change the selected record, viewer, route, or filter, then finish A after the newer request. A must not overwrite the newer view, reveal stale private data, or clear the newer operation's loading/error state. Check completion and cleanup paths, not only successful responses. |
| Navigation, cancellation, or unmounting | Leave or close the view during a request, then complete or reject it. Obsolete callbacks, timers, subscriptions, and listeners must not update a later view or leak resources. Cancellation alone is not proof that an already-completing response cannot apply. |
| List resets and pagination | Clear, replace, filter, or delete from a list while an older page request is pending. Its response must not append obsolete rows, restore deleted items, or use a cursor from the previous query. |
| Duplicate actions and ambiguous retries | Double-submit or retry after a timeout where the first write may have committed. Preserve intentional separate actions while preventing duplicate records, audit events, counts, or side effects for the same action. A disabled button does not replace server-side protection. |
| Concurrent writes | Run competing creates, edits, moderation commands, or limit checks against the same state. Verify the relevant unique constraint, conditional write, or transaction keeps the invariant and returns the documented conflict or retry result. UI refreshes must not release a still-running mutation's lock. |
| Deletion, privacy, and related state | Delete or change access while reads or writes are pending. Check related records, counts, and later responses: no unintended orphan, recreation, stale private result, or follow-up write that bypasses current authorization. |
| Failures, conflicts, and reloads | Fail a write or reload, then retry. The retry must perform the needed request and reconcile with authoritative state, not merely revisit the same route. Preserve recoverable input and keep pending/success/error state tied to the operation that owns it. |

Use controlled deferred responses, barriers, or injected clocks instead of relying on arbitrary sleeps to reproduce ordering. Keep backend concurrency tests on disposable fixtures or the repository's integration harness, never the shared development database. Add a focused regression test when existing coverage does not prove the changed behavior.

For visible behavior, exercise the relevant browser flow when permitted and distinguish it from API or component-only checks. Do not claim browser behavior from an API response. Fix evidenced in-scope issues and rerun affected checks before handing the actual diff and results to the independent reviewer. A review-only assignment does not authorize implementation fixes or test execution outside its assigned scope.

## Choose proportional checks

Use targeted checks while iterating, then broaden when a shared boundary changed:

| Changed surface | Minimum credible verification |
| --- | --- |
| Backend route, model, utility, or script | Relevant `node --test tests/<file>.test.js` while iterating; `npm test` before handoff, as required by AGENTS.md |
| Transactions, persistence, moderation, catalog import, cover backfill, or legacy migration | Relevant unit tests plus `npm run test:integration` |
| Catalog schema, identity, importer, provider mapping, or catalog-facing API/UI | Relevant tests plus `npm run check:catalog-contract` |
| Frontend component, page, styles, routing, or API consumption | `npm --prefix frontend run lint` and `npm --prefix frontend run build` |
| Runtime configuration, dependency, release, or broad cross-stack change | Run the full gate below |

Add a focused regression test when behavior changed and no existing test proves it. A narrow pass is not enough when the edited code feeds multiple consumers.

The full repository gate is:

```sh
npm test
npm run test:integration
npm run check:catalog-contract
npm --prefix frontend run lint
npm --prefix frontend run build
```

The MongoDB integration runner enables `RUN_MONGO_INTEGRATION=true` and exercises the replica-set suites listed in [the runner](../../../scripts/runIntegrationTests.js). Its first run may need to provision a `mongodb-memory-server` binary. If provisioning is unavailable, report an infrastructure-blocked check rather than a product pass or a product regression.

## Keep live provider checks explicit

Normal verification must remain deterministic and offline. It may include captured-provider fixture tests, but do not run `npm run test:catalog-live` unless the user explicitly requests live verification. That command calls public ListenBrainz and MusicBrainz services and is intentionally separate from the normal gate; see [the live test](../../../tests/listenBrainzCatalog.live.test.js).

## Interpret results accurately

- Record each command and its exit status. Do not report a check as passed merely because later commands passed.
- Report test counts from the current run; do not reuse counts from handoff notes.
- An intentional skip is neither a pass nor a failure. The default suite's live-provider skip is expected. Mongo integration coverage counts only when the integration runner actually executes it.
- Distinguish assertion or compile failures from environment failures, missing dependencies, unavailable Mongo binaries, timeouts, and provider/network failures.
- For a failure, identify the first actionable cause and the affected test or file. Do not bury it under the complete log.
- Note meaningful warnings separately. A successful build with warnings is still a pass, but an actionable warning belongs in the evidence.

## Report evidence

End with a compact verification report containing:

- `PASS`, `FAIL`, `SKIPPED`, or `NOT RUN` for every selected command;
- current test counts or the relevant failure location;
- applicable async/lifecycle cases exercised, their observed results, and meaningful coverage gaps;
- why omitted checks were outside scope or unavailable;
- whether the full gate was run, and its exact commands if the user may want to run it next.

Do not say the change is fully verified when a required surface is failed, skipped, or blocked.
