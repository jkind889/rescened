---
name: rescened-migration-operator
description: Plan, review, validate, execute, reconcile, cut over, or roll back Rescened generation-1-to-generation-2 MongoDB migrations. Use for the sealed legacy migration workflow; not ordinary schema changes, catalog imports, or general maintenance.
---

# Operate a Rescened legacy migration

Preserve the evidence, database boundaries, and operator authorization needed to turn an immutable generation-1 snapshot into a verified generation-2 candidate.

Read the maintained [migration workflow](../../../docs/LEGACY_DATA_MIGRATION_WORKFLOW.md) before acting. Use the current [migration CLI](../../../scripts/migrateLegacyDatabase.js) as the command contract; inspect the [runtime guards](../../../lib/legacyMigration/runtime.js), [apply implementation](../../../lib/legacyMigration/apply.js), and [verifier](../../../lib/legacyMigration/verify.js) when reviewing or changing their behavior.

## Choose the operating level

- **Audit or review:** Inspect source material, code, inventories, plans, reports, and checksums. Keep database access read-only. Do not restore data, create indexes or ledgers, apply a plan, change `MONGO_URI`, or imply that review approval authorizes execution.
- **Plan:** Planning may read the isolated source and candidate and write local artifacts, but must not mutate either database. Prefer `npm run db:migrate:legacy:plan -- --run-dir <run-dir> [--overrides <file>]`, which performs inventory, dry-run planning, artifact sealing, and validation.
- **Execute:** `db:migrate:legacy:execute` and `--apply` mutate the candidate and may create indexes and a migration ledger. Use them only when the current user request explicitly authorizes applying the identified sealed plan to the exact identified candidate database.
- **Cut over or roll back:** Treat API write freezes, snapshots, connection-string changes, restarts, and reopening writes as separate live operations. Migration execution alone does not authorize them.

If the request is only to inspect, diagnose, prepare, or review, stop at that boundary and report the next decision instead of advancing to a mutating mode.

## Preserve immutable boundaries

- Keep the transferred archive untouched outside the repository. Record its absolute path, size, SHA-256, provenance, and transfer details; work from a second copy.
- Restore only into an isolated source name such as `rescened_gen1_source_<run-id>`. Never start the current API against that source.
- Use a separate candidate such as `rescened_gen2_candidate_<run-id>`. Source and target URIs must contain explicit, different database names; never accept `test`, a shared namespace, the live target, or an ambiguous URI.
- Keep credentials in session-only `LEGACY_MONGO_URI` and `MIGRATION_TARGET_MONGO_URI`, never in commands or artifacts. Store sensitive output under ignored `.migration/legacy-gen1/<run-id>/`.
- Do not migrate in place or copy generation-1 indexes. A failed or partial candidate is discarded or resumed from sealed state, never promoted by assumption.

## Build and review a sealed plan

1. Generate the CLI inventories for every source and target collection. They record collection counts, data hashes, field/type statistics, indexes, and database fingerprints. Record the candidate baseline before any migration index, ledger, or application write exists. Put deeper duplicate, orphan, and relationship analysis in plan outcomes or separate review evidence when available; do not claim the inventory itself guarantees those findings.
2. Review the sealed plan's source and target fingerprints, operations, outcomes, counts, validation fingerprint, exact target database name, and embedded `planSha256`. Keep the archive SHA-256, source provenance, and schema/tool commits alongside the sealed artifacts as external run evidence; do not claim they are embedded plan bindings unless the implementation adds them.
3. Build a complete album crosswalk and place every source row in a reported outcome. Legacy clues may locate candidates but cannot authorize fuzzy matches or populate active target fields. Transform from field allowlists rather than spreading legacy BSON.
4. Quarantine unresolved, conflicting, or ambiguous identities. Never guess during apply. Manual overrides require a supported decision plus reason, approver, and ISO decision time; include them in the sealed reports.
5. Generate public album and track IDs exactly once during planning. The plan owns those IDs, so repeat application cannot create different identities.
6. Validate transformed documents, deduplication decisions, relationship remaps, quarantines, and planned writes. Review `plan-report.json` and `quarantine.json`; protect the provider-key crosswalk and do not commit run artifacts.
7. Use the embedded `planSha256` from `plan.json` or `plan-report.json` as the execution token. It is deliberately different from the separate on-disk file digest. Never hand-edit a sealed artifact; change the reviewed inputs and create a new run.

Exit `0` means clean, `2` means planning completed with quarantine or conflicts, and `1` means fatal failure or a rolled-back batch unless the post-commit rules below say otherwise. Exit `2` is reviewable output, not permission to ignore unresolved cutover dispositions.

## Gate candidate application

Immediately before apply, verify all of the following:

- The user has authorized this exact candidate database, run directory, and embedded plan checksum. Authorization to plan or review is insufficient.
- `--confirm-target` exactly matches the connected database and the target sealed into the plan, and the target is neither the source, `test`, nor a live database.
- The candidate baseline still matches the sealed target fingerprint, all blocking dispositions are approved, and the plan validates without modification. Planning checked the source against its inventory; apply does not reread the source. If a fresh source-state check is required, rerun read-only inventory and planning, review the new sealed plan, and obtain new apply authorization.
- The environment supports MongoDB transactions and the operator understands the expected writes, reports, and rollback boundary.

Then use the routine command:

```sh
npm run db:migrate:legacy:execute -- --run-dir <run-dir> --plan-sha256 <plan-sha256> --confirm-target <database>
```

Prefer the routine `plan` and `execute` commands. Use phase-specific inventory, dry-run, validate, apply, or verify modes only for inspection or recovery described by the workflow.

## Interpret execution safely

- Application is checksum-bound, transactional by batch, ledgered, and resumable. A retry must use the same run, sealed checksum, and target; never bypass drift or lease failures.
- A command can exit `1` **after database commit** if apply-report writing or candidate verification fails. Treat `APPLY_COMMITTED_REPORT_FAILED`, `APPLY_COMMITTED_VERIFICATION_FAILED`, or the CLI's committed warning as committed state, not rollback.
- After a committed reporting or verification failure, preserve the candidate and artifacts, inspect the immutable attempt reports, and rerun execute with the same sealed plan/checksum/target to revalidate ledger state and retry reporting or verification safely. Do not generate a replacement plan or apply unrelated repairs first.
- Report whether writes committed separately from whether reports and verification completed.

## Reconcile, accept, and cut over

Candidate verification must cover source-to-target outcome buckets, deduplications, user/social relationships, aggregates, forbidden legacy fields, indexes, idempotency, repository tests, the catalog contract, frontend checks, and API health/smoke behavior described in the workflow. Every quarantine or conflict needs an approved cutover disposition. Do not equate a successful apply with acceptance.

Cutover requires its own explicit authorization and write freeze, final immutable snapshots, complete reconciliation, and successful smoke checks. Change only the API target URI, restart, and verify before reopening writes. Before writes reopen, rollback is a URI switch to the preserved prior generation-2 target plus restart and verification. After writes reopen, rollback is not lossless without replaying post-cutover writes; never promise otherwise.

In the handoff, state the operating level, exact source and candidate names, run directory, hashes, outcome/quarantine counts, command exit, whether the database committed, verification status, and the next approval boundary without exposing credentials.
