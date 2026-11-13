---
name: rescened-catalog-rollout
description: >-
  Run Rescened's artifact-driven ListenBrainz/MusicBrainz catalog batch
  workflow: fetch, checksum, validate, dry-run, review, explicitly apply, and
  verify. Use for broad catalog growth or refresh; not interactive search,
  community submissions, legacy migration, or cover-only backfills.
---

# Rescened catalog rollout

Operate from the repository root. Keep the rollout artifact-driven and manual;
do not replace the maintained CLIs with ad hoc database writes.

## Maintained sources

Read the [catalog import operator guide](../../../docs/CATALOG_IMPORT.md) before
running a rollout. For recurring-batch policy, also read
[incremental catalog growth](../../../docs/SEARCH_AND_CATALOG_GROWTH.md#incremental-catalog-growth).
Treat the current [fetch CLI](../../../scripts/fetchListenBrainzCatalog.js),
[validation CLI](../../../scripts/validateCatalogDataset.js), and
[import CLI](../../../scripts/importCatalogDataset.js) as the executable
contracts for flags and reports. If the documentation and implementation
disagree, stop before mutation and report the mismatch.

## Non-negotiable boundaries

- A batch may write `AlbumCatalog` records only. It must not synthesize
  submissions, moderation events, reviews, likes, boards, profiles, or feed
  activity.
- Keep an album absent from a later dataset; absence is never deletion
  authority.
- Treat `MONGO_URI` as a secret. Confirm the intended environment without
  printing credentials.
- Apply only to a replica-set or sharded MongoDB target whose transaction
  capability has been established. A standalone server is not an apply target.
- Loading this skill, running a dry-run, or receiving general maintenance
  approval does not authorize `--apply`.

## Prepare and fingerprint the batch

1. Establish the target environment, its transaction capability, and the
   appropriate backup or snapshot. Record a non-secret target label with the
   rollout evidence.
2. Use a dataset named for its actual generation date, normally
   `data/catalog-import/seeds/listenbrainz-YYYY-MM-DD.json`. When generation is
   requested, use `npm run catalog:fetch -- --output ...`; a usable bundle must
   include the dataset, `.sha256` sidecar, and `.fetch-report.json` sidecar.
   Never promote a failed or underfilled fetch.
3. Verify the dataset bytes against the SHA-256 sidecar with an available local
   SHA-256 utility. Record the resolved path, digest, file size, and dataset ID.
   Never rewrite the sidecar to make a mismatch pass.
4. Choose distinct, target-labelled report paths for validation, dry-run,
   apply, and post-apply verification. The importer defaults would otherwise
   let a later run replace earlier evidence. No report path may alias the input
   dataset or another report.

Once validation or review starts, do not edit, regenerate, rename, or refetch
the artifact. Any byte or checksum change creates a new batch that must restart
the workflow.

## Validate offline

Run the maintained validator against the exact artifact, supplying the chosen
validation report path:

```sh
npm run catalog:validate -- --input data/catalog-import/seeds/listenbrainz-YYYY-MM-DD.json --report path/to/validation-report.json
```

Read the JSON report, not only console output. For a successful validation,
confirm the expected dataset ID and schema version, `fatal: false`, total,
valid, and quarantined counts, and the quarantine details. A fatal report has
`fatal: true`, error details, and quarantine information; dataset and count
fields may be absent. Exit code `0` is clean, `2` is a completed validation
with quarantined rows, and `1` is fatal. A fatal result stops the rollout.
Exit `2` may inform a later dry-run, but it never silently authorizes apply;
inspect every quarantine entry and carry it into the review summary.

## Dry-run against the target

Use the same checksummed artifact and the intended target database. Supply
separate report destinations so this evidence survives apply:

```sh
npm run catalog:import -- --input data/catalog-import/seeds/listenbrainz-YYYY-MM-DD.json --dry-run --report path/to/dry-run.import-report.json --quarantine-report path/to/dry-run.quarantine-report.json
```

Inspect both reports. Confirm the import report has the expected dataset ID,
`mode: "dry-run"`, `applied: false`, and the expected counts; a failure report
instead carries `fatal: true` and error details. Review inserted, refreshed,
unchanged, quarantined, and conflicted counts; inspect every
quarantine and conflict entry, and investigate surprising growth or refresh
ratios. Exit code `0` is clean, `2` means the preflight completed with issues,
and `1` is fatal. Do not treat exit `2` as a crash or as permission to ignore
the affected rows.

If the target changes materially after preflight, rerun and review a fresh
dry-run before seeking apply authorization.

## Apply authorization gate

Before any mutation, present:

- the non-secret target label and confirmed transaction capability;
- dataset ID, exact resolved artifact path, and verified SHA-256 digest;
- validation and dry-run counts plus all quarantine/conflict findings;
- retained report locations and backup or snapshot status; and
- the exact proposed `--apply` command.

Proceed only after the user explicitly authorizes applying that artifact to
that target. Approval does not carry across a changed artifact, digest, target,
or materially changed preflight. Immediately before execution, recompute and
match the digest and recheck the dataset ID. Abort on any mismatch.

Run the maintained importer with explicit `--apply` and new report paths:

```sh
npm run catalog:import -- --input data/catalog-import/seeds/listenbrainz-YYYY-MM-DD.json --apply --report path/to/apply.import-report.json --quarantine-report path/to/apply.quarantine-report.json
```

Accepted writes execute in one transaction. Exit code `0` is clean, `2` is a
completed apply with reported issues, and `1` is normally fatal or rolled
back. Trust any explicit CLI signal that database changes were committed,
however. Known committed-state codes include
`IMPORT_COMMITTED_ARTIFACT_FINALIZATION_FAILED` and
`IMPORT_COMMITTED_SESSION_CLEANUP_FAILED`. They mean commit succeeded but a
later artifact-finalization or session-cleanup step failed: do not describe
the result as rollback and do not rerun apply blindly. Preserve the evidence,
inspect the target, and use a fresh dry-run to establish the current state.

## Verify and retain evidence

1. Inspect the apply and quarantine reports. Confirm the dataset ID,
   `mode: "apply"`, `applied: true`, and all counts, with no fatal failure
   artifact. Compare the result with the reviewed dry-run and explain any
   target-state drift.
2. Recheck the artifact digest. Run another dry-run of the same artifact to
   fresh, verification-specific report paths; previously accepted rows should
   now be unchanged unless a documented concurrent change explains otherwise.
3. Run `npm test`, `npm run test:integration`, and
   `npm run check:catalog-contract` when the environment supports them. The
   live-provider smoke test is opt-in and requires separate explicit intent.
4. Smoke-test catalog listing, search, and album detail against the target.
   Exercise review, like, and board-save mutations only in a disposable
   development/staging environment or after separate explicit authorization
   for those target mutations with a safe test account and cleanup plan;
   otherwise report them as not run. Record the observations.
5. Retain the exact dataset, checksum, fetch report, validation report, both
   dry-run reports, both apply reports, verification reports, command exit
   codes, timestamps, and non-secret target record together.

Stop rather than apply when the checksum is missing or mismatched, validation
or preflight is fatal, the target is uncertain or not transaction-capable,
reported issues remain unreviewed, or explicit apply authorization is absent.
