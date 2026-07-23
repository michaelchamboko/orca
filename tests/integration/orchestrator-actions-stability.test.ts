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
  const root = mkdtempSync(join(tmpdir(), "orca-r95-003-"));
  roots.push(root);
  const roster = makeRoster();
  const sessions: OpenCodeSession[] = roster.bindings.map((b) => ({ id: b.sessionId, position: b.position, serverBaseUrl: b.serverBaseUrl, projectRoot: root, model: b.model, title: b.expectedTitle, status: "idle", inFlightToolCalls: 0 }));
  const adapter = new FakeOpenCodeAdapter(sessions);
  const persistence = new SqlitePersistence({ path: join(root, "state.sqlite") });
  stores.push(persistence);
  persistence.saveRoster(roster);
  persistence.createMission({ missionId: "mission-1", rosterId: roster.rosterId, objective: "test", sourceSessionMessageId: "source-1", state: "awaiting_plan_approval" });
  return { adapter, persistence, roster, sessions };
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

function assistantMessage(id: string, sessionId: string, parentId: string, text: string, completedAt = "2026-01-01T00:00:00.000Z"): OpenCodeMessage {
  return { id, sessionId, role: "assistant", parentId, createdAt: completedAt, completedAt, parts: [{ id: `${id}:text`, type: "text", text }] };
}

function makeIntake(setupResult: ReturnType<typeof setup>, now: () => number) {
  const consumed: OrchestratorAction[] = [];
  const intake = new OrchestratorActionIntake(setupResult.adapter, setupResult.persistence, {
    getRoster: async () => setupResult.roster,
    resolveDecisionPrompt: async () => ({ missionId: "mission-1", gate: "plan" }),
    consumePendingApproval: async (action) => { consumed.push(action); return "applied"; }
  }, { now });
  setupResult.persistence.recordMissionEvent("mission-1", null, "task.dispatched", { purpose: "orchestrator_decision", promptMessageId: "decision-prompt" });
  return { intake, consumed };
}

describe("orchestrator action stability and recovery", () => {
  it("rejects a non-decision-prompt parent", async () => {
    const ctx = setup();
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const { intake, consumed } = makeIntake(ctx, () => now);
    ctx.adapter.addMessage(assistantMessage("wrong-parent", "session-1", "another-prompt", JSON.stringify(validAction())));
    const outcomes = await intake.observeMessage("session-1", "wrong-parent");
    expect(outcomes[0]?.kind).toBe("rejected");
    expect((outcomes[0] as { reasonCode: string }).reasonCode).toBe("parent_mismatch");
    expect(consumed).toHaveLength(0);
  });

  it("rejects user-authored JSON", async () => {
    const ctx = setup();
    const { intake, consumed } = makeIntake(ctx, () => Date.parse("2026-01-01T00:00:00.000Z"));
    ctx.adapter.addMessage({ id: "user-1", sessionId: "session-1", role: "user", parentId: "decision-prompt", createdAt: "2026-01-01T00:00:00.000Z", parts: [{ id: "user-1:text", type: "text", text: JSON.stringify(validAction()) }] });
    const outcomes = await intake.observeMessage("session-1", "user-1");
    expect((outcomes[0] as { reasonCode: string }).reasonCode).toBe("not_assistant_message");
    expect(consumed).toHaveLength(0);
  });

  it("rejects worker-session JSON even when role is orchestrator", async () => {
    const ctx = setup();
    const { intake, consumed } = makeIntake(ctx, () => Date.parse("2026-01-01T00:00:00.000Z"));
    ctx.adapter.addMessage(assistantMessage("builder-spoof", "session-3", "decision-prompt", JSON.stringify(validAction())));
    const outcomes = await intake.observeMessage("session-3", "builder-spoof");
    expect((outcomes[0] as { reasonCode: string }).reasonCode).toBe("not_orchestrator_session");
    expect(consumed).toHaveLength(0);
  });

  it("rejects a busy Session 1 message and a non-idle tool", async () => {
    const ctx = setup();
    const { intake, consumed } = makeIntake(ctx, () => Date.parse("2026-01-01T00:00:00.000Z"));
    ctx.adapter.replaceSession({ ...ctx.sessions[0], status: "running" });
    ctx.adapter.addMessage(assistantMessage("busy", "session-1", "decision-prompt", JSON.stringify(validAction())));
    const busy = await intake.observeMessage("session-1", "busy");
    expect(busy).toHaveLength(1);
    expect((busy[0] as { reasonCode: string }).reasonCode).toBe("not_idle");
    expect(consumed).toHaveLength(0);

    ctx.adapter.replaceSession({ ...ctx.sessions[0], status: "idle" });
    ctx.adapter.addMessage({ id: "tool-active", sessionId: "session-1", role: "assistant", parentId: "decision-prompt", createdAt: "2026-01-01T00:00:00.000Z", parts: [{ id: "t:text", type: "text", text: JSON.stringify(validAction()) }, { id: "t:tool", type: "tool", toolStatus: "running" }] });
    const tooled = await intake.observeMessage("session-1", "tool-active");
    expect((tooled[0] as { reasonCode: string }).reasonCode).toBe("active_lineage_tool");
    expect(consumed).toHaveLength(0);
  });

  it("resets the 1.5-second window when content or tool state changes", async () => {
    const ctx = setup();
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const { intake, consumed } = makeIntake(ctx, () => now);
    ctx.adapter.addMessage(assistantMessage("approval", "session-1", "decision-prompt", JSON.stringify(validAction()), "2026-01-01T00:00:00.000Z"));
    const first = await intake.observeMessage("session-1", "approval");
    expect(first).toEqual([]);
    now += 1_000;
    ctx.adapter.addMessage(assistantMessage("approval", "session-1", "decision-prompt", JSON.stringify(validAction()), "2026-01-01T00:00:01.000Z"));
    const stillUnstable = await intake.observeMessage("session-1", "approval");
    expect(stillUnstable).toEqual([]);
    now += 1_600;
    const stable = await intake.observeMessage("session-1", "approval");
    expect(stable[0]?.kind).toBe("accepted");
    expect(consumed).toHaveLength(1);
  });

  it("marks accepted actions as consumed and surfaces a duplicate on replay", async () => {
    const ctx = setup();
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const { intake, consumed } = makeIntake(ctx, () => now);
    ctx.adapter.addMessage(assistantMessage("approval", "session-1", "decision-prompt", JSON.stringify(validAction())));
    const first = await intake.observeMessage("session-1", "approval");
    expect(first).toEqual([]);
    now += 1_600;
    const accepted = await intake.observeMessage("session-1", "approval");
    expect(accepted[0]?.kind).toBe("accepted");
    expect(ctx.persistence.getOrchestratorActionMessage("approval")?.accepted).toBe(true);
    expect(consumed).toHaveLength(1);

    now += 1_600;
    const replay = await intake.observeMessage("session-1", "approval");
    expect(replay[0]?.kind).toBe("duplicate");
    expect(consumed).toHaveLength(1);
  });

  it("preserves bounded fields and rejects oversized ones", async () => {
    const ctx = setup();
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const { intake, consumed } = makeIntake(ctx, () => now);
    const huge = "x".repeat(9000);
    const oversized = { ...validAction(), rationale: huge };
    ctx.adapter.addMessage(assistantMessage("oversize", "session-1", "decision-prompt", JSON.stringify(oversized)));
    const rejected = await intake.observeMessage("session-1", "oversize");
    expect((rejected[0] as { reasonCode: string }).reasonCode).toBe("schema_invalid");
    expect(consumed).toHaveLength(0);

    const tooMany = { ...validAction(), correctionInstructions: Array.from({ length: 25 }, () => "x") };
    ctx.adapter.addMessage(assistantMessage("toolong", "session-1", "decision-prompt", JSON.stringify(tooMany)));
    const rejected2 = await intake.observeMessage("session-1", "toolong");
    expect((rejected2[0] as { reasonCode: string }).reasonCode).toBe("schema_invalid");
    expect(consumed).toHaveLength(0);
  });
});
