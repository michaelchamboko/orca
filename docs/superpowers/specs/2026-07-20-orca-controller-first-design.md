# ORCA Controller-First Design

## Scope and outcome

ORCA is an external controller for one OpenCode server and exactly five manually opened sessions for one repository. Pairing fixes the roster: Session 1 Orchestrator, Session 2 Planner, Session 3 Builder, Session 4 Reviewer, Session 5 Test Engineer. Models are read during pairing and persisted unchanged. The user submits a mission only through Session 1; all hand-offs are controller-mediated and visibly dispatched to the assigned session.

The controller, rather than role prompts, owns caller authorization, mission/task transitions, evidence validation, approval gates, persistence, recovery, and final completion. Prompts and skills only guide role behavior. The controller is not part of OpenCode source code and must use a dedicated adapter boundary.

## Architecture

`OpenCodeAdapter` is the sole boundary to OpenCode. It exposes server/session discovery, session status, task delivery, event subscription, and session-scoped tool status; a fake implementation supports contract and end-to-end tests. No OpenCode calls are permitted outside this adapter package.

`RosterService` consumes adapter-discovered sessions and validates five unique sessions from one repository/server in ascending fixed positions. It records model/provider identifiers without mutation, applies persisted role profiles at pairing, and produces roster/session fingerprints. Before mission creation and every dispatch it rechecks roster and repository fingerprints; changed, missing, duplicate, or closed sessions block execution.

`MissionService` is the only state-transition authority. Its authenticated actions accept mission creation, worker result ingestion, orchestrator approval/rejection, and explicit final completion. It allows the fixed Plan → Build → Review → Test sequence and loops failed review/test work to Builder. Every Builder change derives a new workspace fingerprint and invalidates older review/test approvals.

`CompletionDetector` accepts events and polls through the adapter. A worker result completes only after role-specific result-schema validation, matching mission/task/session identity, idle session, no in-flight tool calls, and a quiet-window recheck. It has one result-repair attempt, bounded timeouts, event reconnect/poll fallback, duplicate-event rejection, and session-closure failure handling.

`SqlitePersistence` becomes a durable authority for session bindings, missions, tasks, approvals, inbound events, workspace snapshots, failure reasons, and an outbox. State transitions and outbox enqueue occur in one transaction. Outbox deliveries use idempotency keys and claims so restart/replay cannot create duplicate dispatches. At most one active mission exists per repository roster.

`ControllerApi` binds loopback only, requires a configured controller token, derives caller identity from the paired session, and permits orchestration actions only from Session 1. Worker endpoints accept only their paired worker role. Controller-run test execution uses configured executable/argument arrays, repository-contained paths, bounded output/time, and no shell. Role permissions are controller/API capability rules, not operating-system isolation.

## Role policy

| Role | Controller-granted operations | Explicitly prohibited |
|---|---|---|
| Orchestrator | create/approve/reject/finalize mission; receive controller summaries | direct worker-to-worker routing; model mutation; project writes |
| Planner | receive plan task; submit structured plan | workspace writes; approvals; direct worker messages |
| Builder | receive implementation/correction task; repository writes within allowed paths; submit evidence | approvals/finalization; model mutation |
| Reviewer | receive current-fingerprint review task; submit findings | workspace writes; approvals/finalization; direct worker messages |
| Test Engineer | receive configured test task; submit test evidence | workspace writes; arbitrary shell; approvals/finalization; direct worker messages |

Role profiles contain skills and instructions but never model identifiers. Planned skill groups are: Orchestrator (delegation, approval, retry/escalation/completion); Planner (discovery, architecture, decomposition); Builder (implementation, debugging, TDD); Reviewer (correctness, architecture, security, maintainability); Tester (test planning/execution/diagnosis/evidence). Pairing installs role profiles once; per-mission envelopes contain only scoped context.

## State and quality rules

Mission states are durable: planning, awaiting-plan-approval, building, awaiting-builder-approval, reviewing, awaiting-review-approval, testing, awaiting-test-approval, awaiting-final-approval, needs-user-input, blocked, recovering, completed, failed, cancelled. Only a validated role result may reach an approval state. Only authenticated Session 1 approval moves forward. Review dispatch requires an approved Builder result and current workspace fingerprint; Test dispatch requires a passed, approved review of that same fingerprint. Final completion requires an explicit Session 1 request, passing current review/test evidence, no unresolved task/permission, and unchanged roster/repository/workspace fingerprints.

High/critical blocking review findings, missing file/diff/test evidence, failed checks, stale approval, roster drift, repository drift, pending permission, task timeout, or invalid result block finalization. Rejected plans and failed reviews/tests enqueue a bounded Builder correction task, never worker-to-worker traffic.

## Trust, recovery, and observability

The controller listens only on localhost and authenticates all tool/API calls. Logs redact configured secrets and bound output. File paths are canonicalized below the paired repository root. ORCA never automatically commits, pushes, merges, resets, or deletes branches. Dangerous OpenCode permission requests become explicit user-required states.

On restart, recovery locks the active mission, reloads nonterminal tasks, reconciles adapter status/events, and reuses idempotency keys before considering dispatch. Uncertain in-flight work goes to recovery/blocked rather than assuming completion. Event records and workspace snapshots make decisions auditable.

## Testing and delivery sequence

1. Adapter contract and fake adapter; roster pairing/model preservation/drift tests.
2. Role profiles, authenticated loopback controller API, and authorization/role-isolation tests.
3. Durable mission state/approval service with transactional persistence/outbox/idempotency tests.
4. Workspace fingerprint, controlled test executor, and evidence/stale-approval tests.
5. Dispatcher/completion detector/recovery tests using fake OpenCode events.
6. Fake full mission tests, including review correction and test-failure loops.
7. Real OpenCode contract and visual five-session validation only with an available server and manually opened sessions.

Each increment is test-first, preserves the current domain contracts where compatible, and updates the architecture/operations/test-evidence documents with observed—not aspirational—status.

## Acceptance criteria

The controller must reject invalid roster pairing, model mutation, unpaired callers, unauthorized role actions, skipped/stale gates, invalid worker results, unsafe command requests, duplicate dispatch, and premature completion. A fake full mission must visibly route tasks by role and pass Plan → Build → Review → Test → explicit finalization; failed review/testing must create a Builder correction and invalidate prior approvals. A real five-session test is required before claiming operational OpenCode support.
