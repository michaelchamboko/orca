import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startController } from "../../src/controller/main.js";
import { SqlitePersistence } from "../../src/persistence/sqlite.js";
import { FakeOpenCodeAdapter } from "../../src/integrations/opencode/fake.js";
import { RosterService } from "../../src/pairing/roster-service.js";
import { renderRoleProfile } from "../../src/roles/installer.js";
import { roleProfiles } from "../../src/roles/profiles.js";
import type { TaskEnvelope } from "../../src/domain/types.js";
import { stableId } from "../../src/controller/mission-ingress.js";

const workspaces: string[] = [];
const controllers: Array<{ stop(): Promise<void> }> = [];
const persistences: SqlitePersistence[] = [];

afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.stop()));
  for (const persistence of persistences.splice(0)) persistence.close();
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

describe("Planner mission ingress", () => {
  it("ignores historical messages and dispatches one new orchestrator mission exactly once", async () => {
    const setup = await controllerSetup();
    await setup.rosterService.pair();
    setup.adapter.addMessage(message("historical", "session-1", "2026-07-20T00:00:00.000Z", "old objective"));

    const controller = await startController(setup.options);
    controllers.push(controller);
    setup.adapter.addMessage(message("new-objective", "session-1", new Date().toISOString(), "Plan the release"));
    setup.adapter.emit({ type: "message.updated", sessionId: "session-1", messageId: "new-objective" });
    await eventually(() => expect(setup.adapter.prompts()).toHaveLength(1));

    const prompts = setup.adapter.prompts();
    expect(setup.persistence.getMissionCount()).toBe(1);
    expect(setup.persistence.getTaskCount()).toBe(1);
    expect(setup.persistence.getPendingDispatches()).toEqual([]);
    expect(prompts[0]).toMatchObject({ sessionId: "session-2", agent: "orca-planner", model: { providerId: "openai", modelId: "gpt-5" } });
    expect(prompts[0].messageId).toMatch(/^orca-prompt-/);
    expect(prompts[0].content).toContain("[ORCA_DISPATCH:");
    expect(prompts[0].content).toContain("Plan the release");

    setup.adapter.emit({ type: "message.updated", sessionId: "session-1", messageId: "new-objective" });
    await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
    expect(setup.persistence.getMissionCount()).toBe(1);
    expect(setup.adapter.prompts()).toHaveLength(1);
  });

  it("does not create a mission from worker or assistant messages and rejects a second active objective", async () => {
    const setup = await controllerSetup();
    await setup.rosterService.pair();
    const controller = await startController(setup.options);
    controllers.push(controller);

    setup.adapter.addMessage(message("worker-user", "session-3", new Date().toISOString(), "do work"));
    setup.adapter.addMessage(message("assistant", "session-1", new Date().toISOString(), "assistant reply", "assistant"));
    setup.adapter.emit({ type: "message.updated", sessionId: "session-3", messageId: "worker-user" });
    setup.adapter.emit({ type: "message.updated", sessionId: "session-1", messageId: "assistant" });
    await new Promise((resolve) => globalThis.setTimeout(resolve, 25));
    expect(setup.persistence.getMissionCount()).toBe(0);

    setup.adapter.addMessage(message("first", "session-1", new Date().toISOString(), "first objective"));
    setup.adapter.emit({ type: "message.updated", sessionId: "session-1", messageId: "first" });
    await eventually(() => expect(setup.adapter.prompts()).toHaveLength(1));
    setup.adapter.addMessage(message("second", "session-1", new Date().toISOString(), "second objective"));
    setup.adapter.emit({ type: "message.updated", sessionId: "session-1", messageId: "second" });
    await eventually(() => expect(setup.adapter.prompts()).toHaveLength(2));
    expect(setup.persistence.getMissionCount()).toBe(1);
    expect(setup.adapter.prompts()[1]).toMatchObject({ sessionId: "session-1", agent: "orca-orchestrator" });
  });

  it("rejects delayed historical messages from both SSE and polling", async () => {
    const setup = await controllerSetup();
    await setup.rosterService.pair();
    const controller = await startController(setup.options);
    controllers.push(controller);

    setup.adapter.addMessage(message("delayed-historical", "session-1", "2020-01-01T00:00:00.000Z", "old objective"));
    setup.adapter.emit({ type: "message.updated", sessionId: "session-1", messageId: "delayed-historical" });
    await new Promise((resolve) => globalThis.setTimeout(resolve, 1_100));

    expect(setup.persistence.getMissionCount()).toBe(0);
    expect(setup.adapter.prompts()).toEqual([]);
  });

  it("keeps one persisted dispatch across restart and duplicate polling/SSE observation", async () => {
    const setup = await controllerSetup();
    await setup.rosterService.pair();
    const first = await startController(setup.options);
    setup.adapter.addMessage(message("restart-objective", "session-1", new Date().toISOString(), "restart objective"));
    setup.adapter.emit({ type: "message.updated", sessionId: "session-1", messageId: "restart-objective" });
    await eventually(() => expect(setup.adapter.prompts()).toHaveLength(1));
    const promptId = setup.adapter.prompts()[0].messageId;
    await first.stop();

    const second = await startController(setup.options);
    controllers.push(second);
    setup.adapter.emit({ type: "message.updated", sessionId: "session-1", messageId: "restart-objective" });
    await new Promise((resolve) => globalThis.setTimeout(resolve, 1_100));

    expect(setup.persistence.getMissionCount()).toBe(1);
    expect(setup.adapter.prompts()).toHaveLength(1);
    expect(setup.persistence.getTaskExecutionByPromptMessageId(promptId)?.controllerPromptMessageId).toBe(promptId);
  });

  it("dispatches a message missed after the first cutoff when the controller restarts", async () => {
    const setup = await controllerSetup();
    await setup.rosterService.pair();
    const first = await startController(setup.options);
    setup.adapter.addMessage(message("missed-before-stop", "session-1", new Date().toISOString(), "must survive restart"));
    await first.stop();

    const second = await startController(setup.options);
    controllers.push(second);
    await eventually(() => expect(setup.adapter.prompts()).toHaveLength(1));

    expect(setup.persistence.getMissionCount()).toBe(1);
    expect(setup.adapter.prompts()[0].content).toContain("must survive restart");
  });

  it("recovers from SSE interruption through polling and stops background work", async () => {
    const setup = await controllerSetup();
    await setup.rosterService.pair();
    const controller = await startController(setup.options);
    controllers.push(controller);
    setup.adapter.interruptEventStream();
    setup.adapter.setEventStreamAvailable(false);
    setup.adapter.addMessage(message("poll-objective", "session-1", new Date().toISOString(), "poll objective"));
    await eventuallyWithin(2_500, () => expect(setup.adapter.prompts()).toHaveLength(1));
    await controller.stop();
    controllers.splice(controllers.indexOf(controller), 1);
    setup.adapter.addMessage(message("after-stop", "session-1", new Date().toISOString(), "must not run"));
    await new Promise((resolve) => globalThis.setTimeout(resolve, 1_100));

    expect(setup.persistence.getMissionCount()).toBe(1);
    expect(setup.adapter.prompts()).toHaveLength(1);
  });

  it("blocks a roster-drifted Planner dispatch with a durable and visible explanation", async () => {
    const setup = await controllerSetup();
    const roster = await setup.rosterService.pair();
    const controller = await startController(setup.options);
    controllers.push(controller);
    setup.adapter.afterNextSessionList(() => setup.adapter.replaceSession({ ...setup.sessions[1], model: { providerId: "other", modelId: "changed" } }));
    setup.adapter.addMessage(message("drift-objective", "session-1", new Date().toISOString(), "drift objective"));
    setup.adapter.emit({ type: "message.updated", sessionId: "session-1", messageId: "drift-objective" });
    await eventually(() => expect(setup.adapter.prompts()).toHaveLength(1));

    expect(setup.adapter.prompts()[0]).toMatchObject({ sessionId: "session-1", agent: "orca-orchestrator" });
    expect(setup.persistence.getMissionCount()).toBe(1);
    expect(setup.persistence.getMission(stableId("mission", roster.rosterId, "drift-objective"))?.state).toBe("blocked");
  });

  it("notifies a retryable drift once and dispatches the same source after drift resolves", async () => {
    const setup = await controllerSetup();
    await setup.rosterService.pair();
    const controller = await startController(setup.options);
    controllers.push(controller);
    setup.adapter.replaceSession({ ...setup.sessions[1], model: { providerId: "other", modelId: "changed" } });
    setup.adapter.addMessage(message("retryable-drift", "session-1", new Date().toISOString(), "retry after drift"));
    setup.adapter.emit({ type: "message.updated", sessionId: "session-1", messageId: "retryable-drift" });
    await eventually(() => expect(setup.adapter.prompts()).toHaveLength(1));
    await new Promise((resolve) => globalThis.setTimeout(resolve, 1_100));

    expect(setup.persistence.getMissionCount()).toBe(0);
    expect(setup.adapter.prompts()).toHaveLength(1);
    setup.adapter.replaceSession(setup.sessions[1]);
    setup.adapter.emit({ type: "message.updated", sessionId: "session-1", messageId: "retryable-drift" });
    await eventuallyWithin(2_000, () => expect(setup.adapter.prompts()).toHaveLength(2));

    expect(setup.persistence.getMissionCount()).toBe(1);
    expect(setup.adapter.prompts()[1]).toMatchObject({ sessionId: "session-2", agent: "orca-planner" });
  });

  it("acknowledges a pending Planner dispatch already correlated by prompt ID without resending", async () => {
    const setup = await controllerSetup();
    const roster = await setup.rosterService.pair();
    const envelope = plannerEnvelope("mission-recovery", "task-recovery", setup.projectRoot);
    setup.persistence.createMissionTaskAndDispatch({
      mission: { missionId: envelope.missionId, rosterId: roster.rosterId, objective: envelope.objective, sourceSessionMessageId: "source-recovery", state: "planning" },
      task: { envelope, targetSessionId: "session-2", controllerPromptMessageId: "prompt-recovery" },
      dispatch: { dispatchKey: "dispatch-recovery", targetRole: "planner", targetSessionId: "session-2", capturedModel: { providerId: "openai", modelId: "gpt-5" }, promptMessageId: "prompt-recovery" }
    });
    setup.adapter.addMessage(message("prompt-recovery", "session-2", new Date().toISOString(), "[ORCA_DISPATCH:dispatch-recovery]"));

    const controller = await startController(setup.options);
    controllers.push(controller);

    expect(setup.adapter.prompts()).toEqual([]);
    expect(setup.persistence.getPendingDispatches()).toEqual([]);
    expect(setup.persistence.getDispatchByPromptMessageId("prompt-recovery")?.promptPayload).toMatchObject({ kind: "worker_task" });
    expect(setup.persistence.getTask("task-recovery")?.state).toBe("dispatched");
    expect(setup.persistence.getMission("mission-recovery")?.state).toBe("planning");
  });
});

async function controllerSetup() {
  const projectRoot = mkdtempSync(join(tmpdir(), "orca-dispatch-"));
  workspaces.push(projectRoot);
  mkdirSync(join(projectRoot, ".orca"));
  mkdirSync(join(projectRoot, ".opencode", "agents"), { recursive: true });
  for (const profile of roleProfiles) writeFileSync(join(projectRoot, ".opencode", "agents", `orca-${profile.role}.md`), renderRoleProfile(profile));
  execFileSync("git", ["init"], { cwd: projectRoot, shell: false });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: projectRoot, shell: false });
  execFileSync("git", ["config", "user.name", "ORCA test"], { cwd: projectRoot, shell: false });
  writeFileSync(join(projectRoot, "README.md"), "test\n");
  execFileSync("git", ["add", "README.md"], { cwd: projectRoot, shell: false });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: projectRoot, shell: false });
  const sessions = [1, 2, 3, 4, 5].map((position) => ({ id: `session-${position}`, position, serverBaseUrl: "http://127.0.0.1:4096", projectRoot, model: { providerId: "openai", modelId: "gpt-5" }, title: `Session ${position}`, status: "idle", inFlightToolCalls: 0 }));
  const adapter = new FakeOpenCodeAdapter(sessions);
  const persistence = new SqlitePersistence({ path: join(projectRoot, "state.sqlite") });
  persistences.push(persistence);
  const rosterService = new RosterService(adapter, persistence);
  return { projectRoot, sessions, adapter, persistence, rosterService, options: { projectRoot, adapter, persistence, version: "0.1.0", port: 0 } };
}

function message(id: string, sessionId: string, createdAt: string, text: string, role: "user" | "assistant" = "user") {
  return { id, sessionId, role, createdAt, parts: [{ id: `${id}-part`, type: "text", text }] };
}

async function eventually(assertion: () => unknown): Promise<void> {
  return eventuallyWithin(3_000, assertion);
}

async function eventuallyWithin(timeoutMs: number, assertion: () => unknown): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { assertion(); return; } catch { await new Promise((resolve) => globalThis.setTimeout(resolve, 10)); }
  }
  assertion();
}

function plannerEnvelope(missionId: string, taskId: string, projectRoot: string): TaskEnvelope {
  return { schemaVersion: "1.0", missionId, taskId, role: "planner", objective: "recovery objective", acceptanceCriteria: [], constraints: [], requiredEvidence: ["summary"], parentTaskIds: [], attempt: 1, projectRoot, baseCommit: "base", sourceWorkspaceFingerprint: "fingerprint", createdAt: new Date().toISOString(), timeoutMs: 60_000 };
}
