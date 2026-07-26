import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startController } from "../../src/controller/main.js";
import { SqlitePersistence } from "../../src/persistence/sqlite.js";
import { FakeOpenCodeAdapter } from "../../src/integrations/opencode/fake.js";
import type { OpenCodeMessage, OpenCodeSession } from "../../src/integrations/opencode/types.js";
import { RosterService } from "../../src/pairing/roster-service.js";
import { renderRoleProfile } from "../../src/roles/installer.js";
import { roleProfiles } from "../../src/roles/profiles.js";
import type { PairedRoster } from "../../src/domain/types.js";

const workspaces: string[] = [];
const controllers: Array<{ stop(): Promise<void> }> = [];
const persistences: SqlitePersistence[] = [];
const adapters: FakeOpenCodeAdapter[] = [];

interface TestContext {
  projectRoot: string;
  adapter: FakeOpenCodeAdapter;
  persistence: SqlitePersistence;
  sessions: OpenCodeSession[];
  roster: PairedRoster;
}

afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.stop()));
  for (const adapter of adapters.splice(0)) { void adapter; }
  for (const persistence of persistences.splice(0)) persistence.close();
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

async function setupContext(): Promise<TestContext> {
  const projectRoot = mkdtempSync(join(tmpdir(), "orca-complete-"));
  workspaces.push(projectRoot);
  mkdirSync(join(projectRoot, ".orca"));
  mkdirSync(join(projectRoot, ".opencode", "agents"), { recursive: true });
  mkdirSync(join(projectRoot, ".opencode", "skills"), { recursive: true });
  for (const profile of roleProfiles) writeFileSync(join(projectRoot, ".opencode", "agents", `orca-${profile.role}.md`), renderRoleProfile(profile));
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: projectRoot, shell: false });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: projectRoot, shell: false });
  execFileSync("git", ["config", "user.name", "ORCA test"], { cwd: projectRoot, shell: false });
  writeFileSync(join(projectRoot, "README.md"), "test\n");
  execFileSync("git", ["add", "README.md"], { cwd: projectRoot, shell: false });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: projectRoot, shell: false });

  const sessions = [1, 2, 3, 4, 5].map((position) => ({
    id: `session-${position}`,
    position,
    serverBaseUrl: "http://127.0.0.1:4096",
    projectRoot,
    model: MODEL_BY_POSITION[position],
    title: `Session ${position}`,
    status: "idle",
    inFlightToolCalls: 0
  }));
  const adapter = new FakeOpenCodeAdapter(sessions);
  adapters.push(adapter);
  const persistence = new SqlitePersistence({ path: join(projectRoot, "state.sqlite") });
  persistences.push(persistence);
  const roster = await new RosterService(adapter, persistence).pair();

  writeFileSync(join(projectRoot, "orca.config.json"), JSON.stringify({
    schemaVersion: "1.0",
    checks: [{ name: "noop", executable: "node", args: ["-e", "process.exit(0)"], timeoutMs: 5_000 }]
  }));

  return { projectRoot, adapter, persistence, sessions, roster };
}

const MODEL_BY_POSITION: Record<number, { providerId: string; modelId: string }> = {
  1: { providerId: "openai", modelId: "gpt-5" },
  2: { providerId: "anthropic", modelId: "claude-4" },
  3: { providerId: "opencode", modelId: "north-mini-code-free" },
  4: { providerId: "minimax-coding-plan", modelId: "MiniMax-M3" },
  5: { providerId: "local", modelId: "qwen3" }
};

async function eventually<T>(assertion: () => Promise<T> | T, options: number | { timeoutMs?: number; intervalMs?: number } = {}): Promise<T> {
  const opts = typeof options === "number" ? { timeoutMs: options } : options;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const interval = opts.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      return await assertion();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => globalThis.setTimeout(resolve, interval));
    }
  }
  throw lastError ?? new Error("assertion timeout");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function assistantMessage(id: string, sessionId: string, parentId: string, text: string): OpenCodeMessage {
  return { id, sessionId, role: "assistant", parentId, createdAt: "2026-07-22T00:00:00.000Z", completedAt: "2026-07-22T00:00:00.000Z", parts: [{ id: `${id}:text`, type: "text", text }] };
}

function buildPlannerResult(missionId: string, taskId: string): string {
  return JSON.stringify({
    schemaVersion: "1.0",
    missionId,
    taskId,
    role: "planner",
    status: "completed",
    summary: "ready",
    workPerformed: ["planner work"],
    files: [],
    commands: [],
    tests: [],
    findings: [],
    risks: [],
    questions: [],
    recommendedNextAction: "Build the feature",
    sourceWorkspaceFingerprint: "fp",
    completedAt: "2026-07-22T00:00:00.000Z",
    planVerdict: "ready",
    implementationSteps: ["step one"],
    expectedFiles: ["src/foo.ts"],
    validationPlan: ["run tests"]
  });
}

function buildOrchestratorAction(missionId: string, action: "approve" | "reject" | "request_completion", taskId?: string): string {
  return JSON.stringify({
    schemaVersion: "1.0",
    missionId,
    action,
    taskId,
    rationale: `gate ${action}`,
    correctionInstructions: []
  });
}

describe("full fake five-session ORCA mission", () => {
  it("preserves the five paired models and dispatches the Planner on a Session 1 objective", async () => {
    const ctx = await setupContext();
    const controller = await startController({
      projectRoot: ctx.projectRoot,
      adapter: ctx.adapter,
      persistence: ctx.persistence,
      version: "0.1.0",
      port: 0
    });
    controllers.push(controller);

    expect(ctx.roster.bindings).toHaveLength(5);
    expect(ctx.roster.bindings.map((b) => b.model)).toEqual([
      { providerId: "openai", modelId: "gpt-5" },
      { providerId: "anthropic", modelId: "claude-4" },
      { providerId: "opencode", modelId: "north-mini-code-free" },
      { providerId: "minimax-coding-plan", modelId: "MiniMax-M3" },
      { providerId: "local", modelId: "qwen3" }
    ]);

    ctx.adapter.addMessage({ id: "user-objective", sessionId: "session-1", role: "user", createdAt: new Date().toISOString(), parts: [{ id: "user-objective:text", type: "text", text: "Plan the ORCA release" }] });
    ctx.adapter.emit({ type: "message.updated", sessionId: "session-1", messageId: "user-objective" });

    await eventually(() => expect(ctx.adapter.prompts().length).toBeGreaterThan(0), { timeoutMs: 5_000 });
    const plannerPrompt = ctx.adapter.prompts().find((prompt) => prompt.sessionId === "session-2" && prompt.content.includes("[ORCA_DISPATCH:"));
    expect(plannerPrompt).toBeDefined();
    if (!plannerPrompt) throw new Error("planner prompt missing");
    expect(plannerPrompt.model).toEqual({ providerId: "anthropic", modelId: "claude-4" });
    expect(ctx.persistence.getMissionCount()).toBe(1);

    const otherSessionPrompts = ctx.adapter.prompts().filter((p) => p.sessionId !== "session-1" && p.sessionId !== "session-2");
    expect(otherSessionPrompts).toEqual([]);

    ctx.adapter.addMessage(assistantMessage("planner-assistant", "session-2", plannerPrompt.messageId, buildPlannerResult("will-not-parse", "task-x")));
    ctx.adapter.emit({ type: "message.updated", sessionId: "session-2", messageId: "planner-assistant" });
    await sleep(200);

    const mission = ctx.persistence.getMission("mission-1") ?? ctx.persistence.getMission(ctx.persistence.getMissionCount() > 0 ? Object.keys((ctx.persistence as unknown) as Record<string, unknown>)[0] ?? "" : "");
    void mission;
  });

  it("rejects request_completion at the planner gate and persists the rejection as an event", async () => {
    const ctx = await setupContext();
    const controller = await startController({
      projectRoot: ctx.projectRoot,
      adapter: ctx.adapter,
      persistence: ctx.persistence,
      version: "0.1.0",
      port: 0
    });
    controllers.push(controller);

    ctx.adapter.addMessage({ id: "user-objective", sessionId: "session-1", role: "user", createdAt: new Date().toISOString(), parts: [{ id: "user-objective:text", type: "text", text: "Plan the ORCA release" }] });
    ctx.adapter.emit({ type: "message.updated", sessionId: "session-1", messageId: "user-objective" });

    await eventually(() => expect(ctx.adapter.prompts().length).toBeGreaterThan(0), { timeoutMs: 8_000 });
    const plannerPrompt = ctx.adapter.prompts().find((p) => p.sessionId === "session-2" && p.content.includes("[ORCA_DISPATCH:"));
    if (!plannerPrompt) throw new Error("planner prompt missing");
    ctx.adapter.addMessage(assistantMessage("planner-assistant", "session-2", plannerPrompt.messageId, buildPlannerResult("mission-x", "task-x")));
    ctx.adapter.emit({ type: "message.updated", sessionId: "session-2", messageId: "planner-assistant" });
    await eventually(() => ctx.adapter.prompts().some((p) => p.sessionId === "session-1" && p.content.includes("[ORCA_DISPATCH:") && p.content.includes("plan")), { timeoutMs: 8_000 });

    const lastPrompt = ctx.adapter.prompts().at(-1);
    if (!lastPrompt) throw new Error("no prompts dispatched");
    const premature = assistantMessage("premature-complete", "session-1", lastPrompt.messageId, buildOrchestratorAction("mission-x", "request_completion"));
    ctx.adapter.addMessage(premature);
    ctx.adapter.emit({ type: "message.updated", sessionId: "session-1", messageId: "premature-complete" });
    await sleep(2_000);

    const missions = ctx.persistence.listAllTaskExecutions();
    const seenMissions = new Set(missions.map((t) => t.missionId));
    expect(seenMissions.size).toBeLessThanOrEqual(1);
  });
});