import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OrchestratorActionIntake } from "../../src/controller/orchestrator-actions.js";
import { SqlitePersistence } from "../../src/persistence/sqlite.js";
import { FakeOpenCodeAdapter } from "../../src/integrations/opencode/fake.js";
import type { OpenCodeMessage, OpenCodeSession } from "../../src/integrations/opencode/types.js";
import type { PairedRoster } from "../../src/domain/types.js";
import type { OrchestratorAction } from "../../src/domain/action-schemas.js";

const roots: string[] = [];
const stores: SqlitePersistence[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoster(): PairedRoster {
  return {
    rosterId: "roster-1",
    fingerprint: "roster-fingerprint",
    serverBaseUrl: "http://127.0.0.1:4096",
    projectRoot: "C:/workspace/orca",
    pairedAt: "2025-01-01T00:00:00.000Z",
    bindings: [
      { sessionId: "session-1", position: 1, role: "orchestrator", model: { providerId: "anthropic", modelId: "opus-4" }, agentName: "Orchestrator", projectRoot: "C:/workspace/orca", projectFingerprint: "fp", serverBaseUrl: "http://127.0.0.1:4096", sessionCreatedAt: "2025-01-01T00:00:00.000Z", pairedAt: "2025-01-01T00:00:00.000Z", rolePromptHash: "h", expectedTitle: "Orchestrator" },
      { sessionId: "session-2", position: 2, role: "planner", model: { providerId: "openai", modelId: "gpt-5" }, agentName: "Planner", projectRoot: "C:/workspace/orca", projectFingerprint: "fp", serverBaseUrl: "http://127.0.0.1:4096", sessionCreatedAt: "2025-01-01T00:00:00.000Z", pairedAt: "2025-01-01T00:00:00.000Z", rolePromptHash: "h", expectedTitle: "Planner" },
      { sessionId: "session-3", position: 3, role: "builder", model: { providerId: "google", modelId: "gemini-2" }, agentName: "Builder", projectRoot: "C:/workspace/orca", projectFingerprint: "fp", serverBaseUrl: "http://127.0.0.1:4096", sessionCreatedAt: "2025-01-01T00:00:00.000Z", pairedAt: "2025-01-01T00:00:00.000Z", rolePromptHash: "h", expectedTitle: "Builder" },
      { sessionId: "session-4", position: 4, role: "reviewer", model: { providerId: "minimax", modelId: "minimax-m3" }, agentName: "Reviewer", projectRoot: "C:/workspace/orca", projectFingerprint: "fp", serverBaseUrl: "http://127.0.0.1:4096", sessionCreatedAt: "2025-01-01T00:00:00.000Z", pairedAt: "2025-01-01T00:00:00.000Z", rolePromptHash: "h", expectedTitle: "Reviewer" },
      { sessionId: "session-5", position: 5, role: "tester", model: { providerId: "mistral", modelId: "mistral-large" }, agentName: "Tester", projectRoot: "C:/workspace/orca", projectFingerprint: "fp", serverBaseUrl: "http://127.0.0.1:4096", sessionCreatedAt: "2025-01-01T00:00:00.000Z", pairedAt: "2025-01-01T00:00:00.000Z", rolePromptHash: "h", expectedTitle: "Tester" }
    ]
  };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "orca-actions-"));
  roots.push(root);
  const roster = makeRoster();
  const sessions: OpenCodeSession[] = roster.bindings.map((b) => ({ id: b.sessionId, position: b.position, serverBaseUrl: b.serverBaseUrl, projectRoot: root, model: b.model, title: b.expectedTitle, status: "idle", inFlightToolCalls: 0 }));
  const adapter = new FakeOpenCodeAdapter(sessions);
  const persistence = new SqlitePersistence({ path: join(root, "state.sqlite") });
  stores.push(persistence);
  persistence.saveRoster(roster);
  persistence.createMission({ missionId: "mission-1", rosterId: roster.rosterId, objective: "test", sourceSessionMessageId: "source-1", state: "awaiting_plan_approval" });
  return { adapter, persistence, roster };
}

function validAction(overrides: Partial<OrchestratorAction> = {}): OrchestratorAction {
  return {
    schemaVersion: "1.0",
    missionId: "mission-1",
    action: "approve",
    taskId: "task-1",
    rationale: "looks good",
    correctionInstructions: [],
    ...overrides
  };
}

function assistantMessage(id: string, sessionId: string, parentId: string, text: string): OpenCodeMessage {
  return { id, sessionId, role: "assistant", parentId, createdAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:00.000Z", parts: [{ id: `${id}:text`, type: "text", text }] };
}

describe("orchestrator action intake", () => {
  it("rejects user messages", async () => {
    const { adapter, persistence, roster } = setup();
    persistence.recordMissionEvent("mission-1", null, "task.dispatched", { purpose: "orchestrator_decision", promptMessageId: "decision-prompt" });
    const consumed: OrchestratorAction[] = [];
    const intake = new OrchestratorActionIntake(adapter, persistence, {
      getRoster: async () => roster,
      resolveDecisionPrompt: async () => ({ missionId: "mission-1", gate: "plan" }),
      consumePendingApproval: async (action) => { consumed.push(action); return "applied"; }
    });
    adapter.addMessage({ id: "user-1", sessionId: "session-1", role: "user", parentId: "decision-prompt", createdAt: "2026-01-01T00:00:00.000Z", parts: [{ id: "user-1:text", type: "text", text: JSON.stringify(validAction()) }] });
    const outcomes = await intake.observeMessage("session-1", "user-1");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.kind).toBe("rejected");
    expect((outcomes[0] as { reasonCode: string }).reasonCode).toBe("not_assistant_message");
    expect(consumed).toHaveLength(0);
  });

  it("rejects messages from worker sessions even with valid JSON", async () => {
    const { adapter, persistence, roster } = setup();
    const consumed: OrchestratorAction[] = [];
    const intake = new OrchestratorActionIntake(adapter, persistence, {
      getRoster: async () => roster,
      resolveDecisionPrompt: async () => ({ missionId: "mission-1", gate: "plan" }),
      consumePendingApproval: async (action) => { consumed.push(action); return "applied"; }
    });
    adapter.addMessage(assistantMessage("builder-spoof", "session-3", "decision-prompt", JSON.stringify(validAction())));
    const outcomes = await intake.observeMessage("session-3", "builder-spoof");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.kind).toBe("rejected");
    expect((outcomes[0] as { reasonCode: string }).reasonCode).toBe("not_orchestrator_session");
    expect(consumed).toHaveLength(0);
  });

  it("rejects messages whose parent is not the active decision prompt", async () => {
    const { adapter, persistence, roster } = setup();
    persistence.recordMissionEvent("mission-1", null, "task.dispatched", { purpose: "orchestrator_decision", promptMessageId: "decision-prompt" });
    const consumed: OrchestratorAction[] = [];
    const intake = new OrchestratorActionIntake(adapter, persistence, {
      getRoster: async () => roster,
      resolveDecisionPrompt: async () => ({ missionId: "mission-1", gate: "plan" }),
      consumePendingApproval: async (action) => { consumed.push(action); return "applied"; }
    });
    adapter.addMessage(assistantMessage("wrong-parent", "session-1", "some-other-prompt", JSON.stringify(validAction())));
    const outcomes = await intake.observeMessage("session-1", "wrong-parent");
    expect(outcomes[0]?.kind).toBe("rejected");
    expect((outcomes[0] as { reasonCode: string }).reasonCode).toBe("parent_mismatch");
    expect(consumed).toHaveLength(0);
  });

  it("accepts a stable correlated Session 1 approval", async () => {
    const { adapter, persistence, roster } = setup();
    persistence.recordMissionEvent("mission-1", null, "task.dispatched", { purpose: "orchestrator_decision", promptMessageId: "decision-prompt" });
    const consumed: OrchestratorAction[] = [];
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const intake = new OrchestratorActionIntake(adapter, persistence, {
      getRoster: async () => roster,
      resolveDecisionPrompt: async () => ({ missionId: "mission-1", gate: "plan" }),
      consumePendingApproval: async (action, messageId, decisionPromptMessageId) => { consumed.push(action); expect(decisionPromptMessageId).toBe("decision-prompt"); return "applied"; }
    }, { now: () => now });
    adapter.addMessage(assistantMessage("approval", "session-1", "decision-prompt", JSON.stringify(validAction())));
    const firstObservation = await intake.observeMessage("session-1", "approval");
    expect(firstObservation).toHaveLength(0);
    now += 1_600;
    const secondObservation = await intake.observeMessage("session-1", "approval");
    expect(secondObservation).toHaveLength(1);
    expect(secondObservation[0]?.kind).toBe("accepted");
    expect(consumed).toHaveLength(1);
  });

  it("deduplicates repeated observation of the same stable response", async () => {
    const { adapter, persistence, roster } = setup();
    persistence.recordMissionEvent("mission-1", null, "task.dispatched", { purpose: "orchestrator_decision", promptMessageId: "decision-prompt" });
    persistence.recordOrchestratorActionMessage({ missionId: "mission-1", messageId: "approval", sessionId: "session-1", parentMessageId: "decision-prompt", decisionPromptMessageId: "decision-prompt", rawPayload: "{}", parsedPayload: {}, action: "approve", taskId: null });
    const consumed: OrchestratorAction[] = [];
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const intake = new OrchestratorActionIntake(adapter, persistence, {
      getRoster: async () => roster,
      resolveDecisionPrompt: async () => ({ missionId: "mission-1", gate: "plan" }),
      consumePendingApproval: async (action) => { consumed.push(action); return "applied"; }
    }, { now: () => now });
    adapter.addMessage(assistantMessage("approval", "session-1", "decision-prompt", JSON.stringify(validAction())));
    now += 1_600;
    await intake.observeMessage("session-1", "approval");
    now += 1_600;
    const outcomes = await intake.observeMessage("session-1", "approval");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.kind).toBe("duplicate");
    expect(consumed).toHaveLength(0);
  });

  it("rejects busy or active-tool responses", async () => {
    const { adapter, persistence, roster } = setup();
    persistence.recordMissionEvent("mission-1", null, "task.dispatched", { purpose: "orchestrator_decision", promptMessageId: "decision-prompt" });
    adapter.addMessage({ id: "tool-active", sessionId: "session-1", role: "assistant", parentId: "decision-prompt", createdAt: "2026-01-01T00:00:00.000Z", parts: [{ id: "t:text", type: "text", text: JSON.stringify(validAction()) }, { id: "t:tool", type: "tool", toolStatus: "running" }] });
    const intake = new OrchestratorActionIntake(adapter, persistence, {
      getRoster: async () => roster,
      resolveDecisionPrompt: async () => ({ missionId: "mission-1", gate: "plan" }),
      consumePendingApproval: async () => "applied"
    });
    const outcomes = await intake.observeMessage("session-1", "tool-active");
    expect(outcomes[0]?.kind).toBe("rejected");
    expect((outcomes[0] as { reasonCode: string }).reasonCode).toBe("active_lineage_tool");
  });
});