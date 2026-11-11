---
name: rescened-cover-backfill
description: >-
  Dry-run, review, explicitly apply, and verify Rescened missing-cover
  backfills from exact MusicBrainz/Cover Art Archive identities. Use for blank
  catalog artwork only; not manual replacement, broad imports, arbitrary
  enrichment, or legacy migration.
---

# Rescened cover backfill

Use the repository command to fill only covers that are still missing. Never
turn this workflow into an overwrite or a direct database patch.

## Maintained sources

Read the [catalog bootstrap section](../../../README.md#catalog-bootstrap) and
the current [cover backfill CLI](../../../scripts/backfillMissingAlbumCovers.js)
before operating the workflow. The script is authoritative for current flags,
report fields, reason codes, and optimistic write guards. The focused
[backfill tests](../../../tests/coverBackfill.test.js) document expected safety
behavior. If prose and implementation disagree, stop before apply and report
the mismatch.

## Establish the run

- Confirm the intended database through `MONGO_URI` without printing the URI.
- Use separate, dated or run-labelled paths for dry-run, apply, and verification
  reports. The default `.migration/cover-backfill/report.json` is convenient
  for one run but would overwrite earlier evidence.
- Keep `MUSICBRAINZ_USER_AGENT` only as the optional identifying override used
  by the maintained resolver. Do not add alternate providers or download,
  proxy, or rehost artwork as part of this operation.

## Dry-run first

Run dry-run explicitly, even though it is the default:

```sh
npm run catalog:backfill-covers -- --dry-run --report path/to/dry-run.cover-report.json
```

Dry-run reads the catalog and calls the resolver but must not update catalog
rows. Read the JSON report and confirm `mode: "dry-run"`, `applied: false`,
`fatal: false`, and `updated: 0`.

Interpret the result as follows:

- `scanned` is the set that lacked covers at scan time; `resolved` is the set
  with an acceptable canonical CAA result; `updated` is zero in dry-run.
- `unresolved`, `conflicts`, and `failures` require entry-level review. Separate
  identity or artwork gaps from transient provider failures.
- `referenceConflicts` means a resolved MusicBrainz release reference belongs
  to another catalog album. That row must not be written automatically.
- Exit code `0` means every scanned row resolved cleanly, `2` means unresolved,
  conflicted, or failed rows remain in the non-fatal report, and `1` means a
  fatal database or report failure. Exit `2` is a review outcome, not a crash.

Summarize counts and every non-resolved outcome. Do not infer that a URL is safe
from appearance alone; the CLI accepts only its validated canonical
Cover Art Archive `front-500` form and matching release identity.

## Apply authorization gate

After dry-run, present the non-secret target label, report path, counts,
unresolved/conflict/failure findings, and the exact proposed apply command.
Explain that apply resolves rows again and uses guarded writes. Proceed only
after the user explicitly authorizes `--apply` for that target. General cleanup
or maintenance permission is insufficient, and authorization does not carry to
a different target or materially changed dry-run.

Use a separate report path:

```sh
npm run catalog:backfill-covers -- --apply --report path/to/apply.cover-report.json
```

Never weaken or bypass the command's blank-cover and original-`updatedAt`
guards. The guarded update ensures a cover added after the scan wins; the
command must never replace an existing, manual, or concurrent cover. A release
reference owned by another album also prevents the write.

## Interpret and verify apply

1. Confirm the report has `mode: "apply"`, `applied: true`, `fatal: false`, and
   plausible scanned, resolved, updated, unresolved, conflict, and failure
   counts. Exit codes retain the dry-run meanings.
2. Inspect every `concurrent_update`. It means the blank-cover plus original
   timestamp guard matched no row. Read the current record: preserve a cover
   that appeared concurrently; if the row is still blank after another field
   changed, send it through a fresh dry-run rather than forcing an update.
3. Inspect every `reference_conflict`; no cover should have been written for
   that outcome. Leave identity resolution to a separate reviewed workflow.
4. Run a fresh dry-run to a third report path. Successfully updated rows should
   no longer be scanned. Review all remaining missing rows and reconcile them
   with unresolved, failed, reference-conflict, or changed concurrent outcomes.
5. Spot-check updated records for a canonical CAA `front-500` URL, cover field
   provenance, and a non-conflicting MusicBrainz release reference. Preserve
   the dry-run, apply, and verification reports with target and timestamp.

Apply is not documented as a single transaction. If it exits `1` or writes a
fatal report, do not assume earlier worker updates rolled back and do not
immediately repeat apply. Inspect current state with a fresh dry-run first.

If the implementation changes, run `node --test tests/coverBackfill.test.js`
before relying on the modified command. Ordinary operator runs do not need to
change the implementation.
