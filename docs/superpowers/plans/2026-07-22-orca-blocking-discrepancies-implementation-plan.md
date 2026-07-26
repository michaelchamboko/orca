# ORCA Tasks 002–004 Blocking Discrepancies Implementation Plan

**Date:** 2026-07-22
**Status:** Approved (planning mode output, awaiting approval to implement)
**Source:** Planning session output for correction plan, approved for execution

**Goal:** Correct the incomplete Tasks 002–004 before TASK-005 begins, proving that durable worker repair, correlated Session 1 decisions, atomic mission transitions, and Planner-to-Builder runtime wiring operate through the real controller composition.

**Architecture:** Retain one external controller and one SQLite-backed dispatch outbox for every prompt purpose. Repair contracts and persistence first, then action authorization, atomic workflow transitions, production runtime wiring, and controller-started integration acceptance.

**Tech stack:** TypeScript, Node.js, SQLite through `better-sqlite3`, Zod, Vitest, OpenCode adapter contracts, pnpm, tsup.

## Global constraints

- Work only in `C:\Users\micha\Desktop\Antigravity Applications Created\orca-controller-completion`.
- Starting commit: `37be12b`.
- Preserve the original checkout and existing paired roster.
- Never create sessions, change models, or embed model IDs in role definitions.
- All worker and Session 1 prompts use the exact paired model.
- Workers never communicate directly.
- Exactly one durable outbox delivers worker, repair, decision, completion, and status prompts.
- Controller transitions require compare-and-set state validation.
- Planner and Builder rejection corrections are limited to two attempts.
- Review and test corrections remain TASK-005 scope and route only to Builder.
- `request_completion` remains rejected unless an injected completion predicate passes.
- Do not stage the line-ending-only pairing snapshot unless a real content difference is found.
- Each task requires a fresh implementer, independent reviewer, focused tests, scoped commit, and recorded evidence.

## File and component impact map

| Component | Files | Responsibility |
|---|---|---|
| Dispatch contracts and storage | `src/persistence/sqlite.ts`, `src/controller/workflow-persistence.ts` | Persist full dispatch intent, decision responses, acknowledgements, and atomic transitions |
| Prompt delivery | `src/controller/dispatch-outbox.ts`, `src/controller/planner-dispatch.ts` | General renderer, marker recovery, role/model verification; remove legacy dispatcher after migration |
| Worker recovery | `src/controller/worker-completion.ts`, `src/controller/response-stability.ts` | Active-attempt correlation, repair enqueue, timeout origin, quiet window |
| Session 1 authorization | `src/controller/orchestrator-actions.ts`, `src/domain/action-schemas.ts` | Stable action intake, exact parent correlation, repair and deduplication |
| Workflow authority | `src/controller/mission-service.ts`, `src/domain/workflow.ts` | Expected-state transitions, consumption, approval, correction, completion predicate |
| Production composition | `src/controller/main.ts`, `src/controller/event-runtime.ts`, `src/controller/mission-ingress.ts` | Construct services and serialize startup/SSE/poll reconciliation |
| Test adapter | `src/integrations/opencode/fake.ts` | Deterministic status, send failure, acknowledgement, and restart crash hooks |
| Verification | Three new integration files plus existing focused tests | Recovery, action authorization, transition atomicity, runtime acceptance |
| Evidence | `docs/test-evidence.md` | Actual commits, commands, exits, findings, reviewer decisions |

Shared files `sqlite.ts`, `main.ts`, `event-runtime.ts`, and `mission-service.ts` must not be edited concurrently.

## Requirements traceability matrix

| Requirement | Components | Tasks | Verification |
|---|---|---|---|
| FR-001–003, NFR-001 | Persistence, outbox, completion | FIX-001, FIX-002 | Worker recovery unit/integration |
| FR-004–005, FR-013 | Action intake | FIX-003 | Action unit/integration |
| FR-006, NFR-005–006 | General outbox | FIX-001 | Persistence and dispatch replay tests |
| FR-007–008, FR-011–012 | Mission service | FIX-004 | Mission transition failure-injection suite |
| FR-009–010, NFR-002 | Composition/runtime | FIX-005 | Controller-started Planner-to-Builder integration |
| FR-014, NFR-003–004 | Compatibility/evidence | All; final review | Planner regression, contract, fake E2E, build, evidence inspection |

## Dependency graph and safe parallelisation

```text
FIX-001 Durable dispatch contract
  └─ FIX-002 Worker repair recovery
       └─ FIX-003 Session 1 action safety
            └─ FIX-004 Atomic mission transitions
                 └─ FIX-005 Production wiring and acceptance
                      └─ FIX-006 Independent release review
```

Implementation is sequential because all tasks touch shared controller or persistence contracts.

## Detailed implementation plan

### FIX-001 — Complete the generalized dispatch contract

**Objective:** Make every dispatch purpose round-trip through SQLite and deliver through one role/model-safe outbox.

**Requirements:** FR-006, NFR-001, NFR-003, NFR-005–006.

**Files:** `src/persistence/sqlite.ts`, `src/controller/workflow-persistence.ts`, `src/controller/dispatch-outbox.ts`, `src/controller/mission-ingress.ts`, `tests/unit/persistence.test.ts`, new `tests/integration/dispatch-outbox.test.ts`.

**Interfaces:**

```ts
type DispatchPromptPayload =
  | { kind: "worker_task"; envelope: TaskEnvelope }
  | { kind: "contract_repair"; contract: "worker_result"; envelope: TaskEnvelope; originalPromptMessageId: string }
  | { kind: "contract_repair"; contract: "orchestrator_action"; missionId: string; gate: ApprovalGate; originalPromptMessageId: string }
  | { kind: "orchestrator_decision"; missionId: string; taskId: string; gate: ApprovalGate; result: RoleWorkerResult }
  | { kind: "final_completion"; missionId: string }
  | { kind: "status_notice"; missionId: string; code: string; message: string };

interface DispatchInput {
  missionId: string;
  taskId: string | null;
  dispatchKey: string;
  purpose: DispatchPurpose;
  targetRole: Role;
  targetSessionId: string;
  capturedModel: ModelRef;
  promptMessageId: string;
  parentPromptMessageId: string | null;
  promptPayload: DispatchPromptPayload;
}
```

Add:

```ts
acknowledgeDispatchDelivery(id: number, leaseOwner: string, timestamp?: string): DispatchOutboxAction;
getDispatchByPromptMessageId(promptMessageId: string): DispatchOutboxAction | null;
```

**Steps:**

1. Add failing persistence tests that enqueue each purpose and assert every field survives round-trip.
2. Run `pnpm.cmd exec vitest run tests/unit/persistence.test.ts`; expect failures because current inserts/mapping drop generalized fields.
3. Add migration 7 with unique index on `dispatch_outbox(prompt_message_id)`, backfill `task_id`, and create `orchestrator_decision_responses` table.
4. Replace optional generalized fields with required `DispatchInput` fields.
5. Map `task_id`, `purpose`, `parent_prompt_message_id`, and parsed `prompt_payload` in `dispatchFromRow()`.
6. Implement atomic dispatch and prompt-attempt acknowledgement.
7. Render prompts exclusively from the discriminated payload; taskless Orchestrator dispatches must not call task lookup.
8. Add failure tests for wrong role, session, model, malformed payload, three delivery failures, marker recovery, send-before-ack crash, and five heterogeneous models.
9. Run focused persistence/dispatch tests, then typecheck and lint.
10. Commit: `fix: complete durable ORCA dispatch contract`.

### FIX-002 — Make worker repair and timeout recovery correct

**Objective:** Eliminate fire-and-forget repair delivery and use durable acknowledgement as the timeout source.

**Requirements:** FR-001–003, NFR-001–002.

**Files:** `src/controller/worker-completion.ts`, `src/controller/response-stability.ts`, `src/integrations/opencode/fake.ts`, `tests/unit/worker-completion.test.ts`, new `tests/integration/worker-completion-recovery.test.ts`.

**Core behavior:**

```ts
const initialAttempt = attempts.find((attempt) => attempt.purpose === "worker_task");
const timeoutOrigin = initialAttempt?.acknowledgedAt ?? (attempts.length === 0 ? task.envelope.createdAt : null);
```

**Steps:**

1. Add failing tests proving restart-safe repair and timeout from initial acknowledgement.
2. Run focused tests; expect failures.
3. Make `recordContractViolation()` asynchronous and transactionally write task state, deterministic repair prompt ID, prompt attempt, outbox intent, checkpoint, and redacted event.
4. Remove direct `adapter.sendPrompt()` from worker completion.
5. Select output only from the active prompt attempt, never from a prior attempt's response.
6. Hydrate acknowledgement from durable prompt-attempt data.
7. Ignore the adapter's global in-flight count; inspect pending/running parts only in the active response lineage.
8. Stop processing immediately when task state becomes terminal.
9. Commit: `fix: make ORCA contract repair restart safe`.

### FIX-003 — Enforce stable, correlated Session 1 actions

**Objective:** Turn `OrchestratorActionIntake` into a durable authorization boundary.

**Requirements:** FR-004–005, FR-013, NFR-002, NFR-004.

**Files:** `src/controller/orchestrator-actions.ts`, `src/domain/action-schemas.ts`, persistence contracts from FIX-001, `tests/unit/orchestrator-actions.test.ts`, new `tests/integration/orchestrator-actions.test.ts`.

**Validation limits:**

```ts
rationale: z.string().max(8192);
correctionInstructions: z.array(z.string().max(2048)).max(20);
```

**Action eligibility:**

```ts
message.role === "assistant"
&& message.sessionId === pairedOrchestrator.sessionId
&& message.parentId === activeDecision.promptMessageId
&& session.idle
&& !activeLineageHasPendingTool
&& quietWindowElapsed
```

**Steps:**

1. Add failing integration tests for user JSON, worker-session JSON, null/wrong parent, wrong mission/task/gate, busy session, active tool, changed output, duplicate accepted/rejected response, stale action, restart, malformed JSON repair, and second-new-invalid blocking.
2. Replace unused in-memory `stableSince` map with persisted `StableResponseTracker` checkpoints keyed by decision prompt and response.
3. Resolve authorization from `getDispatchByPromptMessageId(message.parentId)`.
4. Persist the actual `decisionPromptMessageId`; never compare a message parent with a session ID.
5. Record only validated bounded action fields, hashes, outcome, and reason code—never the raw OpenCode message.
6. Enqueue one deterministic Orchestrator repair through the generalized outbox.
7. Preserve rejected outcomes on duplicate observation; do not mark them accepted.
8. Commit: `fix: authorize correlated Session 1 actions`.

### FIX-004 — Make mission transitions atomic and deterministic

**Objective:** Ensure every task result or Session 1 decision advances the mission exactly once.

**Requirements:** FR-007–008, FR-011–013, NFR-001–002.

**Files:** `src/controller/mission-service.ts`, `src/domain/workflow.ts`, `src/persistence/sqlite.ts`, `src/controller/workflow-persistence.ts`, `tests/integration/mission-transitions.test.ts`.

**Interface:**

```ts
interface TransitionMissionInput {
  missionId: string;
  expectedState: MissionState;
  nextState: MissionState;
  currentTaskId?: string;
  consumeCurrentTask?: boolean;
  approval?: ApprovalInput;
  nextTask?: TaskExecutionInput;
  dispatch?: DispatchInput;
  failureReason?: string;
}

interface CompletionGateEvaluator {
  evaluate(missionId: string): CompletionGateStatus;
}
```

**Steps:**

1. Add failing tests for compare-and-set transition, completion reconciliation, action validation, correction count, and completion predicate.
2. Implement compare-and-set mission transition using `WHERE mission_id = ? AND state = ?`.
3. Make completed-task reconciliation derive next state, consume, record event, and enqueue decision in one transaction.
4. Make action application validate mission, gate, and exact current task.
5. Commit approval/rejection, transition, correction task, outbox, consumption, and ledger together.
6. Count correction attempts from all durable task executions.
7. Route Planner rejection to Planner and Builder rejection to Builder; block after two.
8. Require `CompletionGateEvaluator.evaluate()` to return every field true.
9. Commit: `fix: enforce atomic ORCA mission transitions`.

### FIX-005 — Wire production runtime and prove Planner-to-Builder

**Objective:** Connect the corrected services through `startController()` and `EventRuntime`.

**Requirements:** FR-009–010, FR-014, NFR-002.

**Files:** `src/controller/main.ts`, `src/controller/event-runtime.ts`, `src/controller/mission-ingress.ts`, delete `src/controller/planner-dispatch.ts`, `tests/contract/controller-start.test.ts`, new `tests/integration/controller-workflow-runtime.test.ts`.

**Serialized cycle:**

```ts
await ingress.poll();
await completion.observeAll();
await mission.reconcileCompletedTasks();
await actions.observeAll();
await dispatch.recoverPending();
```

**Steps:**

1. Add a failing controller-started test with five fake sessions and five distinct models.
2. Assert visible order: Session 1 user objective → Session 2 Planner prompt → stable Planner result → Session 1 decision prompt → stable correlated plan approval → Session 3 Builder prompt.
3. Construct `DispatchOutbox`, `MissionService`, `OrchestratorActionIntake`, and `WorkerCompletionService` in `startController()`.
4. Replace legacy dispatcher dependency in `MissionIngress` and `EventRuntime`.
5. Serialize startup, SSE, and polling reconciliation.
6. Delete the legacy Planner dispatcher after Planner regression uses the generalized outbox.
7. Commit: `fix: connect ORCA mission runtime end to end`.

### FIX-006 — Independent review, evidence, and release gate

**Objective:** Close unsupported completion claims and record verifiable evidence.

**Steps:**

1. Run GitNexus change detection against branch comparison.
2. Dispatch independent specification reviewer for FR-001–014.
3. Dispatch separate code-quality/security reviewer.
4. Assign correction work for every critical/important finding.
5. Re-run affected focused suites after each correction.
6. Record actual task commit hashes, exact commands, exit codes, reviewer verdicts.
7. Run full gate: `lint`, `typecheck`, `test:unit`, `test:integration`, `test:contract`, `test:e2e:fake`, `test:coverage`, `build`, `verify`.
8. Confirm `git diff --check` passes and pairing snapshot is not staged.
9. Commit: `docs: record ORCA blocker correction evidence`.

## Subagent assignment and review matrix

| Task | Implementer | Independent reviewer | Adversarial verifier |
|---|---|---|---|
| FIX-001 | Persistence/outbox agent | SQLite reliability reviewer | Migration/replay agent |
| FIX-002 | Completion-recovery agent | Crash-safety reviewer | Restart/failure-injection agent |
| FIX-003 | Authorization agent | Security reviewer | Session-spoofing/action-contract agent |
| FIX-004 | Workflow agent | State-machine reviewer | Transaction/concurrency agent |
| FIX-005 | Runtime integration agent | Architecture reviewer | Controller-started acceptance agent |
| FIX-006 | Evidence coordinator | Requirements reviewer | Release-readiness verifier |

No implementer may approve their own task.

## Consolidated testing strategy

| Layer | Scope | Command | Expected |
|---|---|---|---|
| Unit | Schemas, persistence, completion, action stability | `pnpm.cmd run test:unit` | All tests exit `0` |
| Integration | Repair recovery, actions, transitions, runtime composition | `pnpm.cmd run test:integration` | Planner-to-Builder and crash cases pass |
| Contract | Controller startup, API, adapter | `pnpm.cmd run test:contract` | 0 failures |
| Fake E2E regression | Pairing, profiles, models | `pnpm.cmd run test:e2e:fake` | Existing pairing behavior preserved |
| Migration | v1–6 fixtures upgraded to v7 twice | Focused persistence suite | No data loss; second start is idempotent |
| Security | Wrong session/parent/task/gate and duplicate action | Action integration suite | Every unauthorized input rejected |
| Recovery | Crash before/after send/ack/transition | Recovery integration suites | One intent and one visible prompt |
| Coverage | Repository thresholds | `pnpm.cmd run test:coverage` | Configured thresholds pass |

## Security, reliability, and observability requirements

- Paired Session 1 identity and exact decision-parent correlation are mandatory.
- OpenCode role permissions remain application controls, not an OS sandbox.
- No credentials, authorization headers, raw prompts, or unbounded output enter logs.
- Durable ledgers use IDs, hashes, roles, states, reason codes, attempts, and timestamps.
- Every new prompt uses the target binding's stored model.
- SSE and polling cannot execute reconciliation concurrently.
- Dispatch attempts stop after three delivery failures and persist a redacted blocked reason.
- Task and decision repair attempts are limited to one contract repair.
- Planner and Builder correction tasks are limited to two.
- No direct worker-to-worker route exists.

## Deployment, migration, and rollback plan

1. Stop the controller.
2. Back up `.orca/orca.db` outside the repository.
3. Verify branch, starting commit, roster, and unstaged scope.
4. Apply additive migration 7 during controller startup.
5. Validate schema version, foreign keys, roster integrity, and pending-dispatch reconciliation.
6. Start the controller and verify authenticated status and event listening.
7. Run the fake Planner-to-Builder acceptance mission.
8. Do not run a real OpenCode acceptance mission in this correction phase.
9. Roll back code only before accepting a new mission, or restore the pre-migration database backup with the old commit.
10. After new generalized intents exist, use a forward fix; do not run a destructive down-migration.

Rollback triggers:

- Migration failure.
- Duplicate prompt.
- Wrong-session or wrong-model dispatch.
- Uncorrelated Session 1 action acceptance.
- Partial transition after injected failure.
- Regression in pairing or Planner ingress.

## Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Unsafe classes wired before contracts are fixed | Critical | FIX-001–004 precede FIX-005 |
| Session 1 spoofing or wrong-parent approval | Critical | Exact persisted-parent and stability checks |
| Lost repair after crash | Critical | Transactional outbox and marker recovery |
| Duplicate transition from SSE/poll race | Critical | Serialized level-triggered reconciliation |
| Final completion before quality gates | Critical | Conservative injectable predicate |
| Migration ambiguity | High | Transactional backfill; reject ambiguous rows |
| Old binary after new intents | High | Backup and forward-fix policy |
| Green tests that bypass composition | High | Controller-started integration acceptance |
| Pairing snapshot accidentally committed | Medium | Scoped staging and final staged-file inspection |

## Final self-review results

- Every requirement maps to at least one task and verification command.
- Every task maps to requirements.
- All new interfaces are introduced before consumers.
- Dependencies are acyclic.
- No concurrent task edits shared persistence/runtime files.
- Authentication, action correlation, retries, transactions, and error behavior are explicit.
- Migration and rollback paths are defined.
- Test commands exist in `package.json`.
- Current green tests are not treated as end-to-end proof.
- Independent implementation and review roles are separated.
- No future TASK-005/006 functionality is claimed.
- No unresolved critical product decision remains.

## Remaining blockers

No planning blocker remains. Implementation must not begin until this requirements specification and plan are explicitly approved.

PLAN READY