import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MissionService } from "../../src/controller/mission-service.js";
import { SqlitePersistence } from "../../src/persistence/sqlite.js";
import { FakeOpenCodeAdapter } from "../../src/integrations/opencode/fake.js";
import type { OpenCodeSession } from "../../src/integrations/opencode/types.js";
import type { PairedRoster, Role, TaskEnvelope } from "../../src/domain/types.js";
import type { MissionTaskContext } from "../../src/controller/mission-context.js";

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

function setup() {
  const root = mkdtempSync(join(tmpdir(), "orca-r95-004-"));
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
    nextTaskForRole: (role: Role, missionId: string, attempt: number, context: MissionTaskContext) => {
      taskCounter += 1;
      const taskId = `task-${taskCounter}`;
      const binding = roster.bindings.find((b) => b.role === role);
      if (!binding) throw new Error("missing binding");
      const envelope = { ...makeEnvelope(role, taskId, attempt), missionId, objective: context.objective };
      return {
        envelope,
        promptPayload: { kind: "worker_task", objective: context.objective },
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

describe("MissionService atomic authority", () => {
  it("rejects a transition with a stale expected version and leaves the mission unchanged", () => {
    const ctx = setup();
    ctx.persistence.createMission({ missionId: "mission-1", rosterId: "roster-1", objective: "test", sourceSessionMessageId: "source-1", state: "awaiting_plan_approval" });
    const service = new MissionService(ctx.persistence, ctx.adapter, ctx.context);

    expect(() => service.transitionMission({ missionId: "mission-1", nextState: "building", expectedVersion: 99 })).toThrow(/stale mission transition/);
    expect(ctx.persistence.getMission("mission-1")?.state).toBe("awaiting_plan_approval");
    expect(ctx.persistence.getMissionEvents("mission-1").map((event) => event.eventType)).not.toContain("mission.transition");
  });

  it("rolls back a transition when an inner write fails", () => {
    const ctx = setup();
    ctx.persistence.createMission({ missionId: "mission-1", rosterId: "roster-1", objective: "test", sourceSessionMessageId: "source-1", state: "awaiting_plan_approval" });
    const service = new MissionService(ctx.persistence, ctx.adapter, ctx.context);

    expect(() => ctx.persistence.runInTransaction(() => {
      service.transitionMission({ missionId: "mission-1", nextState: "building" });
      throw new Error("synthetic failure after transition");
    })).toThrow(/synthetic failure/);

    expect(ctx.persistence.getMission("mission-1")?.state).toBe("awaiting_plan_approval");
    expect(ctx.persistence.getMissionEvents("mission-1").map((event) => event.eventType)).not.toContain("mission.transition");
    expect(ctx.persistence.getPendingDispatches()).toEqual([]);
  });

  it("rolls back an approval when the applyOrchestratorAction transaction fails", () => {
    const ctx = setup();
    ctx.persistence.createMission({ missionId: "mission-1", rosterId: "roster-1", objective: "test", sourceSessionMessageId: "source-1", state: "awaiting_plan_approval" });
    const service = new MissionService(ctx.persistence, ctx.adapter, ctx.context);

    const before = ctx.persistence.getMissionStateVersion("mission-1");
    expect(() => ctx.persistence.runInTransaction(() => {
      service.applyOrchestratorAction({ schemaVersion: "1.0", missionId: "mission-1", action: "approve", taskId: "task-plan", rationale: "ok", correctionInstructions: [] }, "src-1");
      throw new Error("synthetic failure after approve");
    })).toThrow(/synthetic failure/);

    expect(ctx.persistence.getMission("mission-1")?.state).toBe("awaiting_plan_approval");
    expect(ctx.persistence.getApprovals("mission-1")).toHaveLength(0);
    expect(ctx.persistence.getMissionStateVersion("mission-1")).toBe(before);
  });

  it("returns the new state version from a successful transition", () => {
    const ctx = setup();
    ctx.persistence.createMission({ missionId: "mission-1", rosterId: "roster-1", objective: "test", sourceSessionMessageId: "source-1", state: "awaiting_plan_approval" });
    const service = new MissionService(ctx.persistence, ctx.adapter, ctx.context);

    const result = service.transitionMission({ missionId: "mission-1", nextState: "building" });

    expect(result.stateVersion).toBe(1);
    expect(ctx.persistence.getMissionStateVersion("mission-1")).toBe(1);
  });
});
