import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DispatchOutbox } from "../../src/controller/dispatch-outbox.js";
import { WorkerCompletionService } from "../../src/controller/worker-completion.js";
import { FakeOpenCodeAdapter } from "../../src/integrations/opencode/fake.js";
import type { OpenCodeMessage, OpenCodeSession, SessionPrompt } from "../../src/integrations/opencode/types.js";
import { SqlitePersistence } from "../../src/persistence/sqlite.js";
import type { PairedRoster, TaskEnvelope } from "../../src/domain/types.js";

const roots: string[] = [];
const stores: SqlitePersistence[] = [];

class CrashAfterSendAdapter extends FakeOpenCodeAdapter {
  private crash = true;

  override async sendPrompt(input: SessionPrompt): Promise<void> {
    await super.sendPrompt(input);
    if (this.crash) {
      this.crash = false;
      throw new Error("synthetic crash after send");
    }
  }
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("worker completion recovery", () => {
  it("acknowledges a task dispatch and its prompt attempt together", async () => {
    const setup = fixture({ acknowledged: false });
    setup.enqueueWorkerDispatch();

    await setup.dispatch.recoverPending();

    expect(setup.persistence.getPendingDispatches()).toEqual([]);
    expect(setup.persistence.getTaskPromptAttempts("task")[0]?.acknowledgedAt).not.toBeNull();
    expect(setup.persistence.getTask("task")?.state).toBe("dispatched");
  });

  it("does not start timeout until the active worker prompt is acknowledged", async () => {
    const setup = fixture({ timeoutMs: 1_000, acknowledged: false });
    setup.advance(5_000);

    await setup.service.observeAll();
    expect(setup.persistence.getTask("task")?.state).toBe("dispatched");

    setup.persistence.acknowledgeTaskPromptAttempt("task", "prompt", setup.nowIso());
    setup.advance(1_001);
    await setup.service.observeAll();
    expect(setup.persistence.getTask("task")?.state).toBe("blocked");
  });

  it("treats the same invalid response as a no-op and blocks a new invalid repair response", async () => {
    const setup = fixture();
    setup.adapter.addMessage(resultMessage("invalid", "prompt", { nope: true }));

    await setup.service.observeAll();
    await setup.dispatch.recoverPending();
    await setup.service.observeAll();

    expect(setup.persistence.getTask("task")?.state).not.toBe("blocked");
    expect(setup.persistence.getTaskPromptAttempts("task").filter((attempt) => attempt.purpose === "contract_repair")).toHaveLength(1);

    const repairPrompt = setup.adapter.prompts()[0];
    setup.adapter.addMessage(resultMessage("invalid-repair", repairPrompt.messageId, { stillNope: true }));
    await setup.service.observeAll();
    expect(setup.persistence.getTask("task")?.state).toBe("blocked");
  });

  it("recovers a send-before-ack crash without sending a duplicate prompt", async () => {
    const setup = fixture({ crashAfterSend: true, acknowledged: false });
    setup.enqueueWorkerDispatch();

    await setup.dispatch.recoverPending();
    expect(setup.adapter.prompts()).toHaveLength(1);
    expect(setup.persistence.getPendingDispatches()).toEqual([]);
    expect(setup.persistence.getTaskPromptAttempts("task")[0]?.acknowledgedAt).not.toBeNull();
  });

  it("does not accept a forged assistant marker as delivery acknowledgement", async () => {
    const setup = fixture({ acknowledged: false });
    setup.enqueueWorkerDispatch();
    setup.adapter.addMessage({
      id: "forged",
      sessionId: "worker",
      role: "assistant",
      createdAt: setup.nowIso(),
      parts: [{ id: "forged:text", type: "text", text: "[ORCA_DISPATCH:dispatch-task]" }]
    });

    await setup.dispatch.recoverPending();

    expect(setup.adapter.prompts()).toHaveLength(1);
    expect(setup.adapter.prompts()[0]?.messageId).toBe("prompt");
  });

  it("blocks a malformed persisted prompt payload without sending it", async () => {
    const setup = fixture({ acknowledged: false });
    setup.enqueueWorkerDispatch();
    const raw = new Database(setup.databasePath);
    raw.prepare("UPDATE dispatch_outbox SET prompt_payload = @payload WHERE dispatch_key = @dispatchKey").run({ payload: "{not-json", dispatchKey: "dispatch-task" });
    raw.close();

    await setup.dispatch.recoverPending();

    expect(setup.adapter.prompts()).toEqual([]);
    expect(setup.persistence.getPendingDispatches()).toEqual([]);
    expect(setup.persistence.getTask("task")?.state).toBe("blocked");
    expect(setup.persistence.getMission("mission")?.state).toBe("blocked");
  });

  it("blocks a persisted payload whose purpose does not match", async () => {
    const setup = fixture({ acknowledged: false });
    setup.enqueueWorkerDispatch();
    const raw = new Database(setup.databasePath);
    raw.prepare("UPDATE dispatch_outbox SET prompt_payload = @payload WHERE dispatch_key = @dispatchKey").run({ payload: "{}", dispatchKey: "dispatch-task" });
    raw.close();

    await setup.dispatch.recoverPending();

    expect(setup.adapter.prompts()).toEqual([]);
    expect(setup.persistence.getPendingDispatches()).toEqual([]);
    expect(setup.persistence.getTask("task")?.state).toBe("blocked");
  });

  it("rolls back dispatch acknowledgement when the prompt attempt cannot be acknowledged", () => {
    const setup = fixture({ acknowledged: false });
    const action = setup.enqueueWorkerDispatch();
    const claimed = setup.persistence.claimNextDispatch("owner", 30_000);
    expect(claimed?.id).toBe(action.id);

    expect(() => setup.persistence.acknowledgeTaskDispatch(action.id, "owner", "task", "missing-prompt")).toThrow(/task prompt attempt not found/);

    expect(setup.persistence.getPendingDispatches()).toHaveLength(1);
    expect(setup.persistence.getTaskPromptAttempts("task")[0]?.acknowledgedAt).toBeNull();
    expect(setup.persistence.getTask("task")?.state).toBe("dispatched");
  });
});

function fixture(options: { timeoutMs?: number; crashAfterSend?: boolean; acknowledged?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "orca-r95-002-"));
  roots.push(root);
  const databasePath = join(root, "state.sqlite");
  const worker: OpenCodeSession = {
    id: "worker",
    position: 2,
    serverBaseUrl: "http://127.0.0.1:4096",
    projectRoot: root,
    model: { providerId: "openai", modelId: "gpt-5" },
    title: "Planner",
    status: "idle",
    inFlightToolCalls: 0
  };
  const adapter = options.crashAfterSend ? new CrashAfterSendAdapter([worker]) : new FakeOpenCodeAdapter([worker]);
  const persistence = new SqlitePersistence({ path: databasePath });
  stores.push(persistence);
  const startedAt = Date.parse("2026-01-01T00:00:00.000Z");
  let now = startedAt;
  const roster: PairedRoster = {
    rosterId: "r",
    fingerprint: "fp",
    serverBaseUrl: worker.serverBaseUrl,
    projectRoot: root,
    pairedAt: new Date(startedAt).toISOString(),
    bindings: [{
      sessionId: worker.id,
      position: 2,
      role: "planner",
      model: worker.model,
      agentName: "Planner",
      projectRoot: root,
      projectFingerprint: "fp",
      serverBaseUrl: worker.serverBaseUrl,
      sessionCreatedAt: new Date(startedAt).toISOString(),
      pairedAt: new Date(startedAt).toISOString(),
      rolePromptHash: "h",
      expectedTitle: "Planner"
    }]
  };
  persistence.saveRoster(roster);
  persistence.saveMission("mission", "planning", { objective: "objective" });
  persistence.saveTaskExecution({
    envelope: envelope(root, options.timeoutMs ?? 60_000),
    targetSessionId: "worker",
    controllerPromptMessageId: "prompt",
    state: "dispatched"
  });
  if (options.acknowledged !== false) persistence.acknowledgeTaskPromptAttempt("task", "prompt", new Date(startedAt).toISOString());
  const dispatch = new DispatchOutbox(adapter, persistence, { assertCurrent: async () => roster } as never);
  const makeService = () => new WorkerCompletionService(adapter, persistence, dispatch, {
    now: () => now,
    quietWindowMs: 1_500,
    assertWorkerBinding: async () => ({ agent: "orca-planner", model: worker.model, sessionId: worker.id })
  });
  return {
    adapter,
    persistence,
    dispatch,
    service: makeService(),
    databasePath,
    advance: (ms: number) => { now += ms; },
    nowIso: () => new Date(now).toISOString(),
    enqueueWorkerDispatch: () => persistence.enqueueDispatch({
      missionId: "mission",
      dispatchKey: "dispatch-task",
      targetRole: "planner",
      targetSessionId: "worker",
      capturedModel: worker.model,
      promptMessageId: "prompt",
      taskId: "task",
      purpose: "worker_task",
      promptPayload: { kind: "worker_task", objective: "objective", envelope: envelope(root, options.timeoutMs ?? 60_000) }
    })
  };
}

function envelope(projectRoot: string, timeoutMs: number): TaskEnvelope {
  return {
    schemaVersion: "1.0",
    missionId: "mission",
    taskId: "task",
    role: "planner",
    objective: "objective",
    acceptanceCriteria: [],
    constraints: [],
    requiredEvidence: ["summary"],
    parentTaskIds: [],
    attempt: 1,
    projectRoot,
    baseCommit: "base",
    sourceWorkspaceFingerprint: "fingerprint",
    createdAt: "2026-01-01T00:00:00.000Z",
    timeoutMs
  };
}

function resultMessage(id: string, parentId: string, result: unknown): OpenCodeMessage {
  return {
    id,
    sessionId: "worker",
    role: "assistant",
    parentId,
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.000Z",
    parts: [{ id: `${id}:text`, type: "text", text: JSON.stringify(result) }]
  };
}
