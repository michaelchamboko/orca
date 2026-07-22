# ORCA Controller Completion — Test Evidence

This document records empirical test evidence captured during execution of the ORCA Controller Completion plan. Each entry includes the task identifier, commit, exact commands run, their exit codes, and any reviewer notes.

## Evidence format

| Task | Commit | Command | Exit | Notes / Review |
|---|---|---|---|---|

## TASK-000 — Record approved artifacts

| Task | Commit | Command | Exit | Notes / Review |
|---|---|---|---|---|
| TASK-000 | (this commit) | `git status --short` | 0 | Only planning documents in commit |
| TASK-000 | (this commit) | `git log -1 --oneline` | 0 | Starting commit `a78f239` recorded |

## TASK-001 — Repair baseline invariants

| Task | Commit | Command | Exit | Notes / Review |
|---|---|---|---|---|
| TASK-001 | (this commit) | `pnpm.cmd exec vitest run tests/unit/persistence.test.ts tests/unit/domain-workflow.test.ts tests/contract/controller-start.test.ts` | 0 | 35 tests passed (persistence: 15, workflow: 10, controller-start: 10) |
| TASK-001 | (this commit) | `pnpm.cmd run lint` | 0 | Clean (added `.gitnexus/**` and `.orca/**` to ESLint ignores; declared `URL` global) |
| TASK-001 | (this commit) | `pnpm.cmd run typecheck` | 0 | Clean |
| TASK-001 | (this commit) | `pnpm.cmd run test:unit` | 0 | 75 tests passed (was 73; +2 for roster history + re-pair guard) |
| TASK-001 | (this commit) | `pnpm.cmd run build` | 0 | Three ESM bundles built |

## TASK-002 — Harden worker completion

| Task | Commit | Command | Exit | Notes / Review |
|---|---|---|---|---|
| TASK-002 | (this commit) | `pnpm.cmd exec vitest run tests/unit/worker-completion.test.ts` | 0 | 13 tests pass (was 7; +6: repair-with-new-prompt-id, repeated invalid, active lineage, restart durability, timeout from createdAt, completion rollback) |
| TASK-002 | (this commit) | `pnpm.cmd run test:unit` | 0 | 81 tests pass (was 75; +6 net) |
| TASK-002 | (this commit) | `pnpm.cmd run test:integration` | 0 | 9 tests pass (planner dispatch unchanged) |
| TASK-002 | (this commit) | `pnpm.cmd run typecheck` | 0 | Clean |
| TASK-002 | (this commit) | `pnpm.cmd run lint` | 0 | Clean |

## TASK-003 — Orchestrator actions

| Task | Commit | Command | Exit | Notes / Review |
|---|---|---|---|---|
| TASK-003 | TBD | `pnpm.cmd exec vitest run tests/unit/orchestrator-actions.test.ts tests/integration/orchestrator-actions.test.ts` | TBD | |
| TASK-003 | TBD | `pnpm.cmd run typecheck` | TBD | |
| TASK-003 | TBD | `pnpm.cmd run lint` | TBD | |

## TASK-004 — Mission transitions

| Task | Commit | Command | Exit | Notes / Review |
|---|---|---|---|---|
| TASK-004 | TBD | `pnpm.cmd exec vitest run tests/integration/mission-transitions.test.ts tests/integration/planner-dispatch.test.ts` | TBD | |
| TASK-004 | TBD | `pnpm.cmd run test:unit` | TBD | |
| TASK-004 | TBD | `pnpm.cmd run typecheck` | TBD | |
| TASK-004 | TBD | `pnpm.cmd run lint` | TBD | |

## TASK-005 — Workspace quality gates

| Task | Commit | Command | Exit | Notes / Review |
|---|---|---|---|---|
| TASK-005 | TBD | `pnpm.cmd exec vitest run tests/unit/workspace-fingerprint.test.ts tests/integration/quality-gates.test.ts` | TBD | |
| TASK-005 | TBD | `pnpm.cmd run test:unit` | TBD | |
| TASK-005 | TBD | `pnpm.cmd run typecheck` | TBD | |
| TASK-005 | TBD | `pnpm.cmd run lint` | TBD | |

## TASK-006 — Controller-approved checks

| Task | Commit | Command | Exit | Notes / Review |
|---|---|---|---|---|
| TASK-006 | TBD | `pnpm.cmd exec vitest run tests/unit/orca-config.test.ts tests/integration/controlled-test-runner.test.ts` | TBD | |
| TASK-006 | TBD | `pnpm.cmd run typecheck` | TBD | |
| TASK-006 | TBD | `pnpm.cmd run lint` | TBD | |

## TASK-007 — Role skills

| Task | Commit | Command | Exit | Notes / Review |
|---|---|---|---|---|
| TASK-007 | TBD | `pnpm.cmd exec vitest run tests/unit/role-activation.test.ts tests/e2e/pair-live.test.ts` | TBD | |
| TASK-007 | TBD | `pnpm.cmd run typecheck` | TBD | |
| TASK-007 | TBD | `pnpm.cmd run lint` | TBD | |

## TASK-008 — Final completion and fake acceptance

| Task | Commit | Command | Exit | Notes / Review |
|---|---|---|---|---|
| TASK-008 | TBD | `pnpm.cmd run lint` | TBD | |
| TASK-008 | TBD | `pnpm.cmd run typecheck` | TBD | |
| TASK-008 | TBD | `pnpm.cmd run test:unit` | TBD | |
| TASK-008 | TBD | `pnpm.cmd run test:integration` | TBD | |
| TASK-008 | TBD | `pnpm.cmd run test:contract` | TBD | |
| TASK-008 | TBD | `pnpm.cmd run test:e2e:fake` | TBD | |
| TASK-008 | TBD | `pnpm.cmd run test:coverage` | TBD | |
| TASK-008 | TBD | `pnpm.cmd run build` | TBD | |
| TASK-008 | TBD | `pnpm.cmd run verify` | TBD | |

## TASK-009 — Real OpenCode acceptance

| Task | Commit | Command | Exit | Notes / Review |
|---|---|---|---|---|
| TASK-009 | TBD | `pnpm.cmd run test:e2e:real` (env `ORCA_REAL_E2E=1`) | TBD | |
| TASK-009 | TBD | `pnpm.cmd run verify` | TBD | |