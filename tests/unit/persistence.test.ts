import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SqlitePersistence } from "../../src/persistence/sqlite.js";
import {
  MissionState,
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
});
