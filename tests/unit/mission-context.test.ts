import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqlitePersistence } from "../../src/persistence/sqlite.js";
import { buildMissionContext, createMissionBindings } from "../../src/controller/mission-context.js";
import { MissionService } from "../../src/controller/mission-service.js";
import { OrchestratorActionIntake } from "../../src/controller/orchestrator-actions.js";
import { RosterService } from "../../src/pairing/roster-service.js";
import { FakeOpenCodeAdapter } from "../../src/integrations/opencode/fake.js";
import type { PairedRoster } from "../../src/domain/types.js";

const roots: string[] = [];
const stores: SqlitePersistence[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const projectRoot = mkdtempSync(join(tmpdir(), "orca-context-"));
  roots.push(projectRoot);
  mkdirSync(join(projectRoot, ".opencode"), { recursive: true });
  const persistence = new SqlitePersistence({ path: join(projectRoot, "state.sqlite") });
  stores.push(persistence);
  const roster: PairedRoster = {
    rosterId: "roster-1",
    fingerprint: "fp",
    serverBaseUrl: "http://127.0.0.1:4096",
    projectRoot,
    pairedAt: "2025-01-01T00:00:00.000Z",
    bindings: [
      { sessionId: "session-1", position: 1, role: "orchestrator", model: { providerId: "openai", modelId: "gpt-5" }, agentName: "Orchestrator", projectRoot, projectFingerprint: "fp", serverBaseUrl: "http://127.0.0.1:4096", sessionCreatedAt: "2025-01-01T00:00:00.000Z", pairedAt: "2025-01-01T00:00:00.000Z", rolePromptHash: "h", expectedTitle: "Orchestrator" },
      { sessionId: "session-2", position: 2, role: "planner", model: { providerId: "anthropic", modelId: "claude-4" }, agentName: "Planner", projectRoot, projectFingerprint: "fp", serverBaseUrl: "http://127.0.0.1:4096", sessionCreatedAt: "2025-01-01T00:00:00.000Z", pairedAt: "2025-01-01T00:00:00.000Z", rolePromptHash: "h", expectedTitle: "Planner" },
      { sessionId: "session-3", position: 3, role: "builder", model: { providerId: "opencode", modelId: "north" }, agentName: "Builder", projectRoot, projectFingerprint: "fp", serverBaseUrl: "http://127.0.0.1:4096", sessionCreatedAt: "2025-01-01T00:00:00.000Z", pairedAt: "2025-01-01T00:00:00.000Z", rolePromptHash: "h", expectedTitle: "Builder" },
      { sessionId: "session-4", position: 4, role: "reviewer", model: { providerId: "minimax-coding-plan", modelId: "MiniMax-M3" }, agentName: "Reviewer", projectRoot, projectFingerprint: "fp", serverBaseUrl: "http://127.0.0.1:4096", sessionCreatedAt: "2025-01-01T00:00:00.000Z", pairedAt: "2025-01-01T00:00:00.000Z", rolePromptHash: "h", expectedTitle: "Reviewer" },
      { sessionId: "session-5", position: 5, role: "tester", model: { providerId: "local", modelId: "qwen3" }, agentName: "Tester", projectRoot, projectFingerprint: "fp", serverBaseUrl: "http://127.0.0.1:4096", sessionCreatedAt: "2025-01-01T00:00:00.000Z", pairedAt: "2025-01-01T00:00:00.000Z", rolePromptHash: "h", expectedTitle: "Tester" }
    ]
  };
  persistence.saveRoster(roster);
  const adapter = new FakeOpenCodeAdapter(roster.bindings.map((b) => ({ id: b.sessionId, position: b.position, serverBaseUrl: b.serverBaseUrl, projectRoot, model: b.model, title: b.expectedTitle, status: "idle", inFlightToolCalls: 0 })));
  const rosterService = new RosterService(adapter, persistence);
  return { projectRoot, persistence, adapter, roster, rosterService };
}

describe("buildMissionContext", () => {
  it("produces a MissionService and OrchestratorActionIntake bound to the roster", () => {
    const { persistence, adapter, roster, rosterService } = setup();
    const context = buildMissionContext({
      adapter,
      persistence,
      rosterService,
      bindings: createMissionBindings(roster)
    });
    expect(context.missionService).toBeInstanceOf(MissionService);
    expect(context.orchestratorActionIntake).toBeInstanceOf(OrchestratorActionIntake);
    expect(typeof context.consumeCompletedTasks).toBe("function");
  });

  it("rejects missing binding in nextTaskForRole", () => {
    const { persistence, adapter, roster, rosterService } = setup();
    const bindings = createMissionBindings(roster);
    const updatedBindings = { ...bindings, nextTaskForRole: () => { throw new Error("roster drift: missing binding for builder"); } };
    const context = buildMissionContext({ adapter, persistence, rosterService, bindings: updatedBindings });
    expect(context.missionService).toBeInstanceOf(MissionService);
  });
});

describe("createMissionBindings", () => {
  const baseContext = { objective: "ship the release", sourceWorkspaceFingerprint: "fp-intake" };

  it("produces deterministic ids for the same mission", () => {
    const { roster } = setup();
    const a = createMissionBindings(roster);
    const b = createMissionBindings(roster);
    const planner = a.nextTaskForRole("planner", "mission-1", 1, baseContext);
    const planner2 = b.nextTaskForRole("planner", "mission-1", 1, baseContext);
    expect(planner.dispatchKey).toBe(planner2.dispatchKey);
    expect(planner.promptMessageId).toBe(planner2.promptMessageId);
    expect(planner.envelope.missionId).toBe("mission-1");
    expect(planner.envelope.taskId).toBe(planner2.envelope.taskId);
  });

  it("uses the supplied mission id rather than a placeholder", () => {
    const { roster } = setup();
    const bindings = createMissionBindings(roster);
    const task = bindings.nextTaskForRole("builder", "mission-99", 1, {
      ...baseContext,
      plannerEvidence: {
        sourceTaskId: "task-planner",
        planVerdict: "ready",
        implementationSteps: ["step-1"],
        expectedFiles: ["src/foo.ts"],
        validationPlan: ["vitest run"],
        acceptanceCriteria: ["implement plan"],
        summary: "ship it",
        sourceWorkspaceFingerprint: "fp-intake",
        completedAt: new Date().toISOString()
      }
    });
    expect(task.envelope.missionId).toBe("mission-99");
    expect(task.envelope.taskId).toMatch(/^task-[a-f0-9]+$/);
    expect(task.dispatchKey).toMatch(/^dispatch-[a-f0-9]+$/);
    expect(task.promptPayload.kind).toBe("worker_task");
    expect(task.promptPayload.objective).toBe("ship the release");
  });

  it("rejects an empty mission id so a synthetic value cannot be used", () => {
    const { roster } = setup();
    const bindings = createMissionBindings(roster);
    expect(() => bindings.nextTaskForRole("planner", "", 1, baseContext)).toThrow(/mission id/);
    expect(() => bindings.nextDecisionPrompt("", "plan", "task-1")).toThrow(/mission id/);
  });

  it("produces distinct dispatch keys for two different missions", () => {
    const { roster } = setup();
    const bindings = createMissionBindings(roster);
    const plannerEvidence = {
      sourceTaskId: "task-planner",
      planVerdict: "ready" as const,
      implementationSteps: ["step-1"],
      expectedFiles: ["src/foo.ts"],
      validationPlan: ["vitest run"],
      acceptanceCriteria: ["implement plan"],
      summary: "ship it",
      sourceWorkspaceFingerprint: "fp-intake",
      completedAt: new Date().toISOString()
    };
    const a = bindings.nextTaskForRole("builder", "mission-A", 1, { ...baseContext, plannerEvidence });
    const b = bindings.nextTaskForRole("builder", "mission-B", 1, { ...baseContext, plannerEvidence });
    expect(a.dispatchKey).not.toBe(b.dispatchKey);
    expect(a.envelope.taskId).not.toBe(b.envelope.taskId);
    expect(a.promptMessageId).not.toBe(b.promptMessageId);
  });

  it("throws on missing binding", () => {
    const { roster } = setup();
    const bindings = createMissionBindings(roster);
    expect(() => bindings.bind("orchestrator")).not.toThrow();
    expect(() => bindings.nextTaskForRole("planner", "mission-1", 1, baseContext)).not.toThrow();
  });

  it("builds a deterministic orchestrator decision prompt per gate", () => {
    const { roster } = setup();
    const bindings = createMissionBindings(roster);
    for (const gate of ["plan", "builder", "review", "test", "final"] as const) {
      const decision = bindings.nextDecisionPrompt("mission-1", gate, "task-1");
      const again = bindings.nextDecisionPrompt("mission-1", gate, "task-1");
      expect(decision.targetSessionId).toBe("session-1");
      expect(decision.capturedModel).toEqual({ providerId: "openai", modelId: "gpt-5" });
      expect(decision.dispatchKey).toMatch(/^dispatch-/);
      expect(decision.promptMessageId).toMatch(/^orca-decision-/);
      expect(decision.dispatchKey).toBe(again.dispatchKey);
      expect(decision.promptMessageId).toBe(again.promptMessageId);
    }
  });
});

describe("mission context propagation", () => {
  const baseContext = { objective: "ship the release", sourceWorkspaceFingerprint: "fp-intake" };

  it("blocks dispatch when a Builder task lacks planner evidence", () => {
    const { roster } = setup();
    const bindings = createMissionBindings(roster);
    expect(() => bindings.nextTaskForRole("builder", "mission-1", 1, baseContext)).toThrow(/planner evidence/);
  });

  it("blocks dispatch when a Reviewer task lacks Builder evidence", () => {
    const { roster } = setup();
    const bindings = createMissionBindings(roster);
    expect(() => bindings.nextTaskForRole("reviewer", "mission-1", 1, baseContext)).toThrow(/builder evidence/);
  });

  it("blocks dispatch when a Tester task lacks controller check evidence", () => {
    const { roster } = setup();
    const bindings = createMissionBindings(roster);
    expect(() => bindings.nextTaskForRole("tester", "mission-1", 1, baseContext)).toThrow(/controller check evidence/);
  });

  it("blocks dispatch when the objective is empty", () => {
    const { roster } = setup();
    const bindings = createMissionBindings(roster);
    expect(() => bindings.nextTaskForRole("planner", "mission-1", 1, { objective: "  ", sourceWorkspaceFingerprint: "fp-intake" })).toThrow(/objective/);
  });

  it("embeds planner evidence in the Builder prompt payload", () => {
    const { roster } = setup();
    const bindings = createMissionBindings(roster);
    const task = bindings.nextTaskForRole("builder", "mission-1", 1, {
      ...baseContext,
      plannerEvidence: {
        sourceTaskId: "task-planner",
        planVerdict: "ready",
        implementationSteps: ["step-1", "step-2"],
        expectedFiles: ["src/foo.ts"],
        validationPlan: ["vitest run"],
        acceptanceCriteria: ["implement plan"],
        summary: "ship it",
        sourceWorkspaceFingerprint: "fp-intake",
        completedAt: new Date().toISOString()
      }
    });
    expect(task.promptPayload.plannerEvidence).toMatchObject({
      sourceTaskId: "task-planner",
      planVerdict: "ready",
      implementationSteps: ["step-1", "step-2"]
    });
    expect(task.envelope.objective).toContain("ship the release");
    expect(task.envelope.acceptanceCriteria.join("\n")).toContain("Touch expected file: src/foo.ts");
  });

  it("embeds builder evidence in the Reviewer prompt payload", () => {
    const { roster } = setup();
    const bindings = createMissionBindings(roster);
    const task = bindings.nextTaskForRole("reviewer", "mission-1", 1, {
      ...baseContext,
      builderEvidence: {
        sourceTaskId: "task-builder",
        implementationVerdict: "implemented",
        changedFiles: ["src/foo.ts"],
        targetedTestsRun: ["vitest run tests/foo.test.ts"],
        summary: "implemented foo",
        findings: [],
        sourceWorkspaceFingerprint: "fp-intake",
        completedAt: new Date().toISOString()
      }
    });
    expect(task.promptPayload.builderEvidence).toMatchObject({ changedFiles: ["src/foo.ts"] });
    expect(task.envelope.objective).toContain("Builder summary: implemented foo");
  });

  it("embeds controller checks in the Tester prompt payload", () => {
    const { roster } = setup();
    const bindings = createMissionBindings(roster);
    const task = bindings.nextTaskForRole("tester", "mission-1", 1, {
      ...baseContext,
      controllerChecks: {
        configHash: "config-hash",
        testedWorkspaceFingerprint: "fp-intake",
        requiredChecks: ["noop"],
        passedChecks: ["noop"],
        failedChecks: [],
        capturedAt: new Date().toISOString()
      }
    });
    expect(task.promptPayload.controllerChecks).toMatchObject({ requiredChecks: ["noop"] });
    expect(task.envelope.objective).toContain("Controller-generated check evidence");
  });

  it("embeds rejected findings and correction instructions in Builder correction tasks", () => {
    const { roster } = setup();
    const bindings = createMissionBindings(roster);
    const task = bindings.nextTaskForRole("builder", "mission-1", 1, {
      ...baseContext,
      correction: {
        rejectedRole: "reviewer",
        rejectedVerdict: "changes_required",
        rejectedFindings: [
          { severity: "medium", title: "missing test", description: "add a test", blocking: true }
        ],
        correctionInstructions: ["add a regression test for foo"]
      }
    });
    expect(task.promptPayload.correction).toMatchObject({ rejectedRole: "reviewer" });
    expect(task.envelope.objective).toContain("Rejection source: reviewer");
    expect(task.envelope.objective).toContain("missing test");
    expect(task.envelope.objective).toContain("add a regression test for foo");
  });
});
