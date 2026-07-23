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
      bindings: createMissionBindings(roster, "mission-1")
    });
    expect(context.missionService).toBeInstanceOf(MissionService);
    expect(context.orchestratorActionIntake).toBeInstanceOf(OrchestratorActionIntake);
    expect(typeof context.consumeCompletedTasks).toBe("function");
  });

  it("rejects missing binding in nextTaskForRole", () => {
    const { persistence, adapter, roster, rosterService } = setup();
    const bindings = createMissionBindings(roster, "mission-1");
    const updatedBindings = { ...bindings, nextTaskForRole: () => { throw new Error("roster drift: missing binding for builder"); } };
    const context = buildMissionContext({ adapter, persistence, rosterService, bindings: updatedBindings });
    expect(context.missionService).toBeInstanceOf(MissionService);
  });
});

describe("createMissionBindings", () => {
  it("produces deterministic ids for the same mission", () => {
    const { roster } = setup();
    const a = createMissionBindings(roster, "mission-1");
    const b = createMissionBindings(roster, "mission-1");
    const planner = a.nextTaskForRole("planner", 1);
    const planner2 = b.nextTaskForRole("planner", 1);
    expect(planner.dispatchKey).toBe(planner2.dispatchKey);
  });

  it("throws on missing binding", () => {
    const { roster } = setup();
    const bindings = createMissionBindings(roster, "mission-1");
    expect(() => bindings.bind("orchestrator")).not.toThrow();
    expect(() => bindings.nextTaskForRole("planner", 1)).not.toThrow();
  });

  it("builds an orchestrator decision prompt for each gate", () => {
    const { roster } = setup();
    const bindings = createMissionBindings(roster, "mission-1");
    for (const gate of ["plan", "builder", "review", "test", "final"] as const) {
      const decision = bindings.nextDecisionPrompt("mission-1", gate, "task-1");
      expect(decision.targetSessionId).toBe("session-1");
      expect(decision.capturedModel).toEqual({ providerId: "openai", modelId: "gpt-5" });
      expect(decision.dispatchKey).toMatch(/^dispatch-/);
      expect(decision.promptMessageId).toMatch(/^orca-decision-/);
    }
  });
});