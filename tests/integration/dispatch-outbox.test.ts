import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqlitePersistence } from "../../src/persistence/sqlite.js";
import type { DispatchOutboxAction, DispatchPurpose } from "../../src/persistence/sqlite.js";
import type { PairedRoster, Role, RoleWorkerResult, TaskEnvelope } from "../../src/domain/types.js";

const roots: string[] = [];
const stores: SqlitePersistence[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoster(): PairedRoster {
  const roles: Role[] = ["orchestrator", "planner", "builder", "reviewer", "tester"];
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

function makeEnvelope(taskId: string, role: Exclude<Role, "orchestrator">): TaskEnvelope {
  return {
    schemaVersion: "1.0",
    missionId: "mission-1",
    taskId,
    role,
    objective: `${role} objective`,
    acceptanceCriteria: [],
    constraints: [],
    requiredEvidence: ["summary"],
    parentTaskIds: [],
    attempt: 1,
    projectRoot: "C:/workspace/orca",
    baseCommit: "0000000",
    sourceWorkspaceFingerprint: "fingerprint",
    createdAt: new Date().toISOString(),
    timeoutMs: 60_000
  };
}

function samplePlannerResult(taskId: string): RoleWorkerResult {
  return {
    schemaVersion: "1.0",
    missionId: "mission-1",
    taskId,
    role: "planner",
    status: "completed",
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
    planVerdict: "ready",
    implementationSteps: [],
    expectedFiles: [],
    validationPlan: []
  };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "orca-dispatch-outbox-"));
  roots.push(root);
  const persistence = new SqlitePersistence({ path: join(root, "state.sqlite") });
  stores.push(persistence);
  persistence.saveRoster(makeRoster());
  persistence.createMission({ missionId: "mission-1", rosterId: "roster-1", objective: "test", sourceSessionMessageId: "source-1", state: "planning" });
  const plannerEnvelope = makeEnvelope("task-1", "planner");
  const builderEnvelope = makeEnvelope("task-2", "builder");
  persistence.saveTaskExecution({ envelope: plannerEnvelope, targetSessionId: "session-2", controllerPromptMessageId: "orca-prompt-1" });
  persistence.saveTaskExecution({ envelope: builderEnvelope, targetSessionId: "session-3", controllerPromptMessageId: "orca-prompt-builder-1" });
  return { persistence };
}

describe("dispatch outbox contract", () => {
  it("persists every purpose with target, role, model, parent, and payload", () => {
    const { persistence } = setup();
    const purposes: Array<{ purpose: DispatchPurpose; targetRole: Role; session: string; promptId: string; parent: string | null; taskId: string | null; key: string; payload: Record<string, unknown> }> = [
      { purpose: "worker_task", targetRole: "planner", session: "session-2", promptId: "orca-prompt-1", parent: null, taskId: "task-1", key: "dispatch-worker", payload: { kind: "worker_task", envelope: makeEnvelope("task-1", "planner") } },
      { purpose: "contract_repair", targetRole: "builder", session: "session-3", promptId: "orca-repair-1", parent: "orca-prompt-builder-1", taskId: "task-2", key: "dispatch-repair", payload: { kind: "contract_repair", contract: "worker_result", envelope: makeEnvelope("task-2", "builder"), originalPromptMessageId: "orca-prompt-builder-1" } },
      { purpose: "orchestrator_decision", targetRole: "orchestrator", session: "session-1", promptId: "orca-decision-1", parent: null, taskId: "task-1", key: "dispatch-decision", payload: { kind: "orchestrator_decision", missionId: "mission-1", taskId: "task-1", gate: "plan", result: samplePlannerResult("task-1") } },
      { purpose: "final_completion", targetRole: "orchestrator", session: "session-1", promptId: "orca-final-1", parent: null, taskId: null, key: "dispatch-final", payload: { kind: "final_completion", missionId: "mission-1" } },
      { purpose: "status_notice", targetRole: "orchestrator", session: "session-1", promptId: "orca-status-1", parent: null, taskId: null, key: "dispatch-status", payload: { kind: "status_notice", missionId: "mission-1", code: "blocked", message: "blocked" } }
    ];
    for (const entry of purposes) {
      persistence.enqueueDispatch({
        missionId: "mission-1",
        dispatchKey: entry.key,
        targetRole: entry.targetRole,
        targetSessionId: entry.session,
        capturedModel: { providerId: "openai", modelId: "gpt-5" },
        promptMessageId: entry.promptId,
        taskId: entry.taskId,
        purpose: entry.purpose,
        parentPromptMessageId: entry.parent,
        promptPayload: entry.payload
      });
    }

    for (const entry of purposes) {
      const found = persistence.getDispatchByPromptMessageId(entry.promptId);
      expect(found, `purpose ${entry.purpose}`).not.toBeNull();
      expect(found?.purpose).toBe(entry.purpose);
      expect(found?.targetRole).toBe(entry.targetRole);
      expect(found?.targetSessionId).toBe(entry.session);
      expect(found?.parentPromptMessageId).toBe(entry.parent);
      expect(found?.taskId).toBe(entry.taskId);
      expect(found?.promptPayload).toMatchObject({ kind: entry.purpose });
    }
  });

  it("rejects duplicate prompt_message_id enqueues", () => {
    const { persistence } = setup();
    persistence.enqueueDispatch({ missionId: "mission-1", dispatchKey: "dispatch-a", targetRole: "planner", targetSessionId: "session-2", capturedModel: { providerId: "openai", modelId: "gpt-5" }, promptMessageId: "orca-prompt-x" });
    expect(() => persistence.enqueueDispatch({ missionId: "mission-1", dispatchKey: "dispatch-b", targetRole: "planner", targetSessionId: "session-2", capturedModel: { providerId: "openai", modelId: "gpt-5" }, promptMessageId: "orca-prompt-x" })).toThrow();
  });

  it("preserves five heterogeneous models across all purposes", () => {
    const { persistence } = setup();
    const targets: Array<{ role: Role; session: string; model: { providerId: string; modelId: string }; key: string; prompt: string }> = [
      { role: "orchestrator", session: "session-1", model: { providerId: "anthropic", modelId: "opus-4" }, key: "k-1", prompt: "p-1" },
      { role: "planner", session: "session-2", model: { providerId: "openai", modelId: "gpt-5" }, key: "k-2", prompt: "p-2" },
      { role: "builder", session: "session-3", model: { providerId: "google", modelId: "gemini-2" }, key: "k-3", prompt: "p-3" },
      { role: "reviewer", session: "session-4", model: { providerId: "minimax", modelId: "minimax-m3" }, key: "k-4", prompt: "p-4" },
      { role: "tester", session: "session-5", model: { providerId: "mistral", modelId: "mistral-large" }, key: "k-5", prompt: "p-5" }
    ];
    for (const target of targets) {
      const action: DispatchOutboxAction = persistence.enqueueDispatch({
        missionId: "mission-1",
        dispatchKey: target.key,
        targetRole: target.role,
        targetSessionId: target.session,
        capturedModel: target.model,
        promptMessageId: target.prompt
      });
      expect(action.capturedModel).toEqual(target.model);
      const fetched = persistence.getDispatchByPromptMessageId(target.prompt);
      expect(fetched?.capturedModel).toEqual(target.model);
    }
  });

  it("records orchestrator decision responses with reason codes", () => {
    const { persistence } = setup();
    const accepted = persistence.recordOrchestratorDecisionResponse({ missionId: "mission-1", decisionPromptMessageId: "decision-1", responseMessageId: "response-1", responseHash: "hash-1", outcome: "accepted", reasonCode: null, taskId: "task-1", action: "approve" });
    expect(accepted.id).toBeGreaterThan(0);

    expect(() => persistence.recordOrchestratorDecisionResponse({ missionId: "mission-1", decisionPromptMessageId: "decision-1", responseMessageId: "response-1", responseHash: "hash-1", outcome: "accepted", reasonCode: null, taskId: "task-1", action: "approve" })).not.toThrow();

    const rejected = persistence.recordOrchestratorDecisionResponse({ missionId: "mission-1", decisionPromptMessageId: "decision-1", responseMessageId: "response-2", responseHash: "hash-2", outcome: "rejected", reasonCode: "wrong_parent", taskId: null, action: null });
    expect(rejected.id).toBeGreaterThan(0);

    const responses = persistence.getOrchestratorDecisionResponses("mission-1");
    expect(responses).toHaveLength(2);
    expect(responses.find((response) => response.responseMessageId === "response-2")?.reasonCode).toBe("wrong_parent");
  });
});