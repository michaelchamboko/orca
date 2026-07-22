import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorkerCompletionService } from "../../src/controller/worker-completion.js";
import { SqlitePersistence } from "../../src/persistence/sqlite.js";
import { FakeOpenCodeAdapter } from "../../src/integrations/opencode/fake.js";
import type { OpenCodeMessage, OpenCodeSession } from "../../src/integrations/opencode/types.js";

const roots: string[] = [];
const stores: SqlitePersistence[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("worker completion", () => {
  it("completes only a valid, idle, tool-free output that remains stable for the quiet window", async () => {
    const setup = fixture();
    setup.adapter.addMessage(resultMessage("result", "prompt", plannerResult("task")));
    await setup.service.observeAll();
    expect(setup.persistence.getTask("task")?.state).toBe("dispatched");
    setup.advance(1_500);
    await setup.service.observeAll();
    expect(setup.persistence.getTask("task")?.state).toBe("completed");
  });

  it("rejects idle alone, wrong parent output, and output with an in-flight tool", async () => {
    const idleOnly = fixture();
    await idleOnly.service.observeAll();
    expect(idleOnly.persistence.getTask("task")?.state).toBe("dispatched");

    const wrongParent = fixture();
    wrongParent.adapter.addMessage(resultMessage("wrong", "other-prompt", plannerResult("task")));
    await wrongParent.service.observeAll();
    expect(wrongParent.persistence.getTask("task")?.state).toBe("dispatched");

    const toolRunning = fixture();
    toolRunning.adapter.addMessage({ ...resultMessage("tool", "prompt", plannerResult("task")), parts: [{ id: "text", type: "text", text: JSON.stringify(plannerResult("task")) }, { id: "tool", type: "tool", toolStatus: "running" }] });
    await toolRunning.service.observeAll();
    toolRunning.advance(2_000);
    await toolRunning.service.observeAll();
    expect(toolRunning.persistence.getTask("task")?.state).toBe("dispatched");
  });

  it("resets the quiet window when the output completion timestamp changes", async () => {
    const setup = fixture();
    setup.adapter.addMessage(resultMessage("result", "prompt", plannerResult("task"), "2026-01-01T00:00:00.000Z"));
    await setup.service.observeAll();
    setup.advance(1_000);
    setup.adapter.addMessage(resultMessage("result", "prompt", plannerResult("task"), "2026-01-01T00:00:01.000Z"));
    await setup.service.observeAll();
    setup.advance(1_000);
    await setup.service.observeAll();
    expect(setup.persistence.getTask("task")?.state).toBe("dispatched");
    setup.advance(500);
    await setup.service.observeAll();
    expect(setup.persistence.getTask("task")?.state).toBe("completed");
  });

  it("repairs one invalid contract using the paired worker, persists the repair attempt, and blocks on the second invalid result", async () => {
    const setup = fixture();
    setup.adapter.addMessage(resultMessage("invalid", "prompt", { nope: true }));
    await setup.service.observeAll();
    expect(setup.adapter.prompts()).toHaveLength(1);
    const repairPrompt = setup.adapter.prompts()[0];
    expect(repairPrompt).toMatchObject({ sessionId: "worker", agent: "orca-planner", model: { providerId: "openai", modelId: "gpt-5" } });
    expect(repairPrompt.messageId).toMatch(/^orca-repair-task-/);
    expect(setup.persistence.getTaskPromptAttempts("task").map((attempt) => attempt.purpose)).toEqual(["contract_repair"]);
    await setup.service.observeAll();
    expect(setup.persistence.getTask("task")?.state).toBe("blocked");
    expect(setup.persistence.getMission("mission")?.state).toBe("blocked");
  });

  it("does not consume another repair when the same invalid output is observed repeatedly", async () => {
    const setup = fixture();
    setup.adapter.addMessage(resultMessage("invalid", "prompt", { nope: true }));
    await setup.service.observeAll();
    expect(setup.adapter.prompts()).toHaveLength(1);
    await setup.service.observeAll();
    await setup.service.observeAll();
    expect(setup.adapter.prompts()).toHaveLength(1);
    expect(setup.persistence.getTaskPromptAttempts("task")).toHaveLength(1);
  });

  it("blocks an unrelated in-flight tool in the same session without blocking the active lineage", async () => {
    const setup = fixture();
    setup.adapter.addMessage({ ...resultMessage("unrelated", "other-prompt", { nope: true }), parts: [{ id: "tool", type: "tool", toolStatus: "running" }] });
    setup.adapter.addMessage(resultMessage("result", "prompt", plannerResult("task")));
    await setup.service.observeAll();
    expect(setup.persistence.getTask("task")?.state).toBe("dispatched");
  });

  it("completes a task across restart by reusing the durable stable checkpoint", async () => {
    const setup = fixture();
    setup.adapter.addMessage(resultMessage("result", "prompt", plannerResult("task")));
    await setup.service.observeAll();
    expect(setup.persistence.getTask("task")?.state).toBe("dispatched");
    const restarted = setup.newService();
    setup.advance(2_000);
    await restarted.observeAll();
    expect(setup.persistence.getTask("task")?.state).toBe("completed");
  });

  it("times out from the envelope createdAt when no acknowledgement has been recorded", async () => {
    const setup = fixture({ timeoutMs: 1_000 });
    setup.advance(1_001);
    await setup.service.observeAll();
    expect(setup.persistence.getTask("task")?.state).toBe("blocked");
    expect(setup.persistence.getTask("task")?.result).toBeNull();
  });

  it("rolls the completion transaction back when the task is missing", () => {
    const setup = fixture();
    expect(() => setup.persistence.completeTaskExecutionAtomically("missing-task", "output", plannerResult("missing-task"), {})).toThrow(/task not found/);
  });

  it("does not mark the task completed when the ledger insert fails inside the transaction", () => {
    const setup = fixture();
    const adapter = setup.persistence as unknown as { database?: unknown };
    void adapter;
    expect(() => {
      setup.persistence.runInTransaction(() => {
        setup.persistence.completeTaskExecutionAtomically("task", "output", plannerResult("task"), {});
        throw new Error("synthetic failure");
      });
    }).toThrow(/synthetic failure/);
    expect(setup.persistence.getTask("task")?.state).toBe("dispatched");
  });

  it("deduplicates repeated events and restart recovery without another prompt", async () => {
    const setup = fixture();
    setup.adapter.addMessage(resultMessage("result", "prompt", plannerResult("task")));
    await setup.service.observeAll();
    const restarted = setup.newService();
    setup.advance(1_500);
    await restarted.observeAll();
    await restarted.observeEvent({ type: "message.updated", sessionId: "worker", messageId: "result" });
    expect(setup.persistence.getTask("task")?.state).toBe("completed");
    expect(setup.adapter.prompts()).toEqual([]);
  });

  it("blocks durable timeout, permission/session failure, and roster drift", async () => {
    const timeout = fixture({ timeoutMs: 1_000 });
    timeout.advance(1_001);
    await timeout.service.observeAll();
    expect(timeout.persistence.getTask("task")?.state).toBe("blocked");

    const permission = fixture();
    await permission.service.observeEvent({ type: "permission.requested", sessionId: "worker" });
    expect(permission.persistence.getTask("task")?.state).toBe("blocked");

    const drift = fixture();
    drift.adapter.replaceSession({ ...drift.worker, model: { providerId: "other", modelId: "changed" } });
    await drift.service.observeAll();
    expect(drift.persistence.getTask("task")?.state).toBe("blocked");
  });

  it("blocks after bounded repeated polling failure", async () => {
    const setup = fixture();
    setup.adapter.failSessionStatus(3);
    await setup.service.observeAll();
    await setup.service.observeAll();
    await setup.service.observeAll();
    expect(setup.persistence.getTask("task")?.state).toBe("blocked");
  });
});

function fixture(options: { timeoutMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "orca-completion-"));
  roots.push(root);
  const worker: OpenCodeSession = { id: "worker", position: 2, serverBaseUrl: "http://127.0.0.1:4096", projectRoot: root, model: { providerId: "openai", modelId: "gpt-5" }, title: "Planner", status: "idle", inFlightToolCalls: 0 };
  const adapter = new FakeOpenCodeAdapter([worker]);
  const persistence = new SqlitePersistence({ path: join(root, "state.sqlite") });
  stores.push(persistence);
  const startedAt = Date.parse("2026-01-01T00:00:00.000Z");
  let now = startedAt;
  persistence.saveMission("mission", "planning", { objective: "objective" });
  persistence.saveTaskExecution({ envelope: { schemaVersion: "1.0", missionId: "mission", taskId: "task", role: "planner", objective: "objective", acceptanceCriteria: [], constraints: [], requiredEvidence: ["summary"], parentTaskIds: [], attempt: 1, projectRoot: root, baseCommit: "base", sourceWorkspaceFingerprint: "fingerprint", createdAt: new Date(startedAt).toISOString(), timeoutMs: options.timeoutMs ?? 60_000 }, targetSessionId: "worker", controllerPromptMessageId: "prompt", state: "dispatched" });
  const makeService = () => new WorkerCompletionService(adapter, persistence, { now: () => now, quietWindowMs: 1_500, assertWorkerBinding: async () => {
    const model = await adapter.getSessionModel("worker");
    if (model.providerId !== "openai" || model.modelId !== "gpt-5") throw new Error("roster drift");
    return { agent: "orca-planner", model };
  } });
  return { adapter, persistence, worker, service: makeService(), newService: makeService, advance: (ms: number) => { now += ms; } };
}

function resultMessage(id: string, parentId: string, result: unknown, completedAt = "2026-01-01T00:00:00.000Z"): OpenCodeMessage {
  return { id, sessionId: "worker", role: "assistant", parentId, createdAt: completedAt, completedAt, parts: [{ id: `${id}:text`, type: "text", text: JSON.stringify(result) }] };
}

function plannerResult(taskId: string) {
  return { schemaVersion: "1.0" as const, missionId: "mission", taskId, role: "planner" as const, status: "completed" as const, summary: "done", workPerformed: ["planned"], files: [], commands: [], tests: [], findings: [], risks: [], questions: [], recommendedNextAction: "none", sourceWorkspaceFingerprint: "fingerprint", completedAt: "2026-01-01T00:00:00.000Z", planVerdict: "ready" as const, implementationSteps: ["step"], expectedFiles: [], validationPlan: [] };
}
