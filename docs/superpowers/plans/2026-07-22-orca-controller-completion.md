# ORCA Controller Completion Implementation Plan

**Date:** 2026-07-22
**Status:** Approved (planning mode output, not yet implemented)
**Source:** Planning session output, approved for execution

**For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Each implementation must be reviewed by a different agent.

**Goal:** Deliver a controller-enforced, restart-safe five-session ORCA mission.

**Architecture:** Extend the existing adapter, SQLite workflow and outbox. Every handoff is durably recorded before delivery, and only correlated Session 1 actions can advance gates.

**Tech Stack:** TypeScript, Node.js, SQLite/better-sqlite3, Zod, Fastify, Vitest, OpenCode Server 1.18.3 compatibility.

## TASK-000 — Record approved artifacts and isolate execution

- Requirements: all.
- Create a `codex/orca-controller-completion` worktree from `a78f239`.
- Record the starting commit and current line-ending-only snapshot status.
- Save the approved requirements and plan to the paths in Section 1.
- Create `docs/test-evidence.md` headings for task, commit, commands, exits and review.
- Commit: `docs: define ORCA controller completion`.

Verification:

```powershell
git status --short
git log -1 --oneline
```

Expected: only intentional planning documents in the commit; unrelated user work absent.

## TASK-001 — Repair baseline invariants

Requirements: FR-001–005, NFR-005, NFR-010.

Files: `eslint.config.js`, `src/persistence/sqlite.ts`, pairing code, domain workflow/policy, controller runtime tests and package scripts.

Test-first cases:

- `.gitnexus/**` is excluded from maintained-source linting.
- Tests use ephemeral controller ports while CLI runtime defaults to 4317.
- Re-pairing during an active mission fails without deleting the current roster.
- Historical rosters survive successful re-pairing.
- Completed maps to approved; blocked, failed and cancelled preserve matching task states.
- Required lanes no longer rely on absent-test success after their suites exist.

Commands:

```powershell
pnpm.cmd exec vitest run tests/unit/persistence.test.ts tests/unit/domain-workflow.test.ts tests/contract/controller-start.test.ts
pnpm.cmd run lint
pnpm.cmd run typecheck
```

Expected red evidence: new roster-history and terminal-state assertions fail against current code.
Expected green evidence: focused suites and static checks exit `0`.

Review: migration compatibility, port exposure, no roster/model mutation.
Commit: `fix: preserve ORCA workflow baseline invariants`.

## TASK-002 — Harden worker completion and repair recovery

Requirements: FR-006–008, FR-019, NFR-001–002, NFR-006, NFR-012.

Produce:

- Migration 5 fields and `task_prompt_attempts`.
- `StableResponseTracker` in `response-stability.ts`.
- Atomic repair enqueue and atomic completion persistence.
- Active-lineage tool filtering.
- Acknowledgement-based timeout.
- Durable session/provider/permission failure state.
- Immediate return after terminal transition.

Required tests:

- Same invalid output observed repeatedly.
- New invalid repair response.
- Restart before repair delivery and acknowledgement.
- Restart during quiet window.
- Active versus unrelated tool parts.
- Session deletion, provider error, permission request and roster drift.
- Completion transaction rollback.
- Timeout measured from acknowledgement.

Commands:

```powershell
pnpm.cmd exec vitest run tests/unit/worker-completion.test.ts tests/integration/worker-completion-recovery.test.ts
pnpm.cmd run typecheck
pnpm.cmd run lint
```

Commit: `fix: harden ORCA worker completion recovery`.

## TASK-003 — Add correlated Session 1 actions

Requirements: FR-009, NFR-003–004.

Produce:

- `OrchestratorAction` schema.
- Migration 6 action-message table.
- Durable decision and repair prompts through the outbox.
- Session 1 stable-response observation.
- Idempotent action outcome persistence.

Required tests:

- Valid approve/reject/completion.
- Invalid version, unknown field and task-ID rules.
- Session 1 user-injected JSON.
- Worker-session action.
- Wrong parent, mission or task.
- Duplicate and stale action.
- One durable repair and second invalid block.
- Premature completion.

Commands:

```powershell
pnpm.cmd exec vitest run tests/unit/orchestrator-actions.test.ts tests/integration/orchestrator-actions.test.ts
pnpm.cmd run typecheck
pnpm.cmd run lint
```

Commit: `feat: validate orchestrator workflow actions`.

## TASK-004 — Generalize dispatch and mission transitions

Requirements: FR-010–011, FR-017, FR-019–021, NFR-001–002.

Produce:

- Rename Planner outbox to `DispatchOutbox`.
- Add `MissionService.transitionMission()`.
- Store transition, consumption marker, approval/action outcome, next task, snapshot, event and dispatch in one transaction.
- Reconcile completed-but-unconsumed tasks on startup.
- Implement Planner and Builder automatic corrections, two attempts each.
- Block after exhaustion.
- Preserve worker isolation and exact paired model.

Required transition tests:

- Happy transition at every gate.
- Plan and Builder rejection corrections.
- Wrong current state/task rejection.
- Failure injection at approval, task, snapshot, event and dispatch writes.
- Restart before and after consumption.
- Duplicate action/result.
- Worker blocked/failed.
- No direct worker routing.

Commands:

```powershell
pnpm.cmd exec vitest run tests/integration/mission-transitions.test.ts tests/integration/planner-dispatch.test.ts
pnpm.cmd run test:unit
pnpm.cmd run typecheck
pnpm.cmd run lint
```

Commit: `feat: enforce durable ORCA mission transitions`.

## TASK-005 — Enforce workspace and quality gates

Requirements: FR-012–014, FR-016–017, NFR-007.

Produce:

- Content-aware `WorkspaceFingerprint`.
- Path containment using resolved repository-relative paths.
- Separate control-plane hash.
- Builder evidence reconciliation.
- Read-only-role mutation detection.
- Gate-specific approvals and supersession.
- Review/test corrections routed only to Builder.
- Two corrections per review or test gate.

Required tests:

- HEAD, staged, unstaged and untracked changes.
- Filenames with spaces and binary content.
- Reproducible unchanged fingerprint.
- Excluded generated directories.
- Path traversal and symlink escape.
- `.orca`, `.opencode` and configuration modification.
- Builder evidence mismatch.
- Read-only-role write.
- Stale review/test approval.
- Third failed correction blocks.

Commands:

```powershell
pnpm.cmd exec vitest run tests/unit/workspace-fingerprint.test.ts tests/integration/quality-gates.test.ts
pnpm.cmd run test:unit
pnpm.cmd run typecheck
pnpm.cmd run lint
```

Commit: `feat: enforce ORCA workspace quality gates`.

## TASK-006 — Add controller-approved checks

Requirements: FR-015, NFR-007.

Produce:

- Strict `orca.config.json` loader.
- Configuration/control-plane hash.
- Controlled sequential test runner.
- Windows `pnpm.cmd` resolution.
- Persisted bounded check evidence.
- Tester task created from controller evidence.
- Exact reconciliation of Tester verdict with check results.

Required tests:

- Unknown fields, duplicate names, empty executable.
- Shell operators, newline/NUL arguments and oversized arguments.
- Windows executable resolution.
- `shell:false`, repository cwd and bounded environment.
- Timeout, spawn failure and 64 KiB truncation.
- Configuration drift.
- Contradictory Tester verdict.
- Failed controller check still reaches Tester and then Builder.

Commands:

```powershell
pnpm.cmd exec vitest run tests/unit/orca-config.test.ts tests/integration/controlled-test-runner.test.ts
pnpm.cmd run typecheck
pnpm.cmd run lint
```

Commit: `feat: run controller-approved ORCA checks`.

## TASK-007 — Install role-specific skills and instructions

Requirements: FR-003, FR-011–012, NFR-011.

Skill assignments:

| Role | Assigned skills |
|---|---|
| Shared | structured result contract, repository safety, evidence reporting |
| Orchestrator | delegation, approval, retry, escalation, completion |
| Planner | repository discovery, architecture analysis, decomposition, planning |
| Builder | implementation, debugging, refactoring, test-driven development |
| Reviewer | correctness, architecture, security, regression, maintainability |
| Tester | test planning, controlled-evidence analysis, failure diagnosis, evidence reporting |

Produce:

- Repository-owned `.opencode/skills/orca-*` assets.
- Exact skill identifiers in `RoleProfile`.
- Pairing installation and activation hashing.
- No model fields.
- No external skill dependency.
- No Orchestrator task tool, and no write/shell tools outside Builder.

Commands:

```powershell
pnpm.cmd exec vitest run tests/unit/role-activation.test.ts tests/e2e/pair-live.test.ts
pnpm.cmd run typecheck
pnpm.cmd run lint
```

Commit: `feat: assign ORCA role skills during pairing`.

## TASK-008 — Enforce final completion and fake acceptance

Requirements: FR-010–022 except real execution, NFR-003–012.

Produce:

- Controller completion predicate.
- Readiness and redacted operational status.
- Full heterogeneous-model fake harness.
- Updated architecture, operations, threat model and evidence.
- Required test lanes without `--passWithNoTests`.

Fake E2E must prove:

- Exact five-session prompt order.
- Happy path.
- Planner and Builder rejection corrections.
- Review and test correction loops.
- Third correction block.
- Missing Builder evidence.
- Stale approvals.
- Unauthorized actions.
- Duplicate SSE/poll events.
- Restart around every dispatch acknowledgement.
- Permission, roster, repository and control-plane drift.
- Premature completion.
- Exact paired model on every prompt.

Commands:

```powershell
pnpm.cmd run lint
pnpm.cmd run typecheck
pnpm.cmd run test:unit
pnpm.cmd run test:integration
pnpm.cmd run test:contract
pnpm.cmd run test:e2e:fake
pnpm.cmd run test:coverage
pnpm.cmd run build
pnpm.cmd run verify
```

Every command must exit `0`.

Commit: `feat: enforce complete ORCA mission gates`.

## TASK-009 — Real OpenCode acceptance

Requirements: FR-022, NFR-010.

Preconditions:

- OpenCode server reachable and authenticated.
- Exactly five current paired sessions.
- Five profile hashes current.
- No active mission.
- Fake release gate passed.
- Operator has reviewed the test mission's permitted documentation path.

Create an opt-in real test that:

- Uses persisted sessions and models.
- Never creates a session or changes a model.
- Sends one Session 1 documentation mission.
- Observes prompts in Sessions 2–5.
- Uses a correction-fixture objective requiring the first implementation to omit a named documentation line so Reviewer requests one correction.
- Restarts the controller around one acknowledged task.
- Verifies no duplicate prompt.
- Completes only through correlated `request_completion`.
- Records OpenCode version, roster hash, prompt IDs, timestamps, fingerprints and exit results without prompt bodies or credentials.

Commands:

```powershell
$env:ORCA_REAL_E2E = "1"
pnpm.cmd run test:e2e:real
pnpm.cmd run verify
```

Both commands must exit `0`.

Commit: `test: verify live five-session ORCA mission`.

## 11. Subagent assignment and review matrix

| Task | Implementer | Independent reviewer | Dedicated verifier |
|---|---|---|---|
| TASK-001 | Persistence/baseline agent | Compatibility reviewer | Migration/test-isolation agent |
| TASK-002 | Recovery agent | Reliability reviewer | Crash-injection agent |
| TASK-003 | Authorization agent | Security reviewer | Action-contract agent |
| TASK-004 | Workflow agent | Architecture reviewer | Transaction/replay agent |
| TASK-005 | Workspace-safety agent | Security reviewer | Path/evidence adversary |
| TASK-006 | Test-runner agent | Command-safety reviewer | Injection/timeout agent |
| TASK-007 | Role-profile agent | Permission reviewer | Pairing contract agent |
| TASK-008 | Integration agent | Requirements reviewer | Fake-E2E adversary |
| TASK-009 | Live-validation agent | Release reviewer | Human-visible tab verifier |

Per task:

1. Fresh implementation agent.
2. Focused red-green-refactor cycle.
3. Atomic task commit.
4. Lead inspects diff and evidence.
5. Separate specification reviewer.
6. Separate code-quality/security reviewer.
7. Correction agent fixes important findings.
8. Focused and regression tests rerun.
9. Reviewer approves corrected commit.

No implementing agent may approve its own work.

## 12. Consolidated testing strategy

| Layer | Scope | Command |
|---|---|---|
| Unit | Schemas, state policy, fingerprinting, config and completion logic | `pnpm.cmd run test:unit` |
| Integration | SQLite transactions, recovery, transitions, gates and runner | `pnpm.cmd run test:integration` |
| Contract | Controller auth/runtime and OpenCode HTTP/SSE | `pnpm.cmd run test:contract` |
| Fake E2E | Complete five-role mission and adversarial loops | `pnpm.cmd run test:e2e:fake` |
| Real E2E | Existing paired sessions and visible tabs | `pnpm.cmd run test:e2e:real` |
| Security | Action authorization, path traversal, command injection, secret leakage | Focused security cases plus `verify` |
| Recovery | Crash points, leases, duplicate events, disconnect and restart | Integration/fake E2E |
| Coverage | Behavioural risk coverage with configured thresholds | `pnpm.cmd run test:coverage` |
| Static/build | ESLint, TypeScript and ESM packaging | `pnpm.cmd run lint`, `typecheck`, `build` |

Performance and accessibility testing are not separate lanes: ORCA has no user interface, and workload is one active local mission. Timing bounds are verified as reliability tests.

## 13. Security, reliability, and observability requirements

- Authentication applies to every controller route.
- Only paired Session 1 assistant output can provide workflow actions.
- Role prompts reduce capability but are not treated as an OS boundary.
- Workspace fingerprints enforce read-only roles and protected paths.
- Test commands originate only from committed configuration.
- Credentials and raw messages never enter logs or status.
- Every retry is bounded and durably counted.
- Liveness means the controller process responds.
- Readiness requires OpenCode health, current roster/profiles and operational event/poll processing.
- Status exposes only IDs, states, counts and redacted failure reasons.
- Recovery never duplicates dispatch or consumes the same result/action twice.

## 14. Deployment, migration, and rollback plan

### Deployment

1. Stop the controller.
2. Copy `.orca/orca.db` to `.orca/backups/orca-before-completion.db`.
3. Deploy reviewed commits.
4. Run migrations transactionally at startup.
5. Run `doctor`, pairing status and controller readiness.
6. Run fake verification.
7. Run the opt-in real documentation mission.
8. Mark operational only after observed completion.

### Rollback triggers

- Migration failure.
- Duplicate live dispatch.
- Model drift or mutation.
- Authorization bypass.
- Read-only-role workspace change.
- Stale approval accepted.
- Completion without current review/test evidence.

### Rollback

1. Stop the controller.
2. Preserve the failed database and logs for diagnosis.
3. Restore the last reviewed commit.
4. If the prior binary cannot read the additive schema safely, restore the database backup.
5. Restart and run doctor/status.
6. Prefer a forward fix after any new mission used the new schema.

No automatic Git reset, branch deletion or destructive down-migration is permitted.

## 15. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Workflow stops after Planner | Critical | TASK-003–004 |
| Repair lost/duplicated after crash | Critical | TASK-002 |
| Session 1 action spoofing | Critical | TASK-003 |
| Weak workspace fingerprint | Critical | TASK-005 |
| Arbitrary command execution | Critical | TASK-006 |
| Roster deletion or mission orphaning | High | TASK-001 |
| Split persistence writes | High | TASK-002/004 |
| Stale review/test approval | High | TASK-005 |
| Fixed test-port collisions | Medium | TASK-001 |
| GitNexus lint failure | Medium | TASK-001 |
| Stale documentation | High | TASK-008 |
| Real server unavailable | Release blocker only | TASK-009 precondition |

## 16. Final self-review results

- Every FR and NFR maps to an implementation task and verification method.
- Every task maps to requirements.
- Interfaces use consistent names and types.
- Migrations are additive and ordered.
- Dependencies are acyclic.
- Concurrent editing is prohibited by repository policy.
- Authorization, command safety, path containment and redaction are explicit.
- Correction, timeout, retry and completion behaviour is bounded.
- Existing pairing, adapter and Planner functionality is preserved.
- Fake and real acceptance are clearly separated.
- No speculative multi-user, daemon or dynamic-worker features are included.
- All completion claims require fresh zero-exit command evidence.
- Implementation and review agents are independent.

## 17. Remaining blockers

No decision blocks implementation.

Real five-session acceptance remains operationally blocked until the OpenCode server is reachable and the five paired sessions are available. This does not block TASK-000 through TASK-008.

PLAN READY