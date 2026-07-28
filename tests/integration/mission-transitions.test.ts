import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MissionService } from "../../src/controller/mission-service.js";
import { SqlitePersistence } from "../../src/persistence/sqlite.js";
import { FakeOpenCodeAdapter } from "../../src/integrations/opencode/fake.js";
import type { OpenCodeSession } from "../../src/integrations/opencode/types.js";
import type { PairedRoster, Role, TaskEnvelope } from "../../src/domain/types.js";

const roots: string[] = [];
const stores: SqlitePersistence[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoster(): PairedRoster {
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
      model: { providerId: "openai", modelId: `model-${index + 1}` },
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

function makeEnvelope(role: Role, taskId: string, attempt: number): TaskEnvelope {
  return {
    schemaVersion: "1.0",
    missionId: "mission-1",
    taskId,
    role: role as Exclude<Role, "orchestrator">,
    objective: `${role} objective`,
    acceptanceCriteria: [],
    constraints: [],
    requiredEvidence: ["summary"],
    parentTaskIds: [],
    attempt,
    projectRoot: "C:/workspace/orca",
    baseCommit: "0000000",
    sourceWorkspaceFingerprint: "fingerprint",
    createdAt: new Date().toISOString(),
    timeoutMs: 60_000
  };
}

function samplePlannerResult(taskId: string) {
  return {
    schemaVersion: "1.0" as const,
    missionId: "mission-1",
    taskId,
    role: "planner" as const,
    status: "completed" as const,
    summary: "done",
    workPerformed: [],
    files: [],
    commands: [],
    tests: [],
    findings: [],
    risks: [],
    questions: [],
    recommendedNextAction: "proceed",
    sourceWorkspaceFingerprint: "fp",
    completedAt: new Date().toISOString(),
    planVerdict: "ready" as const,
    implementationSteps: [],
    expectedFiles: [],
    validationPlan: []
  };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "orca-mission-"));
  roots.push(root);
  const sessions: OpenCodeSession[] = [1, 2, 3, 4, 5].map((position) => ({ id: `session-${position}`, position, serverBaseUrl: "http://127.0.0.1:4096", projectRoot: root, model: { providerId: "openai", modelId: `model-${position}` }, title: `Session ${position}`, status: "idle", inFlightToolCalls: 0 }));
  const adapter = new FakeOpenCodeAdapter(sessions);
  const persistence = new SqlitePersistence({ path: join(root, "state.sqlite") });
  stores.push(persistence);
  const roster = makeRoster();
  persistence.saveRoster(roster);
  let taskCounter = 0;
  const context = {
    getRoster: async () => roster,
    bind: (role: Role) => {
      const binding = roster.bindings.find((b) => b.role === role);
      if (!binding) throw new Error("missing binding");
      return { sessionId: binding.sessionId, agentName: binding.agentName, model: binding.model };
    },
    nextTaskForRole: (role: Role, missionId: string, attempt: number) => {
      taskCounter += 1;
      const taskId = `task-${taskCounter}`;
      const binding = roster.bindings.find((b) => b.role === role);
      if (!binding) throw new Error("missing binding");
      const envelope = { ...makeEnvelope(role, taskId, attempt), missionId };
      return {
        envelope,
        targetSessionId: binding.sessionId,
        capturedModel: binding.model,
        promptMessageId: `orca-prompt-${taskId}`,
        dispatchKey: `dispatch-${taskId}`
      };
    },
    nextDecisionPrompt: (missionId: string, gate: "plan" | "builder" | "review" | "test" | "final", taskId: string) => {
      const binding = roster.bindings.find((b) => b.role === "orchestrator");
      if (!binding) throw new Error("missing orchestrator binding");
      return {
        targetSessionId: binding.sessionId,
        capturedModel: binding.model,
        promptMessageId: `orca-decision-${gate}-${taskId}`,
        dispatchKey: `dispatch-decision-${missionId}-${gate}-${taskId}`
      };
    }
  };
  return { adapter, persistence, context, roster };
}

describe("MissionService.transitionMission", () => {
  it("advances to building after the planner approval gate is approved and enqueues the next dispatch", () => {
    const setupFixture = setup();
    setupFixture.persistence.createMission({ missionId: "mission-1", rosterId: "roster-1", objective: "test", sourceSessionMessageId: "source-1", state: "awaiting_plan_approval" });
    const service = new MissionService(setupFixture.persistence, setupFixture.adapter, setupFixture.context);

    const result = service.transitionMission({ missionId: "mission-1", nextState: "building" });

    expect(result.previousState).toBe("awaiting_plan_approval");
    expect(result.nextState).toBe("building");
    expect(setupFixture.persistence.getMission("mission-1")?.state).toBe("building");
    expect(setupFixture.persistence.getPendingDispatches()).toHaveLength(1);
    expect(setupFixture.persistence.getMissionEvents("mission-1").map((event) => event.eventType)).toContain("mission.transition");
  });

  it("supersedes prior approvals when leaving an approval gate", () => {
    const setupFixture = setup();
    setupFixture.persistence.createMission({ missionId: "mission-1", rosterId: "roster-1", objective: "test", sourceSessionMessageId: "source-1", state: "awaiting_plan_approval" });
    setupFixture.persistence.recordApproval({ approvalId: "approval-1", missionId: "mission-1", taskId: undefined, decision: "approved", ...({ gate: "plan" } as { gate?: string }) });
    const service = new MissionService(setupFixture.persistence, setupFixture.adapter, setupFixture.context);

    const result = service.transitionMission({ missionId: "mission-1", nextState: "building" });

    expect(result.supersededApprovalCount).toBe(1);
  });

  it("rejects transition when no mission exists", () => {
    const setupFixture = setup();
    const service = new MissionService(setupFixture.persistence, setupFixture.adapter, setupFixture.context);
    expect(() => service.transitionMission({ missionId: "missing", nextState: "building" })).toThrow(/mission not found/);
  });
});

describe("MissionService.applyOrchestratorAction", () => {
  it("applies an approve at the plan gate and advances to building", () => {
    const setupFixture = setup();
    setupFixture.persistence.createMission({ missionId: "mission-1", rosterId: "roster-1", objective: "test", sourceSessionMessageId: "source-1", state: "awaiting_plan_approval" });
    const service = new MissionService(setupFixture.persistence, setupFixture.adapter, setupFixture.context);

    const result = service.applyOrchestratorAction({
      schemaVersion: "1.0",
      missionId: "mission-1",
      action: "approve",
      taskId: "task-plan",
      rationale: "looks good",
      correctionInstructions: []
    }, "source-message-id");

    expect(result.applied).toBe(true);
    expect(setupFixture.persistence.getMission("mission-1")?.state).toBe("building");
  });

  it("blocks the mission after the second plan rejection", () => {
    const setupFixture = setup();
    setupFixture.persistence.createMission({ missionId: "mission-1", rosterId: "roster-1", objective: "test", sourceSessionMessageId: "source-1", state: "awaiting_plan_approval" });
    const service = new MissionService(setupFixture.persistence, setupFixture.adapter, setupFixture.context);

    service.applyOrchestratorAction({ schemaVersion: "1.0", missionId: "mission-1", action: "reject", taskId: "task-plan", rationale: "nope", correctionInstructions: ["fix"] }, "src-1");
    service.applyOrchestratorAction({ schemaVersion: "1.0", missionId: "mission-1", action: "reject", taskId: "task-plan-2", rationale: "still nope", correctionInstructions: ["fix"] }, "src-2");
    const third = service.applyOrchestratorAction({ schemaVersion: "1.0", missionId: "mission-1", action: "reject", taskId: "task-plan-3", rationale: "nope", correctionInstructions: ["fix"] }, "src-3");

    expect(third.missionBlocked).toBe(true);
    expect(setupFixture.persistence.getMission("mission-1")?.state).toBe("blocked");
  });

  it("rejects a request_completion sent before the final approval gate", () => {
    const setupFixture = setup();
    setupFixture.persistence.createMission({ missionId: "mission-1", rosterId: "roster-1", objective: "test", sourceSessionMessageId: "source-1", state: "awaiting_plan_approval" });
    const service = new MissionService(setupFixture.persistence, setupFixture.adapter, setupFixture.context);

    const result = service.applyOrchestratorAction({ schemaVersion: "1.0", missionId: "mission-1", action: "request_completion", rationale: "premature", correctionInstructions: [] }, "src");

    expect(result.applied).toBe(false);
    expect(setupFixture.persistence.getMission("mission-1")?.state).toBe("awaiting_plan_approval");
  });

  it("applies a request_completion at the final gate and completes the mission", () => {
    const setupFixture = setup();
    setupFixture.persistence.createMission({ missionId: "mission-1", rosterId: "roster-1", objective: "test", sourceSessionMessageId: "source-1", state: "awaiting_final_approval" });
    const service = new MissionService(setupFixture.persistence, setupFixture.adapter, setupFixture.context);

    const result = service.applyOrchestratorAction({ schemaVersion: "1.0", missionId: "mission-1", action: "request_completion", rationale: "done", correctionInstructions: [] }, "src");

    expect(result.applied).toBe(true);
    expect(setupFixture.persistence.getMission("mission-1")?.state).toBe("completed");
  });
});

describe("MissionService.reconcileCompletedTasks", () => {
  it("marks completed tasks as consumed exactly once on startup", () => {
    const setupFixture = setup();
    setupFixture.persistence.createMission({ missionId: "mission-1", rosterId: "roster-1", objective: "test", sourceSessionMessageId: "source-1", state: "planning" });
    const task = makeEnvelope("planner", "task-plan", 1);
    setupFixture.persistence.saveTaskExecution({ envelope: task, targetSessionId: "session-2", controllerPromptMessageId: "orca-prompt-task-plan", state: "completed", result: samplePlannerResult(task.taskId) });
    const service = new MissionService(setupFixture.persistence, setupFixture.adapter, setupFixture.context);

    const first = service.reconcileCompletedTasks();
    const second = service.reconcileCompletedTasks();

    expect(first).toBe(1);
    expect(second).toBe(0);
  });
});