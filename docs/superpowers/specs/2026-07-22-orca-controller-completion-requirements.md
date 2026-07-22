# ORCA Controller Completion Requirements

**Date:** 2026-07-22
**Status:** Approved (planning mode output, not yet implemented)
**Source:** Planning session output, approved for execution

## 1. Executive summary

Complete the existing external ORCA controller so one new message in paired OpenCode Session 1 automatically and visibly traverses Planner → Builder → Reviewer → Tester → explicit Orchestrator completion.

Current readiness is approximately 35%. Pairing, model preservation, role-profile installation, authenticated localhost controller startup, Session 1 ingestion, durable Planner dispatch, and an initial completion detector exist. The implementation currently stops after Planner completion.

## 2. Repository evidence and current-state analysis

### Implemented and verified in source

| Capability | Evidence | Status |
|---|---|---|
| CLI commands | `src/cli/main.ts:buildCliProgram` | `doctor`, `pair`, `status`, controller start/stop/status implemented |
| Interactive pairing | `src/pairing/interactive.ts:selectFiveSessions` | Five unique active sessions selected manually |
| Roster validation | `src/pairing/roster-service.ts:RosterService` | Repository, server, session, title, role and model drift detected |
| Model preservation | `SessionBinding.model`; `RealOpenCodeAdapter.sendPrompt` | Paired models persisted and reused |
| Role isolation profiles | `src/roles/profiles.ts:roleProfiles` | Only Builder has `bash` and `edit` |
| Live OpenCode boundary | `src/integrations/opencode/real.ts:RealOpenCodeAdapter` | Authenticated HTTP, messages, status, prompts and SSE implemented |
| Controller authentication | `src/controller/api.ts`, `auth.ts`, `runtime.ts` | Loopback-only bearer-authenticated API |
| Session 1 ingress | `src/controller/mission-ingress.ts:MissionIngress` | Historical, duplicate, worker and assistant messages rejected |
| Planner dispatch | `src/controller/planner-dispatch.ts:PlannerDispatchOutbox` | Durable leased dispatch with marker-based replay protection |
| Persistence foundation | `src/persistence/sqlite.ts:SqlitePersistence` | WAL, foreign keys, migrations, roster, mission, task, outbox and checkpoints |
| Completion foundation | `src/controller/worker-completion.ts` | Correlation, schema, idle, tool and quiet-window checks exist |

### Partial or missing

- Worker repair delivery is fire-and-forget, reuses the original prompt ID and is not restart-safe.
- Re-observing the same invalid output can consume both allowed contract attempts.
- Completion writes are not atomic and tool detection is not restricted to the active prompt lineage.
- No correlated Session 1 action service exists.
- No service consumes completed tasks and advances the mission.
- Dispatch is Planner-specific.
- Workspace fingerprints do not hash file content.
- Builder evidence is not reconciled against the repository.
- Review/test corrections and stale-approval invalidation are absent.
- No controlled test runner or `orca.config.json` exists.
- No deterministic final-completion predicate exists.
- Fake E2E covers pairing only; no real five-session mission exists.
- `docs/architecture.md`, `docs/operations.md`, `docs/threat-model.md`, and `docs/test-evidence.md` are stale or placeholders.

### Fresh baseline

| Command | Exit | Result |
|---|---:|---|
| `pnpm.cmd run typecheck` | 0 | Passed |
| `pnpm.cmd run test:unit` | 0 | 73 tests passed |
| `pnpm.cmd run test:e2e:fake` | 0 | Eight pairing tests passed |
| `pnpm.cmd run build` | 0 | Three ESM bundles built |
| `pnpm.cmd run verify` | 1 | ESLint scans generated `.gitnexus/run.cjs` |
| `pnpm.cmd run test:contract` | 1 | Fixed port 4317 collided with a concurrent test process |
| `pnpm.cmd run test:integration` | Not established | Fresh exit code was not captured |
| Live OpenCode status | Unreachable | Real validation currently unavailable |

## 3. Confirmed, inferred, proposed, and decision-required requirements

### Confirmed

- Fixed five-role roster, Session 1-only user interaction and paired-model preservation.
- Controller-owned dispatch, authorization, state transitions and completion.
- Builder-only writes; Reviewer and Tester remain read-only.
- Correlated structured results and Session 1 actions.
- Durable dispatch, completion recovery and explicit final completion.
- Controller-owned configured test execution.
- Fake acceptance before real five-session validation.

### Inferred

- Preserve all existing CLI commands, task/result schema version `1.0` and paired data.
- Continue using a foreground local controller; daemon installation is outside this release.
- Expose redacted mission/task status without exposing prompts or credentials.
- Apply additive SQLite migrations without rebuilding `.orca/orca.db`.

### Proposed

- Retain roster history instead of deleting the previous roster during re-pairing.
- Reject re-pairing while a mission is active.
- Treat exhausted corrections as terminal `blocked`, allowing a later new mission while preserving evidence.
- Install repository-owned role skills during pairing; third-party skills remain optional.
- Separate controller liveness, readiness, SSE connectivity and polling-fallback status.

### Resolved decision

Planner and Builder rejections automatically return structured corrections to the same role. Permit two correction attempts per gate; the next rejection blocks the mission visibly.

No unresolved product decision blocks implementation.

## 4. Complete requirements specification

### 4.1 Problem statement

ORCA currently accepts a Session 1 objective and dispatches Planner work, but cannot continue through the other roles. The operator therefore cannot rely on one-message automated orchestration.

Success means one Session 1 objective visibly traverses all five fixed sessions, preserves every paired model, survives restart without duplicate prompts, enforces review/test gates and completes only after a correlated Session 1 `request_completion`.

### 4.2 Actors and boundaries

| Actor | Supported use cases | Boundary |
|---|---|---|
| Human operator | Open sessions, select models, pair, start controller, message Session 1 | Does not manually route workers or approve controller policy |
| OpenCode server | Supply existing sessions, messages, status and events | ORCA never creates sessions or changes models |
| ORCA controller | Dispatch, validate, persist, recover and enforce gates | Sole workflow authority |
| Orchestrator | Approve, reject, escalate and request completion | Cannot write project files or directly invoke workers |
| Planner | Discover and plan | Read-only |
| Builder | Implement and provide evidence | Sole writing role |
| Reviewer | Review current workspace | Read-only |
| Tester | Diagnose controller-produced test evidence | No shell or file edits |
| SQLite | Durable workflow authority | All coupled changes are transactional |
| Git workspace | Shared mission state | Protected and fingerprinted |

### 4.3 Functional requirements

| ID | Required behaviour and acceptance | Class | Current status |
|---|---|---|---|
| FR-001 | Pair exactly five unique active sessions in fixed role order; reject unknown models, mixed repositories/servers and duplicates. | Confirmed | Verified |
| FR-002 | Persist and reuse each selected provider/model; block on drift; never call a model-changing endpoint. | Confirmed | Verified |
| FR-003 | Install role profiles and repository-owned skills automatically; profiles contain no model. | Confirmed/Proposed | Partial |
| FR-004 | Only a new user message from paired Session 1 creates a mission; ignore historical, worker, assistant, marker and duplicate messages. | Confirmed | Verified |
| FR-005 | Permit one active mission per current roster and reject re-pairing or a second objective while active. | Confirmed/Proposed | Partial |
| FR-006 | Persist every dispatch before delivery using a deterministic prompt ID and `[ORCA_DISPATCH:<key>]`; search before uncertain resend. | Confirmed | Planner only |
| FR-007 | Complete a worker only after active-prompt correlation, strict result validation, idle status, no active-lineage tool and a persisted 1.5-second quiet window. | Confirmed | Partial |
| FR-008 | Permit one durable contract-repair prompt; repeated observation of the same invalid message does not consume it. | Confirmed | Incorrect |
| FR-009 | Accept `approve`, `reject` and `request_completion` only from a stable Session 1 assistant response correlated to the pending decision prompt. | Confirmed | Missing |
| FR-010 | Enforce Planner → approval → Builder → approval → Reviewer → approval → checks → Tester → approval → completion request. | Confirmed | Missing after Planner |
| FR-011 | Prevent worker-to-worker routing and worker self-approval. | Confirmed | Partial |
| FR-012 | Detect any Planner, Reviewer or Tester workspace mutation and block the mission. | Confirmed | Missing |
| FR-013 | Require Builder changed-file, command and targeted-test evidence to match the observed repository delta. | Confirmed | Partial schema only |
| FR-014 | Require Reviewer fingerprint equality and reject pass verdicts with blocking high/critical findings. | Confirmed | Partial |
| FR-015 | Execute only committed configured checks; Tester receives evidence and cannot introduce commands. | Confirmed | Missing |
| FR-016 | Supersede review/test approvals after every new Builder fingerprint. | Confirmed | Missing |
| FR-017 | Route plan/Builder rejection to the same role and review/test failure only to Builder; allow two corrections per gate. | Confirmed by user decision | Missing |
| FR-018 | Complete only when roster, repository, workspace, review, tests, tasks, outbox and permissions are current and Session 1 sends `request_completion`. | Confirmed | Missing |
| FR-019 | Recover pending dispatches and completed-but-unconsumed tasks exactly once after restart. | Confirmed | Planner only |
| FR-020 | Expose authenticated, redacted mission/task/outbox/readiness status. | Inferred | Partial |
| FR-021 | Preserve blocked mission evidence while allowing a later new mission; mission resume is not supported in this release. | Proposed | Missing |
| FR-022 | Do not claim operational readiness until an opt-in real mission is observed in the already paired five sessions. | Confirmed | Blocked by runtime |

### 4.4 Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-001 | Mission transition, current task state, approval invalidation, snapshot, event and next dispatch commit in one SQLite transaction. |
| NFR-002 | Transport is at-least-once; controller intent is idempotent through unique keys, deterministic IDs, leases and marker reconciliation. |
| NFR-003 | Controller remains bound to `127.0.0.1`; every route requires its 256-bit bearer token. |
| NFR-004 | Logs and status omit credentials, authorization headers, objectives, raw prompts and raw worker output. |
| NFR-005 | Migrations are additive, transactional and compatible with existing roster and mission data. |
| NFR-006 | SSE reconnect delays remain 250 ms, 500 ms, 1 s, 2 s and then 5 s; polling fallback runs every second. |
| NFR-007 | Test execution uses argument arrays, `shell:false`, repository cwd, bounded environment, timeout and 64 KiB per output stream. |
| NFR-008 | Liveness, readiness, SSE state and polling fallback are reported separately. |
| NFR-009 | OpenCode calls remain exclusively behind `OpenCodeLiveAdapter`. |
| NFR-010 | Required test lanes must fail when no tests exist; full verification must exit zero before release. |
| NFR-011 | Role profiles are documented as application-level controls, not an OS sandbox. |
| NFR-012 | Correction attempts are bounded at two per gate; contract repair is bounded at one; repeated polling failure is bounded at three. |

### 4.5 Interface contracts

```ts
type DispatchPurpose =
  | "worker_task"
  | "contract_repair"
  | "orchestrator_decision"
  | "final_completion"
  | "status_notice";

interface DispatchInput {
  missionId: string;
  taskId?: string;
  dispatchKey: string;
  purpose: DispatchPurpose;
  targetRole: Role;
  targetSessionId: string;
  capturedModel: ModelRef;
  promptMessageId: string;
  parentPromptMessageId?: string;
  promptPayload: Record<string, unknown>;
}
```

```ts
interface TaskPromptAttempt {
  taskId: string;
  promptMessageId: string;
  purpose: "worker_task" | "contract_repair";
  attempt: number;
  acknowledgedAt: string | null;
}
```

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

Validation:

- `approve` and `reject` require `taskId`.
- `request_completion` omits `taskId`.
- Unknown properties are rejected.
- Mission and task must match the current durable gate.
- Parent ID must match the active controller decision prompt.

```ts
type ApprovalGate = "plan" | "builder" | "review" | "test" | "final";

interface ApprovalInput {
  approvalId: string;
  missionId: string;
  taskId?: string;
  gate: ApprovalGate;
  workspaceFingerprint?: string;
  decision: "approved" | "rejected";
  reason?: string;
}
```

```ts
interface WorkspaceFingerprint {
  fingerprint: string;
  gitHead: string;
  statusHash: string;
  diffHash: string;
  untrackedContentHash: string;
  controlPlaneHash: string;
  changedPaths: string[];
  capturedAt: string;
}
```

```ts
interface ControlledCheckResult {
  name: string;
  executable: string;
  args: string[];
  exitCode: number | null;
  status: "passed" | "failed" | "timed_out" | "spawn_error";
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
}
```

```ts
interface CompletionGateStatus {
  rosterCurrent: boolean;
  repositoryCurrent: boolean;
  workspaceFingerprintCurrent: boolean;
  currentReviewApproved: boolean;
  currentTestApproved: boolean;
  noRunningTasks: boolean;
  noPendingDispatches: boolean;
  noPermissionRequests: boolean;
  explicitRequestCompletion: boolean;
}
```

Committed configuration:

```json
{
  "schemaVersion": "1.0",
  "requiredChecks": [
    {
      "name": "typecheck",
      "executable": "pnpm",
      "args": ["run", "typecheck"],
      "timeoutMs": 120000
    },
    {
      "name": "lint",
      "executable": "pnpm",
      "args": ["run", "lint"],
      "timeoutMs": 120000
    },
    {
      "name": "unit",
      "executable": "pnpm",
      "args": ["run", "test:unit"],
      "timeoutMs": 180000
    }
  ]
}
```

Authenticated status adds:

```ts
interface ControllerStatusPayload {
  healthy: boolean;
  ready: boolean;
  opencodeHealthy: boolean;
  rosterCurrent: boolean;
  eventStream: "connected" | "reconnecting" | "stopped";
  pollingFallbackActive: boolean;
  activeMission?: { missionId: string; state: MissionState };
  currentTask?: { taskId: string; role: Role; state: TaskState };
  pendingDispatchCount: number;
  lastFailureReason?: string;
}
```

### 4.6 Data requirements

Additive migrations:

- Migration 4: add `rosters.is_current`; retain historical rosters; enforce one current roster; reject re-pairing while a mission is active.
- Migration 5: extend `dispatch_outbox` with `task_id`, `purpose`, `parent_prompt_message_id`, and `prompt_payload`; create `task_prompt_attempts`.
- Migration 6: create `orchestrator_action_messages` and `mission_event_ledger`; add `consumed_at` to task execution; add approval gate, fingerprint and `superseded_at`.
- Migration 7: create `controlled_check_runs` and `permission_requests`; persist configuration and control-plane hashes with missions.

Required invariants:

- Foreign keys remain enabled.
- One current roster exists.
- One nonterminal mission exists per current roster.
- Prompt IDs, dispatch keys and processed action/message IDs are unique.
- Results and evidence are bounded before persistence.
- Completed or blocked tasks cannot be reprocessed.
- Down-migrations are not used; incompatible incidents use a forward fix or database backup restoration.

### 4.7 Edge cases and failure behaviour

| Scenario | Required outcome |
|---|---|
| Duplicate SSE and polling observation | Process once |
| Crash before transaction commit | No transition or dispatch intent remains |
| Crash after commit but before send | Outbox sends once after restart |
| Crash after send but before acknowledgement | Marker lookup acknowledges without resend |
| Same invalid response observed repeatedly | Remains on first violation |
| New invalid repair response | Task and mission block |
| Idle without valid result | No advancement |
| Unrelated tool running in same session | Does not block active lineage |
| Active-lineage tool running | Quiet window resets |
| Session deleted/provider error/permission request | Persist reason and block |
| Roster/model/profile drift | Reject dispatch or completion |
| Read-only role writes | Block mission |
| Builder path escape/control-plane edit | Block mission |
| Stale review/test approval | Reject and require current gate |
| Third correction failure | Block mission visibly |
| Failed configured check | Tester receives evidence; failure returns to Builder |
| Premature completion | Reject and record outcome |
| OpenCode unavailable | Controller not ready; no work advances |

### 4.8 Non-goals

- Modifying OpenCode source.
- Creating sessions or selecting/changing models.
- Browser, keyboard, mouse or terminal-tab automation.
- Dynamic worker pools or multiple concurrent missions.
- Worker-to-worker communication.
- Arbitrary model-supplied commands.
- OS-level filesystem sandboxing.
- Automatic Git commit, push, merge, reset or branch deletion.
- Service/daemon installation.
- Multi-user, remote-controller or multi-repository operation.
- Resuming a blocked mission in this release.

## 5. Assumptions and decision log

| ID | Issue | Classification | Decision | Alternative and consequence |
|---|---|---|---|---|
| D-001 | Planner/Builder rejection | User-confirmed | Two automatic corrections, then block | Immediate stop would reduce automation |
| D-002 | Role skills | Proposed default | Repository-owned skills; third-party skills optional | Mandatory external packages add deployment risk |
| D-003 | Blocked missions | Proposed default | `blocked` is terminal; preserve evidence and allow a new mission | Resume requires additional state/API complexity |
| D-004 | Daemon mode | Inferred | Foreground only | Service management may be added separately |
| D-005 | Database upgrades | Inferred | Additive migrations and forward fixes | Destructive rebuild loses paired/recovery state |
| D-006 | Live test | Confirmed | Existing five sessions only; no model/session creation | Creating test sessions violates product scope |
| D-007 | Controller port | Proposed | CLI defaults to 4317; internal tests may request port 0 | Fixed test port causes suite collisions |

## 6. Architecture options and recommendation

### Option A — Extend the existing controller-first architecture

Generalize the current outbox, add a mission transition authority and strengthen persistence/recovery.

- Lowest migration risk.
- Reuses working pairing and Planner dispatch.
- Maintains OpenCode adapter isolation.
- Supports deterministic fake and live testing.

Recommended.

### Option B — Replace SQLite workflow logic with a general workflow engine

- Adds dependencies and deployment complexity.
- Requires migrating existing roster/mission state.
- Produces little value for one local five-role workflow.

Rejected under YAGNI.

### Option C — Prompt-led orchestration inside OpenCode

- Easier initial demonstration.
- Cannot enforce authorization, evidence freshness, idempotency or completion.
- Conflicts with the controller-first requirement.

Rejected.

## 7. File and component impact map

### Create

- `src/domain/action-schemas.ts` — strict Orchestrator action contract.
- `src/controller/response-stability.ts` — shared stable-response evaluation.
- `src/controller/orchestrator-actions.ts` — correlated Session 1 action intake.
- `src/controller/dispatch-outbox.ts` — generalized durable dispatch.
- `src/controller/mission-service.ts` — sole mission transition authority.
- `src/controller/workspace-fingerprint.ts` — content-aware Git fingerprint.
- `src/controller/quality-gates.ts` — evidence, approval and correction policy.
- `src/config/orca-config.ts` — strict configuration loader.
- `src/controller/test-runner.ts` — controlled checks.
- `src/roles/skills.ts` — fixed role-to-skill definitions.
- `orca.config.json`.
- Focused unit, integration, fake-E2E and real-E2E suites named below.

### Modify

- `src/persistence/sqlite.ts` and `workflow-persistence.ts` — migrations and atomic methods.
- `src/controller/event-runtime.ts` and `main.ts` — compose new observers/services.
- `src/controller/api.ts` and `runtime.ts` — readiness/status and test-port isolation.
- `src/domain/types.ts`, `schemas.ts`, `workflow.ts`, `policy.ts`.
- `src/roles/profiles.ts`, `installer.ts`, `activation.ts`.
- `src/integrations/opencode/fake.ts`.
- `src/cli/main.ts`.
- `eslint.config.js`, `package.json`.
- Architecture, operations, threat-model and test-evidence documents.

### Delete after replacement

- `src/controller/planner-dispatch.ts`.
- `src/controller/workspace-baseline.ts`.

### Files that must never be edited concurrently

- `src/persistence/sqlite.ts`
- `src/controller/event-runtime.ts`
- `src/controller/main.ts`
- `src/domain/types.ts`
- `package.json`

Repository policy requires one implementation subagent at a time, even where logical tasks do not overlap.

## 8. Requirements traceability matrix

| Requirement | Components | Tasks | Verification |
|---|---|---|---|
| FR-001–003 | Pairing, roster, roles | TASK-001, TASK-007 | Unit + fake pairing |
| FR-004 | Mission ingress | TASK-001, TASK-008 | Planner integration |
| FR-005 | Roster persistence | TASK-001 | Migration and concurrency tests |
| FR-006 | Dispatch outbox | TASK-002, TASK-004 | Replay/restart integration |
| FR-007–008 | Completion and attempts | TASK-002 | Worker recovery integration |
| FR-009 | Orchestrator actions | TASK-003 | Action unit/integration |
| FR-010–011 | Mission service | TASK-004 | Mission-transition integration |
| FR-012–014 | Workspace and evidence | TASK-005 | Fingerprint/quality-gate tests |
| FR-015 | Controlled checks | TASK-006 | Config and runner tests |
| FR-016–017 | Approval invalidation/corrections | TASK-005 | Correction-loop integration |
| FR-018 | Completion predicate | TASK-008 | Fake complete mission |
| FR-019 | Recovery | TASK-002, TASK-004, TASK-008 | Crash-point E2E |
| FR-020–021 | Status and blocked lifecycle | TASK-004, TASK-008 | API contract/E2E |
| FR-022 | Real acceptance | TASK-009 | `test:e2e:real` |
| NFR-001–002 | Transactions/idempotency | TASK-002, TASK-004 | SQLite failure injection |
| NFR-003–004 | Auth/redaction | TASK-003, TASK-008 | Contract/security tests |
| NFR-005 | Compatibility | TASK-001–006 | Migration fixtures |
| NFR-006, NFR-012 | Bounds | TASK-002 | Recovery tests |
| NFR-007 | Command safety | TASK-006 | Injection/timeout tests |
| NFR-008 | Readiness | TASK-008 | API contract |
| NFR-009 | Adapter isolation | All runtime tasks | Architecture review |
| NFR-010 | Release gates | TASK-001, TASK-008, TASK-009 | `verify`, coverage, real E2E |
| NFR-011 | Trust documentation | TASK-007, TASK-008 | Threat-model review |

## 9. Dependency graph and safe parallelisation groups

```text
TASK-000
  └─ TASK-001
       ├─ TASK-002
       └─ TASK-007
            TASK-002 ──> TASK-003 ──> TASK-004 ──> TASK-005 ──> TASK-006
                                     TASK-007 ───────────────────┘
                                                       └─ TASK-008
                                                            └─ TASK-009
```

Logical non-overlap exists between TASK-002 and TASK-007. Repository instructions nevertheless require implementation agents to execute sequentially. Read-only review agents may operate independently after the implementation agent stops.

## 10. Detailed task-by-task implementation plan

See the companion `2026-07-22-orca-controller-completion.md` plan document.

## 17. Remaining blockers

No decision blocks implementation.

Real five-session acceptance remains operationally blocked until the OpenCode server is reachable and the five paired sessions are available. This does not block TASK-000 through TASK-008.