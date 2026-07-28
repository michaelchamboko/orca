# ORCA-FINAL-LIVE-READINESS-CORRECTION-2026-07-28

- `protocol_version`: `3.4`
- `plan_version`: `3.0`
- `document_state`: `PLAN READY`
- `base_commit`: `d9fdfee`
- `current_head`: `d9fdfee`
- `current_environment_fingerprint`: `Windows; Node v24.18.0; pnpm 9.15.0; isolated worktree .worktrees/live-readiness-remediation`
- `last_verified_commit`: `d9fdfee` (focused lanes only; fresh `verify:95` failed)
- `best_verified_commit`: `bc13cf7` (last recorded full fake-readiness gate; superseded by later code)
- `current_task`: `FRC-001`
- `current_acceptance_id`: `FRC-AC-01`
- `loop_iteration`: `0`
- `total_mandatory_tasks`: `5`
- `verified_mandatory_tasks`: `0`
- `remaining_mandatory_tasks`: `5`
- `total_mandatory_acceptance_criteria`: `9`
- `verified_mandatory_acceptance_criteria`: `0`
- `remaining_mandatory_acceptance_criteria`: `9`
- `no_progress_count`: `0`
- `strategy_fingerprint`: `deterministic-final-action+exact-live-mission+non-vacuous-evidence+prerequisite-coverage+hygiene`
- `completion_gate_status`: `NOT STARTED`
- `active_impediment`: `IMP-FRC-001: current HEAD is not repeatably fake-release green`
- `recovery_tier`: `1`
- `recovery_iteration`: `0`
- `resume_state`: `IMPLEMENTATION ACTIVE`
- `last_progress_at`: `2026-07-28`
- `updated_at`: `2026-07-28`
- `next_action`: `Implement FRC-001 test-first and prove the complete fake mission five consecutive times`

This section is the sole current authority. The older sections below are retained as append-only implementation history and must not override this metadata, task order, or acceptance inventory.

## Executive Summary

ORCA is not yet ready for a credible live five-session acceptance claim. The controller foundation and fake five-role workflow are substantially implemented, but fresh verification exposed one timing-dependent fake completion failure and four defects in the real acceptance harness or its evidence. The simplest correct route is five bounded correction tasks; no new architecture, database migration, model logic, or OpenCode feature is required.

## Source Intake and Current Evidence

| ID | Source | Classification | Current evidence |
|---|---|---|---|
| `FRC-SRC-01` | Repository source at `d9fdfee` | Observed | Current implementation and tests in the isolated worktree |
| `FRC-SRC-02` | Fresh `verify:95` run at `d9fdfee` | Observed | Unit 182, integration 52, contract 30, standalone fake E2E 18 passed; coverage rerun failed the happy-path final transition |
| `FRC-SRC-03` | `REPOSITORY-PLANNING-PROTOCOL-v3-SINGLE-DOCUMENT.md` v3.4 | Confirmed instruction | One authoritative `planning.md`, evidence-gated completion, bounded recovery, distinct review |
| `FRC-SRC-04` | `AGENTS.md` and `karpathy-guidelines` | Confirmed instruction | Surgical changes, GitNexus impact before shared-code edits, fresh verification before completion |

Material findings:

- `FRC-EV-01`: `tests/e2e/fake-complete-mission.test.ts:323-329` waits a fixed two seconds after a Session 1 action. Under coverage, the mission remained `awaiting_final_approval` instead of becoming `completed`.
- `FRC-EV-02`: `tests/e2e-real/real.test.ts:227-255` searches all historical missions and may accept an old terminal mission instead of the objective just submitted.
- `FRC-EV-03`: `tests/e2e-real/real.test.ts:111-119` filters acknowledged records returned by `getPendingDispatches()`, while `src/persistence/sqlite.ts:969-971` returns only unacknowledged records. The model-preservation loop therefore checks zero dispatches.
- `FRC-EV-04`: the live test verifies the sentinel and role presence, but not the exact Git delta or Reviewer/Tester fingerprint continuity needed to prove that only Builder changed project files.
- `FRC-EV-05`: six prerequisite tests exist, but missing database, stale/wrong/incomplete roster, missing model, active mission, and OpenCode health/authentication failures are not directly exercised.
- `FRC-EV-06`: `git diff --check bc13cf7..HEAD` reports committed trailing whitespace in `src/controller/mission-ingress.ts`.
- `FRC-EV-07`: `docs/test-evidence.md:58-65` retains superseded LIVE-003 paths and release-order claims.

## Requirements and Acceptance Criteria

- `FRC-REQ-01`: Session 1 actions must be consumed deterministically; tests may not use fixed sleeps as proof of state transition.
- `FRC-REQ-02`: live acceptance must correlate exclusively to the mission derived from the newly submitted Session 1 message.
- `FRC-REQ-03`: every dispatch for that mission must be loaded and checked against the paired role, session, and model.
- `FRC-REQ-04`: live acceptance must prove the exact allowed workspace change and unchanged Reviewer/Tester fingerprints.
- `FRC-REQ-05`: every live prerequisite must have a direct, network-independent failure test where practical.
- `FRC-REQ-06`: current evidence, documentation, and Git hygiene must agree at the same commit.

Mandatory acceptance inventory:

- `FRC-AC-01`: the full fake happy path reaches `completed` five consecutive times, including under the coverage lane.
- `FRC-AC-02`: a delayed but valid final action succeeds within a bounded wait; a genuinely unconsumed action fails with mission state and event diagnostics.
- `FRC-AC-03`: a database containing an older completed mission cannot satisfy a new live run.
- `FRC-AC-04`: the live test asserts a non-empty expected dispatch sequence and validates every target session and paired model.
- `FRC-AC-05`: the live test fails on any changed project path other than `docs/orca-live-acceptance-sentinel.md`.
- `FRC-AC-06`: Builder evidence names the sentinel and the Reviewer/Tester fingerprints match the current post-Builder workspace.
- `FRC-AC-07`: all prerequisite failure branches listed in FRC-004 are directly tested.
- `FRC-AC-08`: `git diff --check` and two consecutive `verify:95` runs exit `0` at the same clean HEAD.
- `FRC-AC-09`: live success is recorded only after `verify:release` observes one real, newly correlated five-session mission; otherwise status remains `EXTERNAL ACTION REQUIRED`.

Non-goals:

- No OpenCode source or desktop automation changes.
- No session creation, model selection, or model mutation.
- No new persistence migration or public controller API unless a focused failing test proves it indispensable.
- No automatic sentinel deletion, Git reset, commit, push, or cleanup.
- No unrelated refactoring or formatting.

## Frozen Interfaces and Simplest Selected Solution

- Derive the exact live mission ID with the existing exported `stableId("mission", roster.rosterId, userMessageId)` from `src/controller/mission-ingress.ts`.
- Wait only for that mission ID to appear and reach a terminal state; never enumerate historical tasks to choose a mission.
- Read that mission's `task.dispatched` events, require the expected role/gate sequence, resolve every `dispatchKey` through existing `getDispatchByKey()`, and compare target session and captured model with the persisted roster.
- Replace fixed sleeps in fake E2E helpers with the existing bounded polling pattern and explicit expected-state predicates. If the state still stalls, fix the smallest production reconciliation defect revealed by the failing test.
- Use Git status/diff and existing workspace-fingerprint contracts for live evidence; do not add a second fingerprint system.

## Traceability and Dependency Order

| Task | Requirements | Acceptance | Depends on |
|---|---|---|---|
| `FRC-001` | `FRC-REQ-01` | `FRC-AC-01`, `FRC-AC-02` | none |
| `FRC-002` | `FRC-REQ-02`, `FRC-REQ-03` | `FRC-AC-03`, `FRC-AC-04` | `FRC-001` |
| `FRC-003` | `FRC-REQ-04` | `FRC-AC-05`, `FRC-AC-06` | `FRC-002` |
| `FRC-004` | `FRC-REQ-05` | `FRC-AC-07` | `FRC-002` |
| `FRC-005` | `FRC-REQ-06` | `FRC-AC-08`, `FRC-AC-09` | `FRC-001` through `FRC-004` |

Tasks are sequential because `FRC-002` through `FRC-004` overlap `tests/e2e-real/real.test.ts`. Do not dispatch concurrent editors to that file.

## Task Packets

### FRC-001 — Make Session 1 final-action advancement deterministic

- Allowed files: `tests/e2e/fake-complete-mission.test.ts`; production action/runtime files only if the new regression proves a real reconciliation defect.
- Before a production edit: run GitNexus upstream impact on the exact symbol and warn on HIGH/CRITICAL risk.
- Add a failing test that reproduces the `awaiting_final_approval` stall without relying on wall-clock luck.
- Replace `sleep(2_000)` with a bounded `eventually` wait for the action's expected mission state or next dispatch. Include the exact mission state, relevant action responses, and latest redacted mission events on timeout.
- Exercise duplicate SSE plus polling observation and a delayed final action.
- If waiting exposes a real controller defect, correct only the action reconciliation/idempotency path and retain the failing test.
- Verify:

```powershell
pnpm.cmd exec vitest run tests/e2e/fake-complete-mission.test.ts
1..5 | ForEach-Object { pnpm.cmd exec vitest run tests/e2e/fake-complete-mission.test.ts; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
pnpm.cmd run test:coverage
pnpm.cmd run typecheck
pnpm.cmd run lint
```

- Commit: `fix: make ORCA final action reconciliation deterministic`
- Independent verifier: inspect that no timeout was merely increased and run the five-pass loop independently.

### FRC-002 — Correlate live acceptance to one new mission and all of its dispatches

- Allowed files: `tests/e2e-real/real.test.ts`; a small test-only helper beside it only if needed.
- Compute `missionId` before sending the objective with the existing ingress `stableId`.
- Replace `currentMissionId()` and global terminal scanning with `waitForMission(missionId)` and `waitForTerminalMissionState(missionId)`.
- Add a regression fixture containing an older completed mission and prove it cannot satisfy the new run.
- Obtain dispatch keys only from the exact mission's `task.dispatched` events. Require the complete expected worker/decision sequence and fail if no dispatch is found.
- Load every event's dispatch via `getDispatchByKey()` and assert role, fixed paired session, agent role, and exact provider/model. Reject any worker-to-worker target.
- Verify:

```powershell
pnpm.cmd exec vitest run tests/e2e-real
pnpm.cmd run test:contract
pnpm.cmd run typecheck
pnpm.cmd run lint
```

- Commit: `fix: correlate ORCA live acceptance to the submitted mission`
- Independent verifier: seed misleading history and confirm the test still waits for the new deterministic mission ID.

### FRC-003 — Make live workspace and role-isolation evidence non-vacuous

- Allowed files: `tests/e2e-real/real.test.ts` and existing test helpers only.
- Capture the baseline Git status/diff before submission, excluding controller state under `.orca`.
- After completion, require the project delta to contain exactly `docs/orca-live-acceptance-sentinel.md`; fail on modified, staged, deleted, renamed, or untracked paths outside that allowlist.
- Require the sentinel body to contain the run ID and the final Builder result to list the repository-relative sentinel path.
- Capture the expected post-Builder workspace fingerprint and require current Reviewer `reviewedWorkspaceFingerprint` and Tester `testedWorkspaceFingerprint` to match it.
- Add direct negative tests for unexpected changed path, missing Builder evidence, incorrect Reviewer fingerprint, and incorrect Tester fingerprint.
- Preserve evidence in place; do not clean, reset, delete, commit, or push.
- Verify:

```powershell
pnpm.cmd exec vitest run tests/e2e-real
pnpm.cmd run test:e2e:fake
pnpm.cmd run typecheck
pnpm.cmd run lint
```

- Commit: `test: enforce ORCA live workspace evidence`
- Independent verifier: inspect that every assertion fails when its evidence collection is empty.

### FRC-004 — Complete live prerequisite failure coverage

- Allowed files: `tests/e2e-real/real.test.ts`; optionally `tests/e2e-real/live-prerequisites.ts` if extraction materially reduces setup duplication.
- Keep prerequisite evaluation testable without a real server by injecting the health result and using temporary SQLite databases/rosters.
- Add direct tests for:
  - missing `.orca/orca.db`;
  - absent or stale roster;
  - roster bound to another repository;
  - fewer or more than five bindings;
  - empty provider or model ID;
  - an active mission;
  - OpenCode unreachable/authentication failure;
  - existing sentinel;
  - reserved objective marker;
  - non-worktree path and `main`/`master`.
- Each failure must occur before controller startup or mission submission and provide one actionable redacted error.
- Do not add network mocks to production code or weaken `RosterService.assertCurrent()`.
- Verify:

```powershell
pnpm.cmd exec vitest run tests/e2e-real
node scripts/verify-release.cjs
```

Expected: E2E-real prerequisite tests pass or the live case is skipped; the no-environment release command exits `2` before `verify:95`.

- Commit: `test: cover ORCA live prerequisite failures`
- Independent verifier: map each prerequisite branch to one observed failing test and confirm secrets are absent from errors.

### FRC-005 — Reconcile hygiene, evidence, and the release boundary

- Allowed files: `src/controller/mission-ingress.ts`, `docs/test-evidence.md`, `docs/architecture.md`, `docs/operations.md`, `planning.md`.
- Normalize only the committed trailing whitespace/line endings in `src/controller/mission-ingress.ts`; do not reformat adjacent code.
- Remove or mark superseded the stale LIVE-003 rows that reference `.orca/live-acceptance-sentinel.md` or the old release ordering.
- Record only fresh current-HEAD commands, counts, exit codes, and the fact that the real five-session run is still unexecuted until it actually passes.
- Run GitNexus `detect_changes()` against `main` and inspect the complete diff before committing.
- Run:

```powershell
git diff --check
pnpm.cmd run verify:95
pnpm.cmd run verify:95
node scripts/verify-release.cjs
git status --short --branch
```

Expected: both `verify:95` runs exit `0`; `verify-release.cjs` without live variables exits `2` before starting fake verification; the worktree is clean after the scoped commit.

- Commit: `docs: finalize ORCA live-readiness evidence`
- Independent verifier: review the complete branch diff for model mutation, direct worker routing, prompt-only policy, unsafe shell execution, vacuous assertions, stale evidence, and unrelated changes.

## Evidence-Gated Execution Loop

1. Select the first unmet acceptance ID and its dependency-ready task.
2. Run GitNexus impact analysis before changing any shared symbol.
3. Add one discriminating failing test; record the failure.
4. Implement the smallest correction; run the focused test.
5. Run the task's surrounding lanes and inspect the diff.
6. Have a distinct reviewer attempt to disprove the acceptance claim.
7. Correct every Critical or Important finding, rerun affected checks, and re-review.
8. Run GitNexus `detect_changes()` before the scoped commit.
9. Append commit, commands, results, and review evidence to this file; update only the top metadata for current state.
10. If two materially different attempts make no progress, record an impediment, change strategy, and escalate the recovery tier. Never repeat the same failed action.
11. Continue until both mandatory denominators are zero and every current-HEAD final gate passes.

## Release and Rollback

- Fake readiness: two consecutive `verify:95` passes at the same clean HEAD.
- Live readiness: five manually opened and paired sessions in this isolated worktree, with user-selected models unchanged.
- Live command:

```powershell
$env:ORCA_REAL_E2E = "1"
$env:ORCA_LIVE_WORKTREE = (Resolve-Path .).Path
pnpm.cmd run verify:release
```

- If the server or five paired sessions are unavailable, set `document_state` to `EXTERNAL ACTION REQUIRED`, preserve `resume_state` at `FRC-AC-09`, and do not claim live success.
- Rollback is commit-by-commit revert in reverse task order. No database rollback is planned because this correction adds no migration.

## Final Completion Predicate

Completion requires all of:

- `FRC-AC-01` through `FRC-AC-09` independently verified at the same current HEAD and environment;
- zero remaining mandatory tasks and acceptance criteria;
- clean `git diff --check` and worktree;
- no Critical or Important independent-review finding;
- two consecutive fake release-gate passes;
- one newly correlated real five-session mission when claiming live readiness.

Status: `PLAN READY`

---

# ORCA-LIVE-READINESS-REMEDIATION-2026-07-28

> **Authoritative plan.** This file replaces the prior 95%-readiness plan with a targeted remediation plan for live-validation readiness. The plan must be executed from the isolated worktree at `.worktrees/live-readiness-remediation`.

---

# ORCA-LIVE-ACCEPTANCE-CORRECTION-2026-07-28

> **Targeted correction plan.** This amendment addresses the remaining live-validation defects identified after `bc13cf7` shipped the previous remediation plan. Preserve the passing fake workflow, make real agents receive useful mission context, and ensure the live test uses the manually paired roster and proves a Builder-created sentinel change.

## Acceptance IDs (correction)

- CAC-1 Every worker prompt payload carries the same mission id and original objective as the durable mission.
- CAC-2 Builder prompts include the approved Planner plan (steps, expected files, validation plan, acceptance criteria).
- CAC-3 Reviewer prompts include the Builder result/evidence and the current workspace fingerprint.
- CAC-4 Tester prompts include the controller-generated check evidence (required/passed/failed checks) and the tested workspace fingerprint.
- CAC-5 Builder correction tasks include the rejected review/test findings and the Orchestrator's correction instructions.
- CAC-6 The complete prompt payload is persisted transactionally with its task and dispatch intent.
- CAC-7 Missing required upstream context blocks dispatch instead of sending an empty task.
- CAC-8 The live test opens `.orca/orca.db`, never creates or uses a root-level `state.sqlite`, and refuses to pair sessions or change models.
- CAC-9 The live test fails fast on missing or stale roster, wrong repository binding, fewer/more than five bindings, missing model, existing active mission, existing sentinel, or OpenCode auth failure.
- CAC-10 The Builder (not the test harness) creates `docs/orca-live-acceptance-sentinel.md` containing the unique run id.
- CAC-11 Only the Builder changed project files; Reviewer and Tester fingerprints confirm no later mutation.
- CAC-12 The durable mission traversed Planner → Builder → Reviewer → Tester → final approval → explicit completion, and every dispatch used a paired model.
- CAC-13 `verify-release.cjs` validates `ORCA_REAL_E2E` and `ORCA_LIVE_WORKTREE` before running `verify:95` and refuses `main`/`master`.
- CAC-14 Documentation uses `.orca/orca.db`, 18 fake E2E tests, and the Builder-created sentinel; `docs/test-evidence.md` records fresh commit hashes.

## Execution Ledger

- [x] CORR-1 `fix: propagate mission context through ORCA workflow` — commit `318dae0`
- [x] CORR-2 `fix: make live acceptance use paired ORCA state` — commits `CORR-2a` (tests/e2e-real/real.test.ts), `CORR-2b` (scripts/verify-release.cjs)
- [x] CORR-3 `docs: align ORCA live release evidence` — commit `CORR-3` (docs/test-evidence.md, docs/threat-model.md, docs/architecture.md, docs/operations.md)

## Implementation Changes

### CORR-1 — Propagate real mission context

- Replace generic follow-on task content such as `"controller-dispatched task"` with persisted mission context.
- Builder receives the original objective, approved Planner result, expected files, validation plan, and acceptance criteria.
- Reviewer receives the objective, Builder result/evidence, and current workspace fingerprint.
- Tester receives controller check evidence and the tested workspace fingerprint.
- Builder correction tasks receive the rejected review/test findings and Orchestrator correction instructions.
- Persist each complete prompt payload transactionally with its task and dispatch intent.

Tests must prove:

- Every role receives the same real mission ID and objective.
- Builder receives the approved plan.
- Reviewer receives Builder evidence.
- Tester receives controller-generated check evidence.
- Correction tasks include the rejected findings.
- Missing required upstream context blocks dispatch instead of sending an empty task.

Commit: `fix: propagate mission context through ORCA workflow`

### CORR-2 — Correct the live acceptance harness

Modify `tests/e2e-real/real.test.ts`:

- Send a plain Session 1 user objective without `[ORCA_CORRELATION:]` or `[ORCA_DISPATCH:]`.
- Open the authoritative `.orca/orca.db`; never create or use root-level `state.sqlite`.
- Require an existing manually paired roster. Never call `RosterService.pair()` from the test.
- Fail before starting the controller if the roster is absent, stale, not exactly five sessions, points at another repository, or any paired model is missing.
- Fail if another mission is active.
- Remove `applySentinelChange()` and all direct test writes to the sentinel.
- Instruct the mission to create `docs/orca-live-acceptance-sentinel.md` containing a unique run ID.
- Fail before execution if the sentinel already exists; do not delete it automatically.
- After completion, verify:
  - Builder evidence names the sentinel.
  - The file contains the expected run ID.
  - Only the Builder changed project files.
  - Reviewer and Tester fingerprints confirm no later mutation.
  - The durable mission traversed Planner, Builder, Reviewer, Tester, final approval, and explicit completion.
  - All dispatches used the paired models.

Error tests must cover:

- Reserved marker in objective is rejected by the test helper.
- Missing `.orca/orca.db`.
- Empty or stale roster.
- Wrong repository binding.
- Fewer or more than five bindings.
- Missing model.
- Existing active mission.
- Existing sentinel.
- OpenCode authentication failure.
- Controller timeout or blocked mission.
- Missing Builder evidence.
- Unexpected changed path.
- Premature completion.

Commit: `fix: make live acceptance use paired ORCA state`

### CORR-3 — Correct release gating and documentation

- Move `ORCA_REAL_E2E` and `ORCA_LIVE_WORKTREE` validation before `verify:95` in `scripts/verify-release.cjs` so missing prerequisites genuinely fail fast with exit `2`.
- Verify the supplied worktree equals the current Git worktree and is not `main` or `master`.
- Keep all release commands fixed; no model output may influence executable names or arguments.
- Correct documentation to use `.orca/orca.db`, 18 fake E2E tests, and the Builder-created `docs/orca-live-acceptance-sentinel.md`.
- Update `docs/threat-model.md` to state that the real harness is implemented but remains unexecuted.
- Record fresh commit hashes and command outputs in `docs/test-evidence.md`; remove `<this commit>` placeholders.

Error tests must prove:

- Missing live flag exits `2` before lint/build/tests run.
- Missing or incorrect worktree exits `2`.
- Main/master worktree is rejected.
- Failed `verify:95` prevents live execution.
- Failed real E2E prevents a release-success message.
- No-environment real test remains skipped without claiming live success.

Commit: `docs: align ORCA live release evidence`

## Verification

Before each code edit, run GitNexus impact analysis on affected shared symbols. Before each commit, run `detect_changes()` and inspect `git diff`.

Run:

```powershell
pnpm.cmd run lint
pnpm.cmd run typecheck
pnpm.cmd run build
pnpm.cmd run test:unit
pnpm.cmd run test:integration
pnpm.cmd run test:contract
pnpm.cmd run test:e2e:fake
pnpm.cmd run test:coverage
pnpm.cmd run verify:95
node scripts/verify-release.cjs
git diff --check
git status --short --branch
```

Expected non-live result:

- All fake-readiness commands exit `0`.
- `node scripts/verify-release.cjs` without live variables exits `2` before running `verify:95`.
- Working tree is clean after scoped commits.

Live verification is performed only after five sessions are manually opened and paired in the isolated worktree:

```powershell
$env:ORCA_REAL_E2E = "1"
$env:ORCA_LIVE_WORKTREE = (Resolve-Path .).Path
pnpm.cmd run verify:release
```

## Completion Criteria

- The live objective is accepted by `MissionIngress`.
- The test uses the same `.orca/orca.db` written by `swarmctl pair`.
- The live test never pairs sessions or changes models.
- Builder—not the test harness—creates the sentinel.
- Every worker receives sufficient persisted mission context.
- All negative prerequisite and failure-path tests pass.
- `verify:95` remains green.
- Live success is claimed only after an observed five-session mission completes with current review/test gates and explicit Session 1 completion.

---

## Starting state (recorded before any edits)

- Repository root: `C:\Users\micha\Desktop\Antigravity Applications Created\opencodeOrka`
- Active checkout branch: `codex/fix-node24-sqlite`
- Active checkout commit: `03b0290498b775f61c32e51280db8a1c0004ba13`
- Active checkout status: clean (no uncommitted files except `.opencode/goals/`)
- Implementation worktree: `.worktrees/live-readiness-remediation` on branch `codex/live-readiness-remediation`
- Implementation worktree commit: `bc13cf7 docs+test: gate live acceptance, refresh architecture and runbook`
- Implementation worktree status: clean
- Baseline tests: `pnpm.cmd run typecheck` exits 0; `pnpm.cmd run test:unit` reports 171/171 passing
- Source register: every changed file will be listed in the commit message

## Acceptance IDs

- AC-1 Session 1 approval produces exactly one Builder dispatch
- AC-2 Polling + SSE duplicate observation consume the action once
- AC-3 No task envelope, dispatch key, prompt ID, approval, snapshot, or persistence record uses `"bootstrap"` or a synthetic mission ID
- AC-4 Fake E2E drives Planner → Builder → Reviewer → Tester → Final → explicit completion
- AC-5 Real E2E is a gated live acceptance test, not a deliberately failing placeholder
- AC-6 Live validation runs only in the isolated worktree with sentinel diff preserved
- AC-7 Documentation, scripts, and CLI commands agree with the source

## Summary

Make the current ORCA controller genuinely ready for live five-session validation. This plan fixes the verified runtime blockers first, proves the complete workflow through the production controller and fake adapter, then replaces the intentionally failing real-E2E placeholder with a gated acceptance run in an isolated worktree.

The implementation agent must preserve the active checkout and use the isolated worktree `.worktrees/live-readiness-remediation` for all code changes and validation.

## Implementation Changes

### 1. Restore Session 1 action consumption

- In `src/controller/event-runtime.ts`, invoke `missionContext.orchestratorActionIntake.observeEvent(event)` for eligible message events inside the existing reconciliation mutex.
- Invoke the action intake's polling/reconciliation method during the periodic reconciliation cycle so a missed SSE event cannot stall an approval.
- Preserve current authorization and correlation rules: only a stable assistant message in paired Session 1, parented by the pending controller decision prompt, may advance a gate.
- Add regression tests proving a Planner result produces a decision prompt, a correlated Session 1 approval produces exactly one Builder dispatch, and duplicate SSE/poll observations consume the action once.

### 2. Remove the fixed `"bootstrap"` mission identity

- Change `createMissionBindings()` and its task/decision factories so each dispatched task receives the actual `missionId` at creation time.
- Remove `"bootstrap"` from `startController()` composition; no task envelope, dispatch key, prompt ID, approval, snapshot, or persistence record may use a synthetic mission ID.
- Add tests for Planner → Builder → Reviewer → Tester proving every task/result/dispatch references the same mission and that two separate missions cannot share task IDs or dispatch keys.

### 3. Make the fake acceptance test complete and meaningful

- Expand `tests/e2e/fake-complete-mission.test.ts` to drive the actual `startController()` composition through:
  `Session 1 objective → Planner → plan approval → Builder → builder approval → Reviewer → review approval → controller checks → Tester → test approval → explicit completion`.
- Add fake cases for review correction, test correction, stale approval rejection, duplicate event delivery, restart recovery, model preservation, and premature completion.
- Do not accept a test that only checks prompt creation. Each stage must assert the target session, paired model, correlated parent prompt, durable mission state, and absence of direct worker-to-worker dispatch.
- If these tests expose defects in existing quality gates, completion handling, or recovery, repair only the minimal code required and add a regression test before proceeding.

### 4. Replace the fake real-E2E placeholder

- Replace `tests/e2e-real/real.test.ts` with an opt-in live acceptance test; it must not intentionally throw merely because `ORCA_REAL_E2E=1`.
- The test must fail fast unless all prerequisites are true: reachable authenticated OpenCode server, exactly five current paired sessions for the isolated worktree, heterogeneous models preserved from pairing, no active mission, valid role profiles, and controller health.
- It must never create sessions, choose/change models, use browser/terminal automation, or communicate directly between workers.
- Use one controlled sentinel documentation change in the isolated worktree only. The test leaves its resulting diff and `.orca` evidence intact for inspection; it must not auto-commit, push, reset, or delete user files.
- Bound each role wait and the whole mission timeout. On failure, report the durable mission state, redacted failure code, current task, and missing gate—not raw prompts, credentials, or model output.
- Change `verify:release` so it fails when live validation is not explicitly enabled; `verify:95` remains the fake-only gate.

### 5. Correct evidence and operations documentation

- Replace the obsolete claims in `docs/architecture.md` with the current implementation and explicitly list any remaining live-validation limitations.
- Correct `docs/operations.md` to use `swarmctl controller start`, not `swarmctl start`.
- Reconcile `planning.md` references to `verify:live` with the actual chosen command (`verify:release`, unless a `verify:live` alias is deliberately added and tested).
- Update `README.md` and `docs/test-evidence.md` only with fresh, commit-pinned command output. Do not retain "95% ready" claims if the full fake acceptance path is not passing.

## Execution and Review Loop

For every task:

1. Record the starting commit, clean-worktree status, source register entry, and acceptance IDs in `planning.md`.
2. Run GitNexus impact analysis before editing shared runtime, persistence, or public CLI symbols.
3. Write one failing focused test that proves the defect.
4. Implement the smallest change that makes it pass.
5. Run focused tests, then lint, typecheck, build, and affected integration/E2E lanes.
6. Have a different agent review the diff for workflow bypass, model mutation, direct worker communication, idempotency, and stale approvals.
7. Run GitNexus `detect_changes()` before each scoped commit.
8. Commit one reviewed task at a time; do not commit `.opencode/goals/`, credentials, generated indexes, or unrelated artifacts.

## Required Verification

Run from the isolated implementation worktree:

```powershell
pnpm.cmd run lint
pnpm.cmd run typecheck
pnpm.cmd run build
pnpm.cmd run test:unit
pnpm.cmd run test:integration
pnpm.cmd run test:contract
pnpm.cmd run test:e2e:fake
pnpm.cmd run test:coverage
pnpm.cmd run verify:95
git diff --check
git status --short --branch
```

Live acceptance runs only after the above passes and the five sessions are manually opened in the isolated worktree:

```powershell
$env:ORCA_REAL_E2E = "1"
pnpm.cmd run verify:release
```

## Completion Criteria

- A Session 1 approval visibly dispatches the next authorized role exactly once.
- No generated task uses `"bootstrap"` or another incorrect mission ID.
- Fake E2E proves the complete five-role sequence, correction loops, restart safety, stale-gate rejection, and model preservation.
- Real E2E is a real test, not a deliberately failing placeholder.
- Live validation runs only in the isolated worktree and preserves evidence for review.
- Documentation, scripts, and CLI commands agree with the source.
- The only allowed remaining blocker is external availability of a real OpenCode server and five manually paired sessions.

## Assumptions

- Live validation will use an isolated ORCA worktree, as selected.
- The user manually opens the five sessions and chooses their models before pairing.
- ORCA remains an external controller; it does not modify OpenCode source, models, or desktop UI.

Status: PLAN READY
Plan owner: lead build agent
