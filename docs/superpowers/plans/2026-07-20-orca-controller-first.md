# ORCA Controller-First Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build ORCA’s controller-owned, durable five-session workflow from pairing through fake end-to-end validation, without changing OpenCode or user-selected models.

**Architecture:** Keep all OpenCode interaction behind `OpenCodeAdapter`; the controller owns pairing, authorization, transitions, evidence gates, dispatch, and recovery. SQLite persists the authoritative record and a transactional outbox; fake adapter tests establish behavior before a real OpenCode adapter is enabled.

**Tech Stack:** TypeScript 5.7, Node.js, Zod, Fastify, Pino, better-sqlite3, execa, Vitest, tsup, pnpm.

## Global Constraints

- One controller, one OpenCode server, exactly five manually opened sessions in fixed positions 1–5.
- Pairing records provider/model IDs and never invokes a model-change operation.
- OpenCode SDK/API calls belong only in `src/integrations/opencode/`.
- The controller is external to OpenCode; do not modify OpenCode source code or use browser/keyboard/tab automation.
- Builder is the only write-capable role; Planner, Reviewer, and Tester receive no project-write capability.
- Every new production behavior starts with a focused failing Vitest test, then minimal implementation, then a passing run.
- No worker-to-worker transport; all work is dispatched by `MissionService` through the adapter.
- Test execution uses a configured executable plus argument array, repository-contained working directory, bounded output/time, and `shell: false`.
- ORCA must not automatically commit, push, merge, reset, delete branches, or mutate selected models.
- Preserve existing uncommitted files; stage/commit only after the owner explicitly requests it in this dirty worktree.

---

## Planned File Structure

| Path | Responsibility |
|---|---|
| `src/integrations/opencode/adapter.ts` | stable external adapter contract |
| `src/integrations/opencode/fake.ts` | deterministic fake server/session/event implementation |
| `src/roles/profiles.ts` | fixed role sequence, instructions, skills, capabilities |
| `src/pairing/roster-service.ts` | five-session validation, model preservation, drift checks |
| `src/persistence/sqlite.ts` | versioned migrations and repositories/outbox claims |
| `src/controller/auth.ts` | token/caller/session authorization policy |
| `src/controller/mission-service.ts` | only mission transition and dispatch authority |
| `src/controller/api.ts` | localhost Fastify composition and bounded request schemas |
| `src/workspace/fingerprint.ts` | Git/workspace fingerprint provider |
| `src/execution/test-runner.ts` | configured, shell-free test execution |
| `src/completion/detector.ts` | multi-signal worker completion and repair handling |
| `src/recovery/recovery-service.ts` | restart reconciliation/idempotent re-dispatch |
| `tests/{unit,contract,e2e}/...` | unit, contract, and fake mission coverage |

### Task 1: Define the OpenCode adapter contract and fake adapter

**Files:**
- Create: `src/integrations/opencode/adapter.ts`
- Create: `src/integrations/opencode/fake.ts`
- Create: `tests/contract/opencode-adapter.test.ts`
- Modify: `src/integrations/opencode/types.ts`

**Interfaces:**
- Produces `OpenCodeAdapter`, `OpenCodeSession`, `OpenCodeEvent`, `DeliveredTask`, and `FakeOpenCodeAdapter`.
- Consumed by `RosterService`, `MissionService`, `CompletionDetector`, and recovery.

- [ ] **Step 1: Write the failing contract test**

```ts
import { describe, expect, it } from "vitest";
import { FakeOpenCodeAdapter } from "../../src/integrations/opencode/fake.js";

it("delivers a controller task only to the requested session", async () => {
  const adapter = new FakeOpenCodeAdapter([session("s-2", 2)]);
  await adapter.deliverTask("s-2", { taskId: "t-1", content: "plan" });
  expect(adapter.deliveries()).toEqual([{ sessionId: "s-2", taskId: "t-1", content: "plan" }]);
});
```

- [ ] **Step 2: Run the contract test and verify it fails**

Run: `pnpm vitest run tests/contract/opencode-adapter.test.ts`

Expected: failure because `fake.js` does not exist.

- [ ] **Step 3: Implement the smallest adapter surface**

```ts
export interface OpenCodeAdapter {
  listSessions(): Promise<OpenCodeSession[]>;
  deliverTask(sessionId: string, task: DeliveredTask): Promise<void>;
  getSessionStatus(sessionId: string): Promise<SessionStatus>;
  subscribe(listener: (event: OpenCodeEvent) => void): () => void;
}

export class FakeOpenCodeAdapter implements OpenCodeAdapter {
  // Store copied session records and delivery records; throw for unknown sessions.
}
```

Implement `listSessions`, `deliverTask`, `getSessionStatus`, `subscribe`, `emit`, and read-only `deliveries`; fake sessions include `id`, `position`, `serverBaseUrl`, `projectRoot`, `model`, `title`, `status`, and `inFlightToolCalls`.

- [ ] **Step 4: Run the contract test and verify it passes**

Run: `pnpm vitest run tests/contract/opencode-adapter.test.ts`

Expected: one passing test.

- [ ] **Step 5: Extend tests for unknown session and unsubscribe behavior**

```ts
await expect(adapter.deliverTask("missing", task)).rejects.toThrow("unknown OpenCode session");
const stop = adapter.subscribe(listener); stop(); adapter.emit(event); expect(listener).not.toHaveBeenCalled();
```

- [ ] **Step 6: Run focused tests**

Run: `pnpm vitest run tests/contract/opencode-adapter.test.ts`

Expected: all adapter contract tests pass.

### Task 2: Add role profiles and persistent five-session pairing

**Files:**
- Create: `src/roles/profiles.ts`
- Create: `src/pairing/roster-service.ts`
- Create: `tests/unit/roster-service.test.ts`
- Modify: `src/domain/types.ts`
- Modify: `src/persistence/sqlite.ts`

**Interfaces:**
- Consumes `OpenCodeAdapter.listSessions()` and `SqlitePersistence.saveRoster()`.
- Produces `RosterService.pair()`, `RosterService.assertCurrent()`, and `PairedRoster`.

- [ ] **Step 1: Write failing roster tests**

```ts
it("pairs exactly five ordered same-repository sessions without changing models", async () => {
  const roster = await service.pair();
  expect(roster.bindings.map((b) => [b.position, b.role]))
    .toEqual([[1,"orchestrator"],[2,"planner"],[3,"builder"],[4,"reviewer"],[5,"tester"]]);
  expect(adapter.modelMutations()).toEqual([]);
});

it("rejects duplicate, missing, changed, or cross-repository sessions", async () => {
  await expect(service.pair()).rejects.toThrow("exactly five unique sessions");
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run tests/unit/roster-service.test.ts`

Expected: failure because `RosterService` is absent.

- [ ] **Step 3: Implement immutable profiles and pairing**

```ts
export const roleProfiles = [
  { position: 1, role: "orchestrator", capabilities: ["mission:create", "mission:approve", "mission:finalize"] },
  { position: 2, role: "planner", capabilities: ["result:submit"] },
  { position: 3, role: "builder", capabilities: ["result:submit", "workspace:write"] },
  { position: 4, role: "reviewer", capabilities: ["result:submit"] },
  { position: 5, role: "tester", capabilities: ["result:submit", "test:run"] }
] as const;

export class RosterService {
  async pair(): Promise<PairedRoster> { /* validate and persist copied models */ }
  async assertCurrent(): Promise<PairedRoster> { /* compare IDs, root, server, model, title */ }
}
```

Use a stable SHA-256 JSON fingerprint over server URL, root, ordered IDs, titles, and model provider/model IDs. Add `rosters` and `session_bindings` tables with unique `(roster_id, position)`, unique `(roster_id, role)`, and unique `session_id`.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm vitest run tests/unit/roster-service.test.ts`

Expected: ordered pairing and each invalid roster case pass.

- [ ] **Step 5: Add drift tests**

```ts
adapter.replaceSession({ ...session("s-3", 3), model: { providerId: "x", modelId: "changed" } });
await expect(service.assertCurrent()).rejects.toThrow("roster drift");
```

- [ ] **Step 6: Run pairing tests**

Run: `pnpm vitest run tests/unit/roster-service.test.ts`

Expected: all pairing/model-preservation/drift tests pass.

### Task 3: Evolve persistence into transactional workflow storage

**Files:**
- Modify: `src/persistence/sqlite.ts`
- Create: `tests/unit/persistence-workflow.test.ts`
- Modify: `src/persistence/index.ts`

**Interfaces:**
- Produces `createMissionWithOutbox`, `claimOutboxEvents`, `recordApproval`, `recordWorkspaceSnapshot`, `listRecoverableMissions`.
- Consumed by mission, dispatch, and recovery services.

- [ ] **Step 1: Write failing transaction and idempotency tests**

```ts
it("rolls back a mission transition when its outbox insert fails", () => {
  expect(() => store.createMissionWithOutbox(mission, invalidAction)).toThrow();
  expect(store.getMission(mission.id)).toBeNull();
});

it("claims a pending dispatch once by idempotency key", () => {
  store.enqueueDispatch(action); expect(store.claimOutboxEvents("worker-a", 10)).toHaveLength(1);
  expect(store.claimOutboxEvents("worker-b", 10)).toHaveLength(0);
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run tests/unit/persistence-workflow.test.ts`

Expected: failure because repository methods are absent.

- [ ] **Step 3: Add migrations and repositories**

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(mission_id), gate TEXT NOT NULL, fingerprint TEXT NOT NULL, approved_by_session_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_mission_per_roster ON missions(roster_id) WHERE state NOT IN ('completed','failed','cancelled');
ALTER TABLE outbox_events ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_idempotency ON outbox_events(idempotency_key);
```

Add tables for `inbound_events`, `workspace_snapshots`, and `failure_reasons`; implement a migration ledger rather than unversioned schema changes. Claim outbox rows atomically with `claimed_by`, `claimed_at`, `attempt_count`, and `last_error`.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm vitest run tests/unit/persistence-workflow.test.ts`

Expected: transaction rollback and single claim pass.

- [ ] **Step 5: Add active-mission and persistence round-trip tests**

```ts
store.createMissionWithOutbox(activeMission, action);
expect(() => store.createMissionWithOutbox(secondActiveMission, action)).toThrow(/active mission/);
expect(store.getApprovals(mission.id)[0].fingerprint).toBe("workspace-2");
```

- [ ] **Step 6: Run all persistence tests**

Run: `pnpm vitest run tests/unit/persistence.test.ts tests/unit/persistence-workflow.test.ts`

Expected: passing tests when the local native SQLite binding is available; otherwise record the binding block and retain fake-repository tests in the next task.

### Task 4: Implement controller authorization and localhost API

**Files:**
- Create: `src/controller/auth.ts`
- Create: `src/controller/api.ts`
- Modify: `src/controller/main.ts`
- Create: `tests/contract/controller-api.test.ts`

**Interfaces:**
- Produces `createControllerApi(deps): FastifyInstance` and `authorizeCaller(input, action): CallerIdentity`.
- Consumes roster bindings and `MissionService` actions.

- [ ] **Step 1: Write failing authorization tests**

```ts
it("permits only paired Session 1 to create and finalize missions", async () => {
  await expect(client.createMission(session1Headers, request)).resolves.toMatchObject({ statusCode: 201 });
  await expect(client.createMission(session2Headers, request)).resolves.toMatchObject({ statusCode: 403 });
});

it("rejects missing token and mismatched session role", async () => {
  expect(reply.statusCode).toBe(401);
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run tests/contract/controller-api.test.ts`

Expected: failure because `createControllerApi` is absent.

- [ ] **Step 3: Implement token/caller checks and routes**

```ts
export function authorizeCaller(token: string | undefined, sessionId: string | undefined, required: Capability, roster: PairedRoster): CallerIdentity {
  if (!timingSafeEqualToken(token, configuredToken)) throw new ControllerError("unauthenticated");
  const binding = roster.bySessionId[sessionId ?? ""];
  if (!binding || !profileFor(binding.role).capabilities.includes(required)) throw new ControllerError("forbidden");
  return { sessionId: binding.sessionId, role: binding.role };
}
```

Register JSON-schema-bounded routes for mission creation, worker result submission, gate approval/rejection, and finalization. Bind `127.0.0.1` in `startController`; never accept a caller-provided role. Configure Pino redaction for authorization headers and token fields.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm vitest run tests/contract/controller-api.test.ts`

Expected: authenticated Session 1 succeeds; other/missing callers fail.

- [ ] **Step 5: Add role-isolation route tests**

```ts
expect((await client.submitResult(builderHeaders, plannerResult)).statusCode).toBe(403);
expect((await client.approve(builderHeaders, approval)).statusCode).toBe(403);
```

- [ ] **Step 6: Run controller contract tests**

Run: `pnpm vitest run tests/contract/controller-api.test.ts`

Expected: all caller and role-isolation cases pass.

### Task 5: Build the mission service and controller-enforced gates

**Files:**
- Create: `src/controller/mission-service.ts`
- Modify: `src/domain/workflow.ts`
- Modify: `src/domain/policy.ts`
- Create: `tests/unit/mission-service.test.ts`

**Interfaces:**
- Produces `MissionService.createMission`, `acceptWorkerResult`, `approveGate`, `rejectGate`, `requestFinalCompletion`.
- Consumes `RosterService.assertCurrent`, `parseWorkerResult`, persistence, fingerprints, and adapter outbox actions.

- [ ] **Step 1: Write failing gate tests**

```ts
it("does not dispatch Builder until Session 1 approves a ready plan", async () => {
  await service.acceptWorkerResult(plannerResult);
  expect(store.pendingDispatches()).toEqual([]);
  await service.approveGate(orchestrator, missionId);
  expect(store.pendingDispatches()[0].role).toBe("builder");
});

it("rejects final completion when current test approval is missing", async () => {
  await expect(service.requestFinalCompletion(orchestrator, missionId)).rejects.toThrow("test gate");
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run tests/unit/mission-service.test.ts`

Expected: failure because `MissionService` is absent.

- [ ] **Step 3: Implement one state authority**

```ts
async approveGate(caller: CallerIdentity, missionId: string): Promise<Mission> {
  this.requireOrchestrator(caller);
  const mission = await this.loadCurrentMission(missionId);
  this.assertRequiredEvidence(mission);
  const next = resolveMissionApproval(mission.state, true);
  return this.persistence.transitionWithOutbox(mission, next, dispatchFor(next));
}
```

Validate task/session identity and role-specific results before transitions. Store the exact reviewed/tested workspace fingerprint on approvals. Replace the old terminal-task mapping so blocked, failed, and cancelled map to their own non-approved task terminal values.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm vitest run tests/unit/mission-service.test.ts`

Expected: plan approval dispatch and premature-finalization rejection pass.

- [ ] **Step 5: Add correction/stale-approval tests**

```ts
await service.acceptWorkerResult(builderChangedWorkspace);
expect(store.getApprovals(missionId, "review")).toEqual([]);
expect(store.pendingDispatches().at(-1)?.role).toBe("reviewer");
await service.acceptWorkerResult(reviewChangesRequired);
expect(store.pendingDispatches().at(-1)?.role).toBe("builder");
```

- [ ] **Step 6: Run mission tests**

Run: `pnpm vitest run tests/unit/mission-service.test.ts tests/unit/domain-workflow.test.ts`

Expected: full gate and correction loop coverage passes.

### Task 6: Add workspace fingerprints and controlled test execution

**Files:**
- Create: `src/workspace/fingerprint.ts`
- Create: `src/execution/test-runner.ts`
- Create: `tests/unit/fingerprint.test.ts`
- Create: `tests/unit/test-runner.test.ts`

**Interfaces:**
- Produces `computeWorkspaceFingerprint(root)` and `runConfiguredTest(command, root)`.
- Consumed by mission gate checks and Tester tasks.

- [ ] **Step 1: Write failing fingerprint and runner tests**

```ts
it("changes fingerprint when a tracked file changes", async () => {
  expect(await computeWorkspaceFingerprint(root)).not.toBe(await computeWorkspaceFingerprint(changedRoot));
});
it("rejects shell strings and paths outside the repository", async () => {
  await expect(runConfiguredTest({ executable: "pnpm test" }, root)).rejects.toThrow("executable");
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run tests/unit/fingerprint.test.ts tests/unit/test-runner.test.ts`

Expected: failure because modules are absent.

- [ ] **Step 3: Implement canonical containment and `shell: false` execution**

```ts
export interface TestCommand { executable: string; args: string[]; timeoutMs: number; }
export async function runConfiguredTest(command: TestCommand, root: string): Promise<TestEvidence> {
  assertInsideRoot(root, root);
  const result = await execa(command.executable, command.args, { cwd: root, shell: false, reject: false, timeout: command.timeoutMs, all: true });
  return { exitCode: result.exitCode, output: redactAndTruncate(result.all ?? "", 16_384) };
}
```

Fingerprint canonical relative paths plus Git HEAD and dirty-state data; use a deterministic hash. Reject absolute allowed paths, path traversal, nonpositive timeouts, executables containing whitespace, and output exceeding the bound.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm vitest run tests/unit/fingerprint.test.ts tests/unit/test-runner.test.ts`

Expected: changed state and unsafe command tests pass.

- [ ] **Step 5: Add stale fingerprint mission test**

```ts
await expect(service.approveGate(orchestrator, missionId)).rejects.toThrow("workspace fingerprint changed");
```

- [ ] **Step 6: Run focused tests**

Run: `pnpm vitest run tests/unit/fingerprint.test.ts tests/unit/test-runner.test.ts tests/unit/mission-service.test.ts`

Expected: all focused evidence/gate tests pass.

### Task 7: Implement dispatch and multi-signal completion detection

**Files:**
- Create: `src/controller/dispatcher.ts`
- Create: `src/completion/detector.ts`
- Create: `tests/unit/completion-detector.test.ts`
- Create: `tests/contract/dispatcher.test.ts`

**Interfaces:**
- Produces `Dispatcher.flushOutbox()` and `CompletionDetector.observe()/poll()`.
- Consumes idempotently claimed outbox entries and `OpenCodeAdapter` status/events.

- [ ] **Step 1: Write failing completion tests**

```ts
it("requires valid result, idle status, no tools, and quiet-window recheck", async () => {
  detector.observe(validResultEvent); adapter.setStatus("s-2", { idle: true, inFlightToolCalls: 1 });
  expect(await detector.poll()).toEqual([]);
  adapter.setStatus("s-2", { idle: true, inFlightToolCalls: 0 }); clock.advanceBy(quietMs);
  expect(await detector.poll()).toHaveLength(1);
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run tests/unit/completion-detector.test.ts`

Expected: failure because detector is absent.

- [ ] **Step 3: Implement bounded detector and dispatcher**

```ts
async poll(): Promise<CompletionCandidate[]> {
  for (const task of this.pendingTasks()) {
    const status = await this.adapter.getSessionStatus(task.sessionId);
    if (task.validResult && status.idle && status.inFlightToolCalls === 0 && this.clock.now() - task.lastActivityAt >= this.quietWindowMs) complete.push(task);
  }
  return complete;
}
```

Deduplicate by persisted event ID. On invalid JSON, enqueue exactly one repair request; on another violation set `result_contract_violation`. Poll after stream disconnect, record timeout failure, and record session closure as blocked. Dispatcher claims then delivers outbox records; marks published only after delivery and preserves the idempotency key.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm vitest run tests/unit/completion-detector.test.ts tests/contract/dispatcher.test.ts`

Expected: multi-signal completion and one delivery per action pass.

- [ ] **Step 5: Add duplicate/disconnect/timeout tests**

```ts
detector.observe(event); detector.observe(event); expect(await detector.poll()).toHaveLength(1);
adapter.disconnectEvents(); expect(await detector.poll()).toHaveLength(1);
clock.advanceBy(timeoutMs + 1); expect(task.state).toBe("timed_out");
```

- [ ] **Step 6: Run completion suite**

Run: `pnpm vitest run tests/unit/completion-detector.test.ts tests/contract/dispatcher.test.ts`

Expected: duplicate, fallback, repair, closure, and timeout cases pass.

### Task 8: Implement restart recovery and fake five-session end-to-end flow

**Files:**
- Create: `src/recovery/recovery-service.ts`
- Create: `tests/unit/recovery-service.test.ts`
- Create: `tests/e2e/fake-five-session.test.ts`
- Modify: `src/controller/main.ts`
- Modify: `docs/operations.md`
- Modify: `docs/test-evidence.md`
- Modify: `docs/architecture.md`

**Interfaces:**
- Produces `RecoveryService.recover()` and `startController(config)` composition root.
- Consumes persistence, roster, dispatcher, adapter, detector, and mission service.

- [ ] **Step 1: Write failing recovery and mission-flow tests**

```ts
it("reuses an unacknowledged outbox action after restart without duplicating it", async () => {
  await first.processOneClaimedActionWithoutAcknowledging();
  await second.recover(); expect(adapter.deliveriesFor("task-1")).toHaveLength(1);
});

it("routes a failed review back to Builder and completes only after current review and test pass", async () => {
  await mission.runPlanBuildReviewFailure(); expect(adapter.lastDelivery().sessionId).toBe("builder-session");
  await mission.runBuilderReviewTestPass(); await expect(mission.finalize()).resolves.toMatchObject({ state: "completed" });
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run tests/unit/recovery-service.test.ts tests/e2e/fake-five-session.test.ts`

Expected: failure because recovery/composed controller behavior is absent.

- [ ] **Step 3: Implement recovery composition**

```ts
export class RecoveryService {
  async recover(): Promise<void> {
    for (const mission of this.store.listRecoverableMissions()) {
      await this.roster.assertCurrent();
      await this.detector.reconcile(mission);
    }
    await this.dispatcher.flushOutbox();
  }
}
```

`startController` constructs one persistence instance, adapter, roster service, mission service, dispatcher, detector, recovery service, and localhost API; it calls recovery before accepting mission requests. On unresolved adapter state, persist `recovering` or `blocked`, never completion.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm vitest run tests/unit/recovery-service.test.ts tests/e2e/fake-five-session.test.ts`

Expected: fake correction loop and safe restart tests pass.

- [ ] **Step 5: Update observed documentation**

Document exact CLI commands: `swarmctl pair`, `swarmctl controller start`, `swarmctl status`, and `swarmctl doctor`; include only the real adapter limitations and test outcomes actually observed. Keep real five-session validation marked blocked until a server and tabs exist.

- [ ] **Step 6: Run the release-quality set**

Run: `pnpm run lint; pnpm run typecheck; pnpm run test:unit; pnpm run test:contract; pnpm run test:e2e:fake`

Expected: zero exit code for implemented suites; report native SQLite/runtime blockers exactly if encountered.

### Task 9: Add real OpenCode adapter validation only after fake gates are green

**Files:**
- Create: `src/integrations/opencode/real.ts`
- Create: `tests/e2e:real/five-session.test.ts`
- Modify: `docs/opencode-compatibility.md`
- Modify: `docs/test-evidence.md`

**Interfaces:**
- Produces `RealOpenCodeAdapter implements OpenCodeAdapter`.
- Consumes the official, version-pinned OpenCode API contract established by live validation.

- [ ] **Step 1: Write a skipped-by-default real contract test**

```ts
it.runIf(process.env.ORCA_REAL_E2E === "1")("pairs five manually opened sessions and displays each dispatched task", async () => {
  const roster = await controller.pair(); expect(roster.bindings).toHaveLength(5);
});
```

- [ ] **Step 2: Verify it is excluded without explicit environment opt-in**

Run: `pnpm vitest run tests/e2e:real/five-session.test.ts`

Expected: skipped test with no connection attempt.

- [ ] **Step 3: Implement only documented official API calls in `real.ts`**

Map real session enumeration, model readback, task injection, events, and status polling to the adapter contract. Do not add browser, terminal-tab, keyboard, or mouse automation. Reject a server endpoint outside configured localhost unless an explicit deployment configuration extends the threat model.

- [ ] **Step 4: Run real validation when prerequisites exist**

Run: `$env:ORCA_REAL_E2E="1"; pnpm vitest run tests/e2e:real/five-session.test.ts`

Expected: five manually opened sessions are paired and a visible Planner task is confirmed; if server/sessions are unavailable, record the exact blocking prerequisite and do not claim completion.

## Plan Self-Review

- Spec coverage: Tasks 1–2 cover adapter/roster/model/roles; Tasks 3–5 cover durable workflow, authorization, and gates; Tasks 6–8 cover fingerprinting, controlled testing, completion, idempotency, recovery, and fake E2E; Task 9 covers the real OpenCode validation boundary.
- Placeholder scan: no deferred implementation markers or unspecified test work remain; each task provides named files, interfaces, focused tests, commands, and expected outcomes.
- Type consistency: `OpenCodeAdapter` feeds `RosterService`, `Dispatcher`, and `CompletionDetector`; `MissionService` is the single transition API used by `ControllerApi`; `SqlitePersistence` supplies transaction/outbox/recovery state to the mission and recovery services.
