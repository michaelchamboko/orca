# ORCA Controller Completion — Test Evidence

This document records empirical test evidence captured during execution of the ORCA
Controller Completion plan. Each entry includes the task identifier, commit, exact
commands run, their exit codes, and any reviewer notes.

## Evidence format

| Task | Commit | Command | Exit | Notes / Review |
|---|---|---|---|---|

## R95-001 — Port isolation baseline

| Task | Commit | Command | Exit | Notes / Review |
|---|---|---|---|---|
| R95-001 | `38ab149` | `pnpm.cmd run test:unit` | 0 | 92 unit tests pass with `eslint-config-prettier` and tests using ephemeral ports |
| R95-001 | `38ab149` | `pnpm.cmd run test:contract` | 0 | Controller startup tests pass with ephemeral ports and missing-profile rejection |
| R95-001 | `38ab149` | `pnpm.cmd run test:integration` | 0 | Planner dispatch tests pass with `port: 0` |
| R95-001 | `38ab149` | `pnpm.cmd run typecheck` | 0 | Clean |
| R95-001 | `38ab149` | `pnpm.cmd run lint` | 0 | Clean |

## R95-005 — Production runtime wiring

| Task | Commit | Command | Exit | Notes / Review |
|---|---|---|---|---|
| R95-005 | `37d067b` | `pnpm.cmd run test:unit` | 0 | 92 unit tests pass with reconciliation mutex and mission context wired |
| R95-005 | `37d067b` | `pnpm.cmd run test:integration` | 0 | Planner dispatch tests pass with serialized reconciliation cycle |
| R95-005 | `37d067b` | `pnpm.cmd run test:contract` | 0 | Controller startup tests pass |
| R95-005 | `37d067b` | `pnpm.cmd run typecheck` | 0 | Clean |
| R95-005 | `37d067b` | `pnpm.cmd run lint` | 0 | Clean |
| R95-005 | `37d067b` | `pnpm.cmd run build` | 0 | Three ESM bundles built |

## R95-006 — Workspace fingerprint

| Task | Commit | Command | Exit | Notes / Review |
|---|---|---|---|---|
| R95-006 | `5c11707` | `pnpm.cmd exec vitest run tests/unit/workspace-fingerprint.test.ts` | 0 | 8 tests pass (stable hash, tracked/untracked, exclusion, control-plane, traversal, symlink escape, normalization) |
| R95-006 | `5c11707` | `pnpm.cmd run test:unit` | 0 | 100 unit tests pass |
| R95-006 | `5c11707` | `pnpm.cmd run typecheck` | 0 | Clean |
| R95-006 | `5c11707` | `pnpm.cmd run lint` | 0 | Clean |

## R95-007 — Workspace quality gates

| Task | Commit | Command | Exit | Notes / Review |
|---|---|---|---|---|
| R95-007 | `6806a3a` | `pnpm.cmd exec vitest run tests/unit/quality-gates.test.ts` | 0 | 24 tests pass (planner, builder, reviewer, tester, workspace delta, read-only mutation, correction cap) |
| R95-007 | `6806a3a` | `pnpm.cmd run test:unit` | 0 | 124 unit tests pass |
| R95-007 | `6806a3a` | `pnpm.cmd run typecheck` | 0 | Clean |
| R95-007 | `6806a3a` | `pnpm.cmd run lint` | 0 | Clean |

## R95-008 — Controlled checks

| Task | Commit | Command | Exit | Notes / Review |
|---|---|---|---|---|
| R95-008 | `06619fe` | `pnpm.cmd exec vitest run tests/unit/orca-config.test.ts tests/integration/controlled-test-runner.test.ts` | 0 | 13 unit tests + 2 integration tests pass (schema, executables, args, timeouts, sequential exec, output cap) |
| R95-008 | `06619fe` | `pnpm.cmd run test:unit` | 0 | 137 unit tests pass |
| R95-008 | `06619fe` | `pnpm.cmd run typecheck` | 0 | Clean |
| R95-008 | `06619fe` | `pnpm.cmd run lint` | 0 | Clean |

## R95-009 — Role skills

| Task | Commit | Command | Exit | Notes / Review |
|---|---|---|---|---|
| R95-009 | `9a497aa` | `pnpm.cmd exec vitest run tests/unit/role-activation.test.ts tests/e2e/pair-live.test.ts` | 0 | 7 unit tests + 8 e2e tests pass; skills included in profile hash |
| R95-009 | `9a497aa` | `pnpm.cmd run typecheck` | 0 | Clean |
| R95-009 | `9a497aa` | `pnpm.cmd run lint` | 0 | Clean |

## R95-010 — Final completion

| Task | Commit | Command | Exit | Notes / Review |
|---|---|---|---|---|
| R95-010 | `050f129` | `pnpm.cmd exec vitest run tests/integration/completion-gates.test.ts tests/contract/controller-start.test.ts` | 0 | 4 completion gate tests + 11 controller start tests pass |
| R95-010 | `050f129` | `pnpm.cmd run test:unit` | 0 | 143 unit tests pass |
| R95-010 | `050f129` | `pnpm.cmd run typecheck` | 0 | Clean |
| R95-010 | `050f129` | `pnpm.cmd run lint` | 0 | Clean |
| R95-010 | `050f129` | `pnpm.cmd run build` | 0 | Three ESM bundles built |

## R95-011 — Full fake five-session E2E acceptance

| Task | Commit | Command | Exit | Notes / Review |
|---|---|---|---|---|
| R95-011 | `53a3735` | `pnpm.cmd exec vitest run tests/e2e/fake-complete-mission.test.ts` | 0 | 2 tests pass (model preservation + completion gate rejection) |
| R95-011 | `53a3735` | `pnpm.cmd run test:e2e:fake` | 0 | 10 e2e tests pass (pair-live + fake-complete-mission) |
| R95-011 | `53a3735` | `pnpm.cmd run test:integration` | 0 | 33 integration tests pass |
| R95-011 | `53a3735` | `pnpm.cmd run test:unit` | 0 | 148 unit tests pass |
| R95-011 | `53a3735` | `pnpm.cmd run test:contract` | 0 | 30 contract tests pass |
| R95-011 | `53a3735` | `pnpm.cmd run typecheck` | 0 | Clean |
| R95-011 | `53a3735` | `pnpm.cmd run lint` | 0 | Clean |
| R95-011 | `53a3735` | `pnpm.cmd run build` | 0 | Three ESM bundles built |

## Test summary

- 18 unit test files, 148 tests
- 6 integration test files, 33 tests
- 3 contract test files, 30 tests
- 2 fake E2E test files, 10 tests
- 1 real E2E test (skipped without `ORCA_REAL_E2E=1`)
- Total: 221 tests across 30 files

## Coverage

Coverage is reported by `pnpm.cmd run test:coverage`. Threshold targets remain at
85% statements/lines/functions and 80% branches per NFR-008. Type-only modules
(`*.d.ts`, `types.ts`, `errors.ts`) and the persistence barrel `index.ts` are
excluded from coverage measurement because they have no runtime code paths.

## OpenCode live acceptance

Real OpenCode e2e coverage remains opt-in. Run `pnpm.cmd run test:e2e:real` with
`ORCA_REAL_E2E=1` once a real OpenCode backend is configured to advance beyond the
95% readiness milestone.