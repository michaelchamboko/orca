# ORCA Complete Five-Role Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Complete controller-enforced Planner → Builder → Reviewer → Tester → explicit Orchestrator completion, including safe recovery and controller-approved checks.

**Architecture:** Persist every state transition and dispatch intent atomically in SQLite. Only correlated assistant responses in paired Session 1 may approve gates. All worker prompts use the paired model and fixed role roster.

**Tech Stack:** TypeScript, SQLite/better-sqlite3, Zod, Vitest, OpenCode Server adapter.

## Global Constraints

- Work only in this linked worktree; preserve the original dirty checkout.
- Exactly five paired sessions; do not change or hardcode models.
- Workers do not communicate directly; only Builder writes files.
- Tester receives controller-generated evidence and no shell capability.
- At most two Builder corrections per review or test gate.
- Fake five-session E2E is this plan's acceptance boundary; do not claim real OpenCode E2E.
- Each task requires focused tests, a scoped commit, and independent specification and code-quality review.

---

### Task 1: Harden Worker Completion and Repair Recovery

**Files:** `src/controller/worker-completion.ts`, `src/controller/event-runtime.ts`, `src/controller/workflow-persistence.ts`, `src/persistence/sqlite.ts`, `src/integrations/opencode/fake.ts`, `tests/unit/worker-completion.test.ts`, `tests/integration/worker-completion-recovery.test.ts`.

**Required interface:** add durable outbox fields `taskId?`, `purpose`, `parentPromptMessageId?`, and `promptPayload`; use purposes `worker_task`, `contract_repair`, `orchestrator_decision`, `final_completion`, and `status_notice`. Add a `task_prompt_attempts` table keyed by prompt ID.

- [ ] Write failing tests for duplicate invalid output, repair-result parent correlation, and restart before repair dispatch acknowledgement.
- [ ] Add non-destructive migration v4 for prompt attempts and outbox metadata.
- [ ] Persist a deterministic repair prompt in the outbox transaction; never use fire-and-forget delivery or reuse the original prompt ID.
- [ ] Accept output only when it correlates to the active prompt attempt, is valid for role/mission/task, idle, tool-free for its lineage, and unchanged for 1.5 seconds.
- [ ] Block only after a new invalid repair response; atomically persist output, result, task state, and redacted ledger event.
- [ ] Block matching tasks on permission, session deletion/error, provider error, timeout, bounded polling failure, roster drift, or stagnation; never continue processing after blocking.
- [ ] Calculate timeout from dispatch acknowledgement where available.
- [ ] Run `pnpm.cmd exec vitest run tests/unit/worker-completion.test.ts tests/integration/worker-completion-recovery.test.ts`, `pnpm.cmd run typecheck`, and `pnpm.cmd run lint`; commit `fix: harden ORCA worker completion recovery`.

### Task 2: Add Correlated Session 1 Action Handling

**Files:** `src/domain/action-schemas.ts`, `src/controller/orchestrator-actions.ts`, `src/domain/types.ts`, `src/controller/event-runtime.ts`, `src/controller/workflow-persistence.ts`, `src/persistence/sqlite.ts`, `tests/unit/orchestrator-actions.test.ts`, `tests/integration/orchestrator-actions.test.ts`.

**Contract:**

```ts
interface OrchestratorAction {
  schemaVersion: "1.0";
  missionId: string;
  action: "approve" | "reject" | "request_completion";
  taskId?: string;
  rationale: string;
  correctionInstructions: string[];
}
```

- [ ] Validate exact schema, task-ID rules, active mission/gate identity, and `request_completion` omission of `taskId`.
- [ ] Add an idempotent `orchestrator_action_messages` table keyed by Session 1 assistant message ID.
- [ ] Observe only stable, idle, tool-free Session 1 assistant output whose parent is a durable controller decision prompt.
- [ ] Ignore user JSON, worker output, stale/duplicate actions, and wrong-parent assistant messages. Permit one action repair, then block the decision gate.
- [ ] Send action/decision prompts through the durable outbox using paired Session 1 model and `orca-orchestrator`.
- [ ] Cover malformed schema, unauthorized callers, stale/duplicate actions, and premature completion. Run focused tests plus typecheck/lint; commit `feat: validate orchestrator workflow actions`.

### Task 3: Generalize Durable Dispatch and Mission Transitions

**Files:** rename `src/controller/planner-dispatch.ts` to `src/controller/dispatch-outbox.ts`; add `src/controller/mission-service.ts`; modify controller composition, persistence, and policy; add `tests/integration/mission-transitions.test.ts`.

**Atomic transition interface:**

```ts
interface TransitionMissionInput {
  missionId: string;
  expectedState: MissionState;
  nextState: MissionState;
  currentTaskId?: string;
  currentTaskState?: TaskState;
  approval?: ApprovalInput;
  nextTask?: TaskExecutionInput;
  dispatch?: DispatchInput;
  snapshot?: WorkspaceSnapshotInput;
  invalidateGateApprovals?: boolean;
}
```

- [ ] Make a transaction compare current mission state and persist the transition, task state, approval, snapshot, outbox entry, and ledger event together.
- [ ] Generalize dispatch to all roles, validate roster/session/model at delivery, build role-specific payloads, and retain marker-based no-resend recovery.
- [ ] Reconcile completed-but-unconsumed tasks after restart exactly once.
- [ ] Implement Planner ready → plan approval; approved plan → Builder; Builder implemented → Builder approval; approved Builder → Reviewer; Reviewer pass → Review approval; approved Review → controlled-check preparation; Tester pass → Test approval; approved Test → final approval; explicit final action → completed.
- [ ] Rejected Planner/Builder moves to `needs_user_input`; worker blocked/failed blocks mission. Cover transaction rollback and restart/no-duplicate dispatch. Run focused integration, unit, typecheck, lint; commit `feat: persist complete ORCA workflow transitions`.

### Task 4: Enforce Workspace Evidence and Correction Gates

**Files:** replace `src/controller/workspace-baseline.ts` with `src/controller/workspace-fingerprint.ts`; add `src/controller/quality-gates.ts`; update schemas/persistence; add workspace and quality-gate tests.

- [ ] Hash Git HEAD, staged/unstaged binary diff, and sorted untracked content; exclude `.git`, `.orca`, `node_modules`, `dist`, and coverage; hash `.opencode` and `orca.config.json` separately as control-plane inputs.
- [ ] Require Planner/Reviewer/Tester fingerprints to match their dispatch fingerprint; block read-only workspace changes.
- [ ] Require Builder changed-file, command, and targeted-test evidence to match actual repository delta; reject repository escapes and changes to `.orca/**`, `.opencode/**`, or `orca.config.json`.
- [ ] Persist approvals with `gate`, fingerprint, and supersession data. New Builder work supersedes review/test approvals.
- [ ] Route reviewer changes-required and tester failure only to Builder, carrying findings/evidence. Third correction blocks mission and informs Session 1.
- [ ] Cover staged/unstaged/untracked content, path escapes, stale gates, read-only mutation, evidence mismatch, and bounded correction loops. Run focused tests plus unit/typecheck/lint; commit `feat: enforce ORCA workspace quality gates`.

### Task 5: Add Controller-Approved Test Execution

**Files:** create `orca.config.json`, `src/config/orca-config.ts`, `src/controller/test-runner.ts`; update mission service/persistence; add config and runner tests.

**Committed config:** fixed named checks for `typecheck`, `lint`, and `unit`, each with executable `pnpm`, argument arrays, and bounded timeouts.

- [ ] Validate strict config schema, unique check names, safe executable/argument values, and timeout bounds; load/hash config at mission creation and block if Builder changes it.
- [ ] Resolve `pnpm` to `pnpm.cmd` on Windows; execute only configured arrays with `shell: false`, repository cwd, timeout, bounded environment, and 64 KiB per stream.
- [ ] Run every required check automatically after Review approval and persist bounded evidence before Tester dispatch.
- [ ] Give Tester evidence/fingerprint only; require its reported passed/failed checks and fingerprint to exactly match controller evidence.
- [ ] Cover injection, unknown checks, timeout, output truncation, config drift, and contradictory tester verdicts. Run focused tests plus typecheck/lint; commit `feat: run controller-approved ORCA checks`.

### Task 6: Enforce Final Completion and Fake Five-Session Acceptance

**Files:** add `tests/e2e/fake-complete-mission.test.ts`; update mission service, event runtime, API, `docs/architecture.md`, and `docs/test-evidence.md`.

- [ ] Add controller completion predicate requiring current roster/repository/fingerprint, current review/test approvals, no running tasks/pending dispatches/permissions, and correlated explicit Session 1 completion action.
- [ ] Build a five-session heterogeneous-model fake harness. Prove visible dispatch order: Session 1 mission → Planner → Session 1 approval → Builder → Session 1 approval → Reviewer → Session 1 approval → controller checks → Tester → Session 1 approval → explicit completion.
- [ ] Cover happy path, plan/builder rejection, review/test correction loops, third correction block, stale approval, missing evidence, unauthorized action, duplicate events, crash/restart around acknowledgement, permission/roster/repository drift, premature completion, and model preservation.
- [ ] Expose redacted active mission/task/dispatch/failure status. Update docs to distinguish fake acceptance from pending real OpenCode validation.
- [ ] Run `pnpm.cmd run verify`; commit `feat: enforce complete ORCA mission gates`; perform final spec and quality review.

## Definition of Done

- A fake mission traverses Sessions 2–5 sequentially from one Session 1 objective.
- Every prompt uses the exact paired model; no worker directly contacts another worker.
- Only Builder writes files; Tester commands are controller-owned.
- State, outbox, approvals, corrections, and completion are durable, bounded, and idempotent.
- `pnpm.cmd run verify` exits 0.
- Real five-session OpenCode validation remains a separate release-boundary task.
