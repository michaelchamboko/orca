import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SqlitePersistence } from "../../src/persistence/sqlite.js";
import {
  MissionState,
  PairedRoster,
  RoleWorkerResult,
  TaskEnvelope
} from "../../src/domain/types.js";

const hasSqliteRuntime = await (async (): Promise<boolean> => {
  try {
    const sqliteModule = await import("better-sqlite3");
    type BetterSqlite3Database = { close(): void };
    type BetterSqlite3Constructor = { new (path: string): BetterSqlite3Database };

    const Database = (sqliteModule.default ?? sqliteModule) as BetterSqlite3Constructor;
    const database = new Database(":memory:");
    database.close();
    return true;
  } catch {
    return false;
  }
})();

const describePersistence = hasSqliteRuntime ? describe : describe.skip;

function createTempDatabasePath(): string {
  return join(mkdtempSync(join(tmpdir(), "opencode-orchestration-")), "state.sqlite");
}

function createTaskEnvelope(missionId: string, taskId: string): TaskEnvelope {
  return {
    schemaVersion: "1.0",
    missionId,
    taskId,
    role: "planner",
    objective: "Plan implementation of feature",
    acceptanceCriteria: ["must work"],
    constraints: ["no extra files"],
    requiredEvidence: ["summary", "files", "commands", "tests"],
    parentTaskIds: [],
    attempt: 1,
    projectRoot: "/tmp/project",
    baseCommit: "0000000",
    sourceWorkspaceFingerprint: "fp",
    createdAt: new Date("2025-01-01T00:00:00Z").toISOString(),
    timeoutMs: 60000
  };
}

function createRoster(): PairedRoster {
  const roles = ["orchestrator", "planner", "builder", "reviewer", "tester"] as const;
  return {
    rosterId: "roster-1",
    fingerprint: "roster-fingerprint",
    serverBaseUrl: "http://127.0.0.1:4096",
    projectRoot: "C:/workspace/orca",
    pairedAt: "2025-01-01T00:00:00.000Z",
    bindings: roles.map((role, index) => ({
      sessionId: `session-${index + 1}`,
      position: (index + 1) as 1 | 2 | 3 | 4 | 5,
      role,
      model: { providerId: "provider", modelId: `model-${index + 1}` },
      agentName: `${role}-agent`,
      projectRoot: "C:/workspace/orca",
      projectFingerprint: "workspace-fingerprint",
      serverBaseUrl: "http://127.0.0.1:4096",
      sessionCreatedAt: "2025-01-01T00:00:00.000Z",
      pairedAt: "2025-01-01T00:00:00.000Z",
      rolePromptHash: `${role}-prompt-hash`,
      expectedTitle: `${role} session`
    }))
  };
}

describePersistence("sqlite persistence", () => {
  let dbPath: string;
  let persistence: SqlitePersistence;
  let PersistenceClass: typeof SqlitePersistence;

  beforeEach(async () => {
    const module = await import("../../src/persistence/sqlite.js");
    PersistenceClass = module.SqlitePersistence;
    dbPath = createTempDatabasePath();
    persistence = new PersistenceClass({ path: dbPath });
  });

  afterEach(() => {
    persistence?.close();
    if (dbPath) {
      rmSync(dbPath, { force: true });
    }
  });

  it("initializes empty storage state", () => {
    expect(persistence.getMissionCount()).toBe(0);
    expect(persistence.getTaskCount()).toBe(0);
    expect(persistence.getPendingOutboxEvents()).toEqual([]);
  });

  it("persists mission and task updates", () => {
    const missionId = "mission-1";
    const initialState: MissionState = "planning";
    const nextState: MissionState = "building";
    const taskId = "task-planner-1";

    persistence.saveMission(missionId, initialState, { objective: "initial" });

    persistence.saveTaskEnvelope(createTaskEnvelope(missionId, taskId));

    const plannerResult: RoleWorkerResult = {
      schemaVersion: "1.0",
      missionId,
      taskId,
      role: "planner",
      status: "completed",
      summary: "Plan created",
      workPerformed: ["analysis"],
      files: [{ path: "plan.md", action: "created", summary: "added plan" }],
      commands: [{ command: "pnpm run lint", exitCode: 0, summary: "lint" }],
      tests: [{ name: "plan lint", command: "pnpm run lint", status: "passed", evidence: "clean" }],
      findings: [],
      risks: ["none"],
      questions: [],
      recommendedNextAction: "proceed",
      sourceWorkspaceFingerprint: "source-1",
      completedAt: new Date("2025-01-01T00:01:00Z").toISOString(),
      planVerdict: "ready",
      implementationSteps: ["implement feature"],
      expectedFiles: ["src/main.ts"],
      validationPlan: ["run unit tests"]
    };

    const task = persistence.getTask(taskId);
    expect(task).not.toBeNull();
    expect(task?.role).toBe("planner");

    persistence.saveTaskResult(taskId, "completed", plannerResult);

    const missionResult = persistence.getMission(missionId);
    expect(missionResult).toMatchObject({
      missionId,
      state: initialState,
      payload: { objective: "initial" }
    });

    const storedTask = persistence.getTask(taskId);
    expect(storedTask).not.toBeNull();
    expect(storedTask?.result?.role).toBe("planner");

    persistence.runInTransaction(() => {
      persistence.saveMission(missionId, nextState, { objective: "updated" });
      persistence.enqueueOutboxEvent(missionId, "mission", "mission.state_changed", {
        from: initialState,
        to: nextState
      });
    });

    const updatedMission = persistence.getMission(missionId);
    expect(updatedMission?.state).toBe(nextState);
    expect(updatedMission?.payload).toEqual({ objective: "updated" });
    expect(persistence.getPendingOutboxEvents()).toHaveLength(1);
  });

  it("rolls back mission and outbox writes when a transaction fails", () => {
    expect(() => {
      persistence.runInTransaction(() => {
        persistence.saveMission("mission-2", "planning", { objective: "failing mission" });
        persistence.enqueueOutboxEvent("mission-2", "mission", "mission.created", {
          mission: "mission-2"
        });
        throw new Error("simulated failure");
      });
    }).toThrow("simulated failure");

    expect(persistence.getMission("mission-2")).toBeNull();
    expect(persistence.getPendingOutboxEvents()).toHaveLength(0);
  });

  it("marks outbox events as published", () => {
    persistence.saveMission("mission-3", "planning", { objective: "outbox mission" });
    const outboxEvent = persistence.enqueueOutboxEvent("mission-3", "mission", "mission.created", {
      missionId: "mission-3"
    });

    persistence.markOutboxEventsPublished([outboxEvent.id]);

    expect(persistence.getPendingOutboxEvents()).toEqual([]);
  });

  it("reopens an existing roster with all five paired bindings and models", () => {
    const roster = createRoster();
    persistence.saveRoster(roster);
    persistence.close();

    persistence = new PersistenceClass({ path: dbPath });

    expect(persistence.getCurrentRoster()).toEqual(roster);
  });

  it("rejects a second active mission for a roster but permits a new active mission after a terminal state", () => {
    persistence.saveRoster(createRoster());
    persistence.createMission({
      missionId: "mission-active-1",
      rosterId: "roster-1",
      objective: "first",
      sourceSessionMessageId: "source-1",
      state: "planning"
    });

    expect(() => persistence.createMission({
      missionId: "mission-active-2",
      rosterId: "roster-1",
      objective: "second",
      sourceSessionMessageId: "source-2",
      state: "building"
    })).toThrow();

    persistence.saveMission("mission-active-1", "completed", { objective: "first" });

    expect(() => persistence.createMission({
      missionId: "mission-active-2",
      rosterId: "roster-1",
      objective: "second",
      sourceSessionMessageId: "source-2",
      state: "planning"
    })).not.toThrow();
  });

  it("atomically rolls back a mission, its initial task, and its dispatch when creation fails", () => {
    persistence.saveRoster(createRoster());

    expect(() => persistence.createMissionTaskAndDispatch({
      mission: {
        missionId: "mission-atomic",
        rosterId: "roster-1",
        objective: "atomic mission",
        sourceSessionMessageId: "source-atomic",
        state: "planning"
      },
      task: {
        envelope: createTaskEnvelope("mission-atomic", "task-atomic"),
        targetSessionId: "session-2",
        controllerPromptMessageId: "controller-message-1"
      },
      dispatch: {
        dispatchKey: "mission-atomic:task-atomic:1",
        targetRole: "planner",
        targetSessionId: "session-2",
        capturedModel: { providerId: "provider", modelId: "model-2" },
        promptMessageId: "controller-message-1"
      },
      beforeCommit: () => { throw new Error("injected failure"); }
    })).toThrow("injected failure");

    expect(persistence.getMission("mission-atomic")).toBeNull();
    expect(persistence.getTask("task-atomic")).toBeNull();
    expect(persistence.getDispatchByKey("mission-atomic:task-atomic:1")).toBeNull();
  });

  it("idempotently reuses a dispatch outbox record for its dispatch key", () => {
    persistence.saveRoster(createRoster());
    persistence.createMission({ missionId: "mission-dispatch", rosterId: "roster-1", objective: "dispatch", sourceSessionMessageId: "source-dispatch", state: "planning" });
    const input = {
      missionId: "mission-dispatch",
      dispatchKey: "mission-dispatch:task-1:1",
      targetRole: "planner" as const,
      targetSessionId: "session-2",
      capturedModel: { providerId: "provider", modelId: "model-2" },
      promptMessageId: "controller-message-2"
    };

    const first = persistence.enqueueDispatch(input);
    const second = persistence.enqueueDispatch(input);

    expect(second).toEqual(first);
    expect(persistence.getPendingDispatches()).toHaveLength(1);
  });

  it("prevents duplicate dispatch claims and recovers an expired lease", () => {
    persistence.saveRoster(createRoster());
    persistence.createMission({ missionId: "mission-lease", rosterId: "roster-1", objective: "lease", sourceSessionMessageId: "source-lease", state: "planning" });
    persistence.enqueueDispatch({ missionId: "mission-lease", dispatchKey: "mission-lease:task-1:1", targetRole: "planner", targetSessionId: "session-2", capturedModel: { providerId: "provider", modelId: "model-2" }, promptMessageId: "controller-message-3" });

    const firstClaim = persistence.claimNextDispatch("dispatcher-a", 1000, "2025-01-01T00:00:00.000Z");
    expect(firstClaim?.leaseOwner).toBe("dispatcher-a");
    expect(persistence.claimNextDispatch("dispatcher-b", 1000, "2025-01-01T00:00:00.500Z")).toBeNull();

    const recoveredClaim = persistence.claimNextDispatch("dispatcher-b", 1000, "2025-01-01T00:00:02.000Z");
    expect(recoveredClaim?.leaseOwner).toBe("dispatcher-b");
    if (!recoveredClaim) throw new Error("expected expired dispatch lease to be recovered");
    persistence.acknowledgeDispatch(recoveredClaim.id, "dispatcher-b", "2025-01-01T00:00:02.100Z");
    expect(persistence.getPendingDispatches()).toEqual([]);
  });

  it("deduplicates processed messages and persists controller checkpoints across reopen", () => {
    expect(persistence.recordProcessedMessage({ messageHash: "hash-1", messageId: "message-1", eventType: "message.updated", sessionId: "session-2", payload: { value: 1 } })).toBe(true);
    expect(persistence.recordProcessedMessage({ messageHash: "hash-1", messageId: "message-1", eventType: "message.updated", sessionId: "session-2", payload: { value: 1 } })).toBe(false);
    persistence.saveControllerCheckpoint({ cursorKey: "controller:session-2", rosterId: null, cursor: "cursor-42", payload: { lastMessageId: "message-1" } });
    persistence.close();

    persistence = new PersistenceClass({ path: dbPath });

    expect(persistence.hasProcessedMessage("hash-1")).toBe(true);
    expect(persistence.getControllerCheckpoint("controller:session-2")).toMatchObject({ cursor: "cursor-42", payload: { lastMessageId: "message-1" } });
  });

  it("enforces mission foreign keys for execution and dispatch persistence", () => {
    expect(() => persistence.saveTaskExecution({
      envelope: createTaskEnvelope("missing-mission", "task-missing"),
      targetSessionId: "session-2",
      controllerPromptMessageId: "controller-message-missing"
    })).toThrow();
    expect(() => persistence.enqueueDispatch({
      missionId: "missing-mission",
      dispatchKey: "missing-mission:task-1:1",
      targetRole: "planner",
      targetSessionId: "session-2",
      capturedModel: { providerId: "provider", modelId: "model-2" },
      promptMessageId: "controller-message-missing"
    })).toThrow();
  });
});
