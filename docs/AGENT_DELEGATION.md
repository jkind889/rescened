# Rescened agent delegation

This guide defines how the main agent divides Rescened work among the existing Codex subagent roles. The repository's [AGENTS.md](../AGENTS.md) requests delegation for suitable independent work and remains the source of product invariants and required checks.

## Hierarchy

```text
User
└── Main agent — coordination, decisions, integration, final result
    ├── Explorer — read-only investigation
    ├── Executor — a bounded implementation package
    ├── Tester — independent verification
    └── Documentation writer — maintained guides
```

These are responsibilities, not four agents that must always run. Run at most three subagents simultaneously, subject to the runtime's lower limit. Reuse an existing subagent for related follow-up work. Subagents report directly to the main agent and do not spawn their own children.

## Roles and ownership

| Responsibility | Preferred runtime role | Assigned work | Boundary |
| --- | --- | --- | --- |
| Coordinator | Main agent | Clarify the outcome, choose interfaces, assign files, resolve conflicts, review the combined diff, and deliver the result | Own Git mutations and final acceptance; delegation does not transfer accountability |
| Investigation | `explorer` | Trace behavior, find relevant files and contracts, identify risks with evidence | Read-only; return findings without implementing fixes |
| Implementation | `executor_luna` | Implement one package with explicit acceptance criteria | Edit only assigned production files; tests and docs require explicit assignment |
| Difficult implementation | `executor_sol` | Handle an unusually difficult package that cannot be split effectively | Same ownership rules; use only when complexity justifies it |
| Verification | `tester`, if available; otherwise `worker` | Inspect the diff, add meaningful assigned regression coverage, run selected checks | Own assigned tests and fixtures; send production defects back to the coordinator |
| Documentation | `doc-writer` | Update assigned maintained guides from verified behavior and results | Own only assigned documents; report uncertainty instead of inventing behavior |

Use only roles exposed by the current runtime. A personal TOML file on disk does not prove that its role is available in an already-running session. If a preferred role is missing, use an available `worker` or `default` with an explicit brief, or do the work in the main agent. Preserve configured model choices; this hierarchy does not change model settings.

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

For a tester fallback, explicitly restrict edits to the assigned tests and fixtures and require production defects to be reported rather than fixed. For an explorer fallback, explicitly prohibit edits. Never include secret values in a task brief or handoff.

## Execution and acceptance

1. Inspect the working tree and identify pre-existing changes. Define the desired outcome and the smallest useful packages.
2. Resolve interface decisions that would otherwise block workers. Assign file ownership and acceptance criteria in each brief.
3. Spawn only independent work while the coordinator continues useful local work. For example, backend and frontend packages can proceed together once their contract is agreed.
4. Have agents report evidence when a finding changes scope, risk, or dependencies. Route scope changes and ownership transfers through the coordinator; stop the previous writer before transferring a file.
5. Run verification against a stable implementation. Tests sharing a database, port, generated files, or build output must run sequentially. Use the repository's verification rules and `rescened-verify` skill when available; report skipped or unavailable checks explicitly.
6. Return production defects to the implementation owner, then repeat affected checks after fixes. Update documentation from the resulting behavior.
7. Review the combined diff and all required results before reporting completion. A subagent's claim of success alone is not proof that the integrated change works.

The coordinator can complete any responsibility directly when delegation would add overhead. This guide does not require new tests for low-impact documentation or configuration edits. It also does not authorize live-provider tests, database applies, publication, or other actions outside the user's task.

## Example request

> Implement this feature using the Rescened delegation hierarchy. Investigate the relevant contracts, assign independent backend and frontend work where possible, verify the combined change, and update the maintained guide. Keep file ownership explicit and return the final results here.

## Codex setup

The hierarchy is repository guidance and uses the subagent tools and roles available in the current session. It does not install custom agents or change personal Codex configuration. Codex supports delegation requested through applicable `AGENTS.md` instructions; custom roles, when needed, are defined separately. See the [official OpenAI subagent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents).
