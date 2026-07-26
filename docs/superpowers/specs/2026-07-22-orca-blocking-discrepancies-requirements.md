# ORCA Tasks 002–004 Blocking Discrepancies Requirements

**Date:** 2026-07-22
**Status:** Approved (planning mode output, awaiting approval to implement)
**Source:** Planning session output for correction plan, approved for execution

## 1. Executive summary

Correct the incomplete Tasks 002–004 before TASK-005 begins, proving that durable worker repair, correlated Session 1 decisions, atomic mission transitions, and Planner-to-Builder runtime wiring operate through the real controller composition.

**Target artifacts when execution begins:**

- Requirements: `docs/superpowers/specs/2026-07-22-orca-blocking-discrepancies-requirements.md`
- Plan: `docs/superpowers/plans/2026-07-22-orca-blocking-discrepancies-implementation-plan.md`

**Architecture:** Retain one external controller and one SQLite-backed dispatch outbox for every prompt purpose. Repair contracts and persistence first, then action authorization, atomic workflow transitions, production runtime wiring, and controller-started integration acceptance.

**Tech stack:** TypeScript, Node.js, SQLite through `better-sqlite3`, Zod, Vitest, OpenCode adapter contracts, pnpm, tsup.

## 2. Confirmed, inferred, proposed, and decision-required requirements

### Confirmed

- **FR-001:** Invalid worker output creates one durable, deterministic repair dispatch before control returns.
- **FR-002:** Only a new invalid response parented to the repair prompt consumes the second contract failure.
- **FR-003:** Worker execution timeout begins at initial worker-prompt acknowledgement; migrated records without attempt metadata fall back to task creation.
- **FR-004:** Only a stable assistant response in paired Session 1, parented to the active decision prompt, may provide an Orchestrator action.
- **FR-005:** Session 1 actions require idle state, no active-lineage tool, and 1.5 seconds of unchanged content/tool/completion state.
- **FR-006:** One generalized outbox persists and delivers every dispatch purpose with the target's paired model.
- **FR-007:** Completed tasks are consumed, transitioned, logged, and followed by their next dispatch in one transaction.
- **FR-008:** Mission transitions require the expected current state, current mission, current task, and current gate.
- **FR-009:** Production startup, SSE, polling, and restart recovery execute the generalized workflow.
- **FR-010:** Planner completion produces one Session 1 decision prompt; a correlated approval produces one Builder prompt.
- **FR-011:** Planner rejection returns to Planner and Builder rejection returns to Builder, each with at most two corrections.
- **FR-012:** Final completion requires an explicit correlated `request_completion` and a successful completion predicate.
- **FR-013:** No worker output or worker session can approve, route, or complete a mission.
- **FR-014:** Existing CLI, pairing, roster, model-preservation, and Planner-ingress behavior remains compatible.

### Inferred

- **NFR-001:** Dispatch acknowledgement and prompt-attempt acknowledgement must commit together.
- **NFR-002:** SSE and polling reconciliation must be serialized and level-triggered so event ordering cannot duplicate transitions.
- **NFR-003:** New persistence changes must use additive migration 7; versions 1–6 must remain unchanged.
- **NFR-004:** Ledger records contain IDs, states, hashes, bounded reasons, timestamps, and counters, not raw OpenCode messages or credentials.
- **NFR-005:** A dispatch is delivered at least once, while deterministic prompt IDs and markers provide exactly-once controller intent.
- **NFR-006:** Three consecutive delivery failures block the relevant task or decision gate with a durable redacted reason.

### Proposed

- **PR-001:** Use discriminated, schema-validated dispatch payloads rather than reconstructing prompt intent from task lookup.
- **PR-002:** Reuse `StableResponseTracker` for Session 1 action stability.
- **PR-003:** Persist invalid/accepted/rejected decision-response identities in a new migration-7 table without storing raw message text.
- **PR-004:** Keep the completion predicate injectable; production defaults to rejection until later quality-gate tasks supply all required evidence.

### Decision required

None. The committed controller-completion plan establishes correction routing, retry bounds, model preservation, and controller authority.

## 3. Complete requirements specification

| ID | Required behavior | Trigger and output | Validation and failure behavior | Acceptance |
|---|---|---|---|---|
| FR-001–003 | Restart-safe worker repair and timeout | Invalid active response creates one repair outbox action; timeout reads initial acknowledgement | Same invalid message is ignored; new invalid repair response blocks; unacknowledged new records do not use creation-time execution timeout | Crash/restart tests show one repair and correct deadline |
| FR-004–005 | Authorized Session 1 actions | Stable correlated assistant output produces one validated action | Reject user messages, worker sessions, null/wrong parents, active tools, busy sessions, changed output, stale mission/task/gate | Only the valid stable response transitions |
| FR-006 | General outbox | Persisted action renders and sends the correct prompt | Target session, role, model, purpose, payload, marker, and parent are verified before sending | All purposes round-trip and preserve five heterogeneous models |
| FR-007–008 | Atomic workflow | Completed task or action commits consumption, state, approval, ledger, next task, and dispatch | Expected-state mismatch, wrong task, duplicate action, or injected write failure rolls back completely | Crash and rollback tests show all-or-nothing state |
| FR-009–010 | Production wiring | Controller-started fake mission reaches Planner, Session 1 decision, then Builder | Duplicate SSE/poll/restart cannot create duplicate prompts | Observable prompt order and exact model assertions pass |
| FR-011–012 | Corrections and completion | Rejection creates bounded same-role correction; final request evaluates predicate | Third correction blocks; false predicate rejects completion | Retry and premature-completion tests pass |
| FR-013–014 | Isolation and compatibility | Existing pairing and ingress continue working | No model mutation, worker routing, or schema reset | Existing Planner, contract, and fake-pairing suites remain green |

## 4. Non-functional requirements (summary)

| NFR | Requirement |
|---|---|
| NFR-001 | Dispatch and prompt-attempt acknowledgement commit together. |
| NFR-002 | SSE and polling reconciliation serialized, level-triggered. |
| NFR-003 | Additive migration 7 only; v1–v6 unchanged. |
| NFR-004 | Ledger records use IDs, hashes, bounded reasons, timestamps, counters only. |
| NFR-005 | At-least-once delivery; deterministic prompt IDs and markers provide exactly-once intent. |
| NFR-006 | Three consecutive delivery failures block with redacted reason. |

## 5. Architecture options

### Option A — One typed durable outbox (recommended)

All purposes use one lease, marker, model-validation, acknowledgement, and recovery mechanism.

- Best fit with existing schema.
- Lowest duplicate-delivery risk.
- One renderer and one recovery loop.

### Option B — Separate worker and Orchestrator outboxes

- Smaller initial edits.
- Duplicates leasing, retry, acknowledgement, marker logic.
- Creates inconsistent recovery semantics.
- Rejected.

### Option C — Direct sends plus recovery checkpoints

- Minimal schema work.
- Cannot make "persist intent before send" atomic.
- Preserves the current crash-loss window.
- Rejected.

## 6. Assumptions and decision log

| ID | Issue | Evidence/classification | Decision | Alternatives and consequence | Proceed |
|---|---|---|---|---|---|
| AD-001 | One versus multiple outboxes | Existing migration already contains generalized fields; Confirmed | Use one generalized outbox | Separate outboxes duplicate leasing/recovery and increase replay risk | Yes |
| AD-002 | Timeout after repair | Approved task timeout is mission work time; Inferred | Initial worker acknowledgement starts the deadline; repair does not reset it | Resetting on repair permits deadline extension | Yes |
| AD-003 | Correction routing | Committed TASK-004 requires Planner/Builder automatic corrections; Confirmed | Planner→Planner, Builder→Builder, maximum two | Immediate user blocking reduces intended automation | Yes |
| AD-004 | Final completion before TASK-005/006 | Required evidence is not implemented; Confirmed | Injectable predicate defaults to rejection | Allowing completion would bypass future gates | Yes |
| AD-005 | Dirty pairing snapshot | Blob content is unchanged; Confirmed | Exclude it from commits and record the Windows line-ending condition | Restoring it risks touching unrelated work | Yes |
| AD-006 | Rollback | New workflow intents are unreadable semantically by old runtime; Proposed | Forward-fix after new missions; code rollback only with pre-migration DB backup | Destructive down-migration risks mission loss | Yes |

## 7. Remaining blockers

No planning blocker remains. Implementation must not begin until this requirements specification and plan are explicitly approved.