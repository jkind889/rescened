# Rescened agent delegation

This guide describes how to divide Rescened work in T3, Codex, or Claude without losing context or overlapping edits. The repository's [AGENTS.md](../AGENTS.md) remains the source of product invariants and required checks. Use only the tools and capabilities exposed by the current session.

## Hierarchy

```text
User
└── Main agent — coordination, decisions, integration, final result
    ├── Investigator — read-only exploration
    ├── Implementer — a bounded change
    ├── Reviewer or tester — independent review or verification
    └── Documentation writer — maintained guides
```

These are responsibilities, not four agents that must always run. Run at most three subagents simultaneously, subject to the runtime's lower limit. Continue related follow-up work with the existing agent when the runtime supports it. Subagents report directly to the main agent and do not spawn their own children.

## Roles and ownership

| Responsibility | Assigned work | Boundary |
| --- | --- | --- |
| Coordinator | Clarify the outcome, choose interfaces, assign files, resolve conflicts, review the combined diff, and deliver the result | Own Git mutations, integration, and final acceptance; delegation does not transfer accountability |
| Investigation | Trace behavior, find relevant files and contracts, identify risks with evidence | Read-only; return findings without implementing fixes |
| Implementation | Implement one bounded change with explicit acceptance criteria | Edit only assigned production files; tests and docs require explicit assignment |
| Review | Read the actual current diff, surrounding code, and relevant tests; report actionable findings | Read-only; do not edit, run tests, or treat reported test results as personally verified |
| Testing | Add assigned regression coverage and run selected checks | Own assigned tests and fixtures; send production defects back to the coordinator |
| Documentation | Update assigned maintained guides from verified behavior and results | Own only assigned documents; report uncertainty instead of inventing behavior |

Check the current delegation tools before choosing a role, model, or isolation mode. In T3, use its exposed capabilities rather than assuming that a personal Codex role or Claude agent definition is available. In a native Codex or Claude session, use that session's supported subagent tools. Assign the responsibility in the brief when there is no matching named role, or do the work in the main agent. Preserve the user's model choices; do not silently substitute a reviewer or change model settings.

## Checkout and runtime ownership

- Give every agent the exact checkout, branch, intended base, and current change scope. Worktrees and threads are separate concepts; confirm where the task will execute.
- If agents share a checkout, give concurrent writers disjoint files. Freeze the review scope while an independent review runs. If the code changes, that review no longer covers the new state.
- If an agent uses an isolated worktree, confirm its starting commit and what it can see. Do not assume uncommitted parent changes are present. The coordinator owns any authorized integration and reviews the combined result.
- Worktree isolation does not isolate development databases, ports, providers, or build output outside the checkout. Assign those resources too, and serialize operations that share mutable state.
- Retain returned task or thread identifiers and use the current runtime's supported continuation and status tools. An accepted dispatch is not completed work; inspect the result before reporting success.

## Dividing Rescened work

Assign exact files within these areas after inspection; these examples do not grant blanket ownership.

| Area | Typical scope | Coordination requirements |
| --- | --- | --- |
| Backend | `routes/`, `models/`, relevant `lib/` files | Agree on API and identity contracts before frontend implementation |
| Frontend | `frontend/` components, pages, and styles | Use agreed response shapes and error codes; keep secrets server-side |
| Catalog and providers | Provider adapters, import modules, operator scripts | Use the applicable repository skill; distinguish code changes from authorized data operations |
| Verification | Relevant `tests/` and fixtures | Coordinate database, port, build, and fixture ownership before running checks |
| Documentation | The maintained guide for the changed behavior | Supply final contracts, configuration changes, and observed verification results |

Package manifests, lockfiles, shared utilities, and cross-cutting contracts need one named owner. If two packages need the same file, sequence the changes or keep that file with the coordinator. Never give concurrent writers overlapping ownership.

## Task brief

Send each subagent a self-contained brief. Include enough context to execute without rediscovering the whole project.

```text
Task ID and role:
Outcome:
Context and agreed contracts:
Checkout, branch, and intended base:
Shared checkout or isolated worktree:
Current diff or commits in scope:
Owned files (explicit paths):
Read-only dependencies:
Acceptance criteria:
Required checks and working directory:
Relevant AGENTS.md rules and skills:
Dependencies / when work may start:
Authorization limits:

You are not alone in this codebase. Preserve other contributors' edits and
adapt to them. Do not revert unrelated changes. Edit only your assigned files.
If ownership overlaps or the task requires additional files, report the
evidence and proposed scope to the coordinator before editing those files.
Do not mutate Git state or spawn additional subagents.

Return: status, files changed or inspected, behavior/findings, checks actually
run and their results, remaining risks or blockers, and next action.
```

For testing work, restrict edits to assigned tests and fixtures and require production defects to be reported rather than fixed. For investigation and review, explicitly prohibit edits. Give reviewers the actual diff, relevant files, and validation output, not just the implementer's summary. Never include secret values in a task brief or handoff.

## Execution and acceptance

1. Inspect the working tree and identify pre-existing changes. Define the desired outcome and the smallest useful packages.
2. Resolve interface decisions that would otherwise block workers. Assign file ownership and acceptance criteria in each brief.
3. Spawn only independent work while the coordinator continues useful local work. For example, backend and frontend packages can proceed together once their contract is agreed.
4. Have agents report evidence when a finding changes scope, risk, or dependencies. Route scope changes and ownership transfers through the coordinator; stop the previous writer before transferring a file.
5. Run verification against a stable, integrated implementation. Tests sharing a database, port, generated files, or build output must run sequentially. Use the repository's verification rules and `rescened-verify` skill when available; report skipped or unavailable checks explicitly. Model review does not replace executed tests.
6. Return production defects to the implementation owner, then repeat affected checks after fixes. Update documentation from the resulting behavior.
7. Review the combined diff and all required results before reporting completion. A subagent's claim of success alone is not proof that the integrated change works.

The coordinator can complete any responsibility directly when delegation would add overhead. This guide does not require new tests for low-impact documentation or configuration edits. It also does not authorize live-provider tests, database applies, publication, or other actions outside the user's task.

## Example request

> Implement this feature using the Rescened delegation hierarchy. Investigate the relevant contracts, assign independent backend and frontend work where possible, verify the combined change, and update the maintained guide. Keep file ownership explicit and return the final results here.

## Instruction files and setup

`AGENTS.md` is the shared project guidance. The root `CLAUDE.md` imports it with `@AGENTS.md` so the two files do not maintain separate copies. See [Claude's import documentation](https://code.claude.com/docs/en/memory#import-additional-files).

This guide does not install custom agents, register roles, change personal settings, or make a skill available in another checkout. Verify actual file and runtime availability. A missing role or skill is a limitation to report, not a reason to invent a tool or skip the project's checks.
