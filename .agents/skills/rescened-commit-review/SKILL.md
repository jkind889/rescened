---
name: rescened-commit-review
description: >-
  Review recent Rescened commits (a branch against main, a commit range, or the
  last N commits) for holes, edge cases, and bugs, prove each suspected bug
  with a throwaway reproduction, and report ranked findings. Use when asked to
  "dive into the recent commits", "look for holes / edge cases / bugs", or
  review a branch before a PR; not for implementing features or running data
  applies.
---

# Review recent Rescened commits

Find real defects in recently committed work and prove them before reporting.
A finding without a concrete failing input is a risk note, not a bug.

Read [AGENTS.md](../../../AGENTS.md) first; its catalog, authorization,
moderation, provider, and data-operation rules are the baseline invariants.
For submission or moderation changes also follow
[rescened-moderation-change-review](../rescened-moderation-change-review/SKILL.md).
Use [rescened-verify](../rescened-verify/SKILL.md) to pick and run checks.

## 1. Fix the scope

- Default scope is the current branch's own commits. Branches are often
  stacked, so verify the intended parent branch, base commit, and reviewed
  head rather than assuming everything since `main` belongs to this feature.
  Use the PR base or explicit task context and Git ancestry to establish the
  range. Commit subjects are clues, not sufficient evidence of the base; if
  the intended scope remains unclear, ask before reviewing the wrong range.
- Read `git diff --stat <base>..HEAD` and group files by layer: models,
  `lib/` services, routes, scripts/CLIs, frontend, docs, tests.
- Check `git status --short`. Other sessions may share the checkout; never
  stash, reset, or edit their files while reviewing.

## 2. Read services before routes

Read the core library and model changes in full, then routes, then the
frontend that feeds them. Trace each feature end to end: request parsing,
validation, persistence, the read path, and what the UI shows.

## 3. Hunt with these questions

Lifecycle and state:
- For every status (active/retired, pending/needs_changes/approved/rejected/
  withdrawn, merged): what still references a record in that state, and does
  every reader agree on whether it counts?
- Does every reverse operation (restore, un-retire, withdraw, revise) re-check
  the invariants the forward operation enforced (name ownership, parent
  status, nesting depth, caps)?
- After a merge, can either side be restored, renamed, or reparented into a
  state the merge was meant to rule out?

Counts and limits:
- Does the count the user sees match the count the server enforces? Hidden
  rows (retired, private, filtered) that still count toward a cap make records
  stuck.
- Are caps check-then-insert (racy) or enforced by an index/condition?

Concurrency and transactions:
- Is every multi-document write in one transaction with a revision condition?
  Does a stale command return 409 instead of overwriting?
- Does an idempotent retry avoid a second audit event?

Data shape:
- Dotted-path `$set` on fields that may be `null` or non-objects in legacy
  documents (MongoDB refuses `a.b` when `a` is null).
- `default: undefined` fields: does every query treat "missing" as 0/empty?
- Unique vs non-unique indexes: can two records claim the same key through an
  array field (aliases) that the unique index doesn't cover?

Identity and exposure:
- No Mongo `_id` in public responses, URLs, or error details; no provider IDs
  in `albumId`; external candidates stay distinct from catalog albums.
- Authorization on the server, feature flags on every mutation route, reads
  still working with mutation flags off.

Operator CLIs:
- Dry run first; apply requires the exact reviewed artifact (checksum or plan
  hash), not just a matching count.
- Committed-then-report-failed is distinguished from rolled back.

Client/server parity:
- Does the client normalize names, keys, and limits the same way the server
  does? Mismatches produce confusing 400s.

## 4. Prove each suspected bug

Write a throwaway script in the session scratchpad (never in the repo) that
starts `MongoMemoryReplSet`, syncs indexes, seeds the minimum documents, calls
the library function or route, and prints the result. Require repo modules by
absolute path and resolve packages with
`require.resolve(name, { paths: [repoRoot] })`. Run it from the repo root.
Only reproduced behavior goes under "Confirmed bugs".

## 5. Run the checks

Run `npm test`, plus `npm run test:integration` when transactions, imports,
approval, merges, or concurrency changed, plus `npm run check:catalog-contract`
for catalog or album-bearing surfaces, plus frontend lint/build when the UI
changed. Note that passing suites with a confirmed bug mean a test is missing.

## 6. Report

- Confirmed bugs first, most severe first. For each: file:line, the violated
  invariant, the concrete input and the observed output from the repro, and
  the fix direction (point at an existing helper when one already solves it).
- Then smaller gaps and scaling risks, one or two lines each.
- State which checks ran and their results, and what was not verified.
- Do not fix anything unless asked; offer to fix the confirmed bugs with a
  regression test for each.
