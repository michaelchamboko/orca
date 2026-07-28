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

const ROLE_SESSION: Record<string, string> = {
  orchestrator: "session-1",
  planner: "session-2",
  builder: "session-3",
  reviewer: "session-4",
  tester: "session-5"
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
  return { id, sessionId, role: "assistant", parentId, createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), parts: [{ id: `${id}:text`, type: "text", text }] };
}

function missionIdByIndex(ctx: TestContext, index: number): string {
  const ids = [...new Set(ctx.persistence.listAllTaskExecutions().map((t) => t.missionId))];
  const missionId = ids[index];
  if (!missionId) throw new Error(`no mission at index ${index}`);
  return missionId;
}

function taskFor(ctx: TestContext, missionId: string, role: "planner" | "builder" | "reviewer" | "tester"): { taskId: string; controllerPromptMessageId: string } {
  const tasks = ctx.persistence.listAllTaskExecutions().filter((candidate) => candidate.missionId === missionId && candidate.role === role);
  const task = tasks.at(-1);
  if (!task) throw new Error(`no ${role} task for mission ${missionId}`);
  return { taskId: task.taskId, controllerPromptMessageId: task.controllerPromptMessageId };
}

function plannerResult(missionId: string, taskId: string): string {
  return JSON.stringify({
    schemaVersion: "1.0",
    missionId,
    taskId,
    role: "planner",
    status: "completed",
    summary: "ready to build",
    workPerformed: ["plan"],
    files: [],
    commands: [],
    tests: [],
    findings: [],
    risks: [],
    questions: [],
    recommendedNextAction: "Build the feature",
    sourceWorkspaceFingerprint: "fp",
    completedAt: new Date().toISOString(),
    planVerdict: "ready",
    implementationSteps: ["step one"],
    expectedFiles: ["src/foo.ts"],
    validationPlan: ["run tests"]
  });
}

function builderResult(missionId: string, taskId: string): string {
  return JSON.stringify({
    schemaVersion: "1.0",
    missionId,
    taskId,
    role: "builder",
    status: "completed",
    summary: "implementation complete",
    workPerformed: ["implement"],
    files: [{ path: "src/foo.ts", action: "created", summary: "new file" }],
    commands: [],
    tests: [],
    findings: [],
    risks: [],
    questions: [],
    recommendedNextAction: "Review the diff",
    sourceWorkspaceFingerprint: "fp",
    completedAt: new Date().toISOString(),
    implementationVerdict: "implemented",
    changedFiles: ["src/foo.ts"],
    targetedTestsRun: []
  });
}

function reviewerPass(missionId: string, taskId: string): string {
  return JSON.stringify({
    schemaVersion: "1.0",
    missionId,
    taskId,
    role: "reviewer",
    status: "completed",
    summary: "looks good",
    workPerformed: ["review"],
    files: [],
    commands: [],
    tests: [],
    findings: [],
    risks: [],
    questions: [],
    recommendedNextAction: "Run tests",
    sourceWorkspaceFingerprint: "fp",
    completedAt: new Date().toISOString(),
    reviewVerdict: "pass",
    reviewedWorkspaceFingerprint: "fp"
  });
}

function reviewerChangesRequired(missionId: string, taskId: string): string {
  return JSON.stringify({
    schemaVersion: "1.0",
    missionId,
    taskId,
    role: "reviewer",
    status: "completed",
    summary: "needs changes",
    workPerformed: ["review"],
    files: [],
    commands: [],
    tests: [],
    findings: [{ severity: "medium", title: "missing test", description: "add a test", blocking: false }],
    risks: [],
    questions: [],
    recommendedNextAction: "Builder to fix",
    sourceWorkspaceFingerprint: "fp",
    completedAt: new Date().toISOString(),
    reviewVerdict: "changes_required",
    reviewedWorkspaceFingerprint: "fp"
  });
}

function testerPass(missionId: string, taskId: string): string {
  return JSON.stringify({
    schemaVersion: "1.0",
    missionId,
    taskId,
    role: "tester",
    status: "completed",
    summary: "all checks pass",
    workPerformed: ["test"],
    files: [],
    commands: [],
    tests: [{ name: "noop", command: "node -e process.exit(0)", status: "passed", evidence: "ok" }],
    findings: [],
    risks: [],
    questions: [],
    recommendedNextAction: "Complete the mission",
    sourceWorkspaceFingerprint: "fp",
    completedAt: new Date().toISOString(),
    testVerdict: "pass",
    testedWorkspaceFingerprint: "fp",
    requiredChecks: ["noop"],
    passedChecks: ["noop"],
    failedChecks: []
  });
}

function orchestratorAction(missionId: string, action: "approve" | "reject" | "request_completion", taskId?: string, correctionInstructions: string[] = []): string {
  return JSON.stringify({
    schemaVersion: "1.0",
    missionId,
    action,
    taskId,
    rationale: `gate ${action}`,
    correctionInstructions
  });
}

async function startFakeController(ctx: TestContext): Promise<void> {
  const controller = await startController({
    projectRoot: ctx.projectRoot,
    adapter: ctx.adapter,
    persistence: ctx.persistence,
    version: "0.1.0",
    port: 0
  });
  controllers.push(controller);
}

async function submitUserObjective(ctx: TestContext, text: string): Promise<string> {
  const id = `user-objective-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  ctx.adapter.addMessage({ id, sessionId: ROLE_SESSION.orchestrator, role: "user", createdAt: new Date().toISOString(), parts: [{ id: `${id}:text`, type: "text", text }] });
  ctx.adapter.emit({ type: "message.updated", sessionId: ROLE_SESSION.orchestrator, messageId: id });
  return id;
}

async function waitForMission(ctx: TestContext, index: number, timeoutMs = 8_000): Promise<string> {
  return eventually(() => {
    const id = missionIdByIndex(ctx, index);
    return id;
  }, { timeoutMs });
}

async function waitForRolePrompt(ctx: TestContext, role: "planner" | "builder" | "reviewer" | "tester", minCount = 1, timeoutMs = 8_000): Promise<{ messageId: string; sessionId: string }> {
  const targetSession = ROLE_SESSION[role];
  return eventually(() => {
    const prompts = ctx.adapter.prompts().filter((p) => p.sessionId === targetSession && p.content.includes("[ORCA_DISPATCH:"));
    if (prompts.length < minCount) throw new Error(`no ${role} prompt yet (have ${prompts.length}, need ${minCount})`);
    const lastPrompt = prompts.at(-1);
    if (!lastPrompt) throw new Error(`no ${role} prompt yet`);
    return { messageId: lastPrompt.messageId, sessionId: lastPrompt.sessionId };
  }, { timeoutMs });
}

async function waitForOrchestratorDecisionPrompt(ctx: TestContext, gate: "plan" | "builder" | "review" | "test" | "final", timeoutMs = 8_000): Promise<string> {
  return eventually(() => {
    const prompt = ctx.adapter.prompts().find((p) => p.sessionId === ROLE_SESSION.orchestrator && p.content.includes(`gate=${gate}`));
    if (!prompt) throw new Error(`no orchestrator ${gate} prompt yet`);
    return prompt.messageId;
  }, { timeoutMs });
}

async function submitWorkerResultAndAdvance(ctx: TestContext, role: "planner" | "builder" | "reviewer" | "tester", resultText: string, missionId: string): Promise<void> {
  const { taskId, controllerPromptMessageId } = taskFor(ctx, missionId, role);
  ctx.adapter.addMessage(assistantMessage(`${role}-response`, ROLE_SESSION[role], controllerPromptMessageId, resultText));
  ctx.adapter.emit({ type: "message.updated", sessionId: ROLE_SESSION[role], messageId: `${role}-response` });
  await eventually(() => {
    const task = ctx.persistence.getTask(taskId);
    if (!task || (task.state !== "completed" && task.state !== "approved")) {
      throw new Error(`task ${taskId} state is ${task?.state ?? "missing"}`);
    }
    return task.state;
  }, { timeoutMs: 8_000 });
}

async function submitOrchestratorActionAndAdvance(ctx: TestContext, missionId: string, action: "approve" | "reject" | "request_completion", gate: "plan" | "builder" | "review" | "test" | "final", taskId?: string, correctionInstructions: string[] = []): Promise<void> {
  const promptMessageId = await waitForOrchestratorDecisionPrompt(ctx, gate);
  const responseId = `orchestrator-${action}-${gate}`;
  ctx.adapter.addMessage(assistantMessage(responseId, ROLE_SESSION.orchestrator, promptMessageId, orchestratorAction(missionId, action, taskId, correctionInstructions)));
  ctx.adapter.emit({ type: "message.updated", sessionId: ROLE_SESSION.orchestrator, messageId: responseId });
  await sleep(2_000);
}

describe("full fake five-session ORCA mission", () => {
  it("preserves the five paired models and dispatches the Planner on a Session 1 objective", async () => {
    const ctx = await setupContext();
    await startFakeController(ctx);

    expect(ctx.roster.bindings).toHaveLength(5);
    expect(ctx.roster.bindings.map((b) => b.model)).toEqual([
      { providerId: "openai", modelId: "gpt-5" },
      { providerId: "anthropic", modelId: "claude-4" },
      { providerId: "opencode", modelId: "north-mini-code-free" },
      { providerId: "minimax-coding-plan", modelId: "MiniMax-M3" },
      { providerId: "local", modelId: "qwen3" }
    ]);

    await submitUserObjective(ctx, "Plan the ORCA release");
    const plannerPrompt = await waitForRolePrompt(ctx, "planner");
    expect(plannerPrompt.sessionId).toBe(ROLE_SESSION.planner);
    expect(ctx.adapter.prompts().find((p) => p.sessionId === ROLE_SESSION.planner)?.model).toEqual(MODEL_BY_POSITION[2]);
    expect(ctx.persistence.getMissionCount()).toBe(1);

    const otherSessionPrompts = ctx.adapter.prompts().filter((p) => p.sessionId !== ROLE_SESSION.orchestrator && p.sessionId !== ROLE_SESSION.planner);
    expect(otherSessionPrompts).toEqual([]);
  });

  it("drives the complete Planner → Builder → Reviewer → Tester → Final → completion sequence", async () => {
    const ctx = await setupContext();
    await startFakeController(ctx);

    await submitUserObjective(ctx, "Build the ORCA release");
    const missionId = await waitForMission(ctx, 0);
    expect(missionId).not.toBe("bootstrap");
    expect(missionId).not.toMatch(/^bootstrap/);

    await waitForRolePrompt(ctx, "planner");
    await submitWorkerResultAndAdvance(ctx, "planner", plannerResult(missionId, taskFor(ctx, missionId, "planner").taskId), missionId);
    expect(ctx.persistence.getMission(missionId)?.state).toBe("awaiting_plan_approval");

    const planPrompt = await waitForOrchestratorDecisionPrompt(ctx, "plan");
    expect(planPrompt).toBeTruthy();
    await submitOrchestratorActionAndAdvance(ctx, missionId, "approve", "plan", taskFor(ctx, missionId, "planner").taskId);
    expect(ctx.persistence.getMission(missionId)?.state).toBe("building");

    await waitForRolePrompt(ctx, "builder");
    const builderTaskId = taskFor(ctx, missionId, "builder").taskId;
    expect(ctx.adapter.prompts().find((p) => p.sessionId === ROLE_SESSION.builder)?.model).toEqual(MODEL_BY_POSITION[3]);
    expect(builderTaskId).not.toBe(taskFor(ctx, missionId, "planner").taskId);
    expect(builderTaskId).not.toMatch(/bootstrap/);
    await submitWorkerResultAndAdvance(ctx, "builder", builderResult(missionId, builderTaskId), missionId);
    expect(ctx.persistence.getMission(missionId)?.state).toBe("awaiting_builder_approval");

    await waitForOrchestratorDecisionPrompt(ctx, "builder");
    await submitOrchestratorActionAndAdvance(ctx, missionId, "approve", "builder", builderTaskId);

    await waitForRolePrompt(ctx, "reviewer");
    const reviewerTaskId = taskFor(ctx, missionId, "reviewer").taskId;
    expect(ctx.adapter.prompts().find((p) => p.sessionId === ROLE_SESSION.reviewer)?.model).toEqual(MODEL_BY_POSITION[4]);
    expect(reviewerTaskId).not.toBe(builderTaskId);
    expect(reviewerTaskId).not.toMatch(/bootstrap/);
    await submitWorkerResultAndAdvance(ctx, "reviewer", reviewerPass(missionId, reviewerTaskId), missionId);
    expect(ctx.persistence.getMission(missionId)?.state).toBe("awaiting_review_approval");

    await waitForOrchestratorDecisionPrompt(ctx, "review");
    await submitOrchestratorActionAndAdvance(ctx, missionId, "approve", "review", reviewerTaskId);

    await waitForRolePrompt(ctx, "tester");
    const testerTaskId = taskFor(ctx, missionId, "tester").taskId;
    expect(ctx.adapter.prompts().find((p) => p.sessionId === ROLE_SESSION.tester)?.model).toEqual(MODEL_BY_POSITION[5]);
    expect(testerTaskId).not.toBe(reviewerTaskId);
    expect(testerTaskId).not.toMatch(/bootstrap/);
    await submitWorkerResultAndAdvance(ctx, "tester", testerPass(missionId, testerTaskId), missionId);
    expect(ctx.persistence.getMission(missionId)?.state).toBe("awaiting_test_approval");

    await waitForOrchestratorDecisionPrompt(ctx, "test");
    await submitOrchestratorActionAndAdvance(ctx, missionId, "approve", "test", testerTaskId);

    await waitForOrchestratorDecisionPrompt(ctx, "final");
    expect(ctx.persistence.getMission(missionId)?.state).toBe("awaiting_final_approval");
    await submitOrchestratorActionAndAdvance(ctx, missionId, "request_completion", "final");
    expect(ctx.persistence.getMission(missionId)?.state).toBe("completed");

    const allDispatches = ctx.persistence.listAllTaskExecutions();
    for (const task of allDispatches) {
      expect(task.missionId).toBe(missionId);
    }
    const decisionEvents = ctx.persistence.getMissionEvents(missionId).filter((event) => event.eventType === "task.dispatched" && (event.payload as { purpose?: string }).purpose === "orchestrator_decision");
    expect(decisionEvents.length).toBeGreaterThanOrEqual(5);
  }, 90_000);

  it("rejects request_completion at the planner gate and persists the rejection as an event", async () => {
    const ctx = await setupContext();
    await startFakeController(ctx);

    await submitUserObjective(ctx, "Plan the ORCA release");
    const missionId = await waitForMission(ctx, 0);

    await waitForRolePrompt(ctx, "planner");
    await submitWorkerResultAndAdvance(ctx, "planner", plannerResult(missionId, taskFor(ctx, missionId, "planner").taskId), missionId);

    const promptMessageId = await waitForOrchestratorDecisionPrompt(ctx, "plan");
    ctx.adapter.addMessage(assistantMessage("premature-complete", ROLE_SESSION.orchestrator, promptMessageId, orchestratorAction(missionId, "request_completion")));
    ctx.adapter.emit({ type: "message.updated", sessionId: ROLE_SESSION.orchestrator, messageId: "premature-complete" });
    await sleep(2_000);

    expect(ctx.persistence.getMission(missionId)?.state).toBe("awaiting_plan_approval");
    const rejectionEvents = ctx.persistence.getMissionEvents(missionId).filter((event) => event.eventType === "orchestrator_action.rejected");
    expect(rejectionEvents.length).toBeGreaterThan(0);
  }, 30_000);

  it("consumes a Session 1 approval exactly once when SSE and polling deliver the same event", async () => {
    const ctx = await setupContext();
    await startFakeController(ctx);

    await submitUserObjective(ctx, "Build the ORCA release");
    const missionId = await waitForMission(ctx, 0);

    await waitForRolePrompt(ctx, "planner");
    await submitWorkerResultAndAdvance(ctx, "planner", plannerResult(missionId, taskFor(ctx, missionId, "planner").taskId), missionId);

    const planPrompt = await waitForOrchestratorDecisionPrompt(ctx, "plan");
    const plannerTaskId = taskFor(ctx, missionId, "planner").taskId;
    const responseId = "approval-dup";
    ctx.adapter.addMessage(assistantMessage(responseId, ROLE_SESSION.orchestrator, planPrompt, orchestratorAction(missionId, "approve", plannerTaskId)));
    ctx.adapter.emit({ type: "message.updated", sessionId: ROLE_SESSION.orchestrator, messageId: responseId });
    ctx.adapter.emit({ type: "message.updated", sessionId: ROLE_SESSION.orchestrator, messageId: responseId });
    await sleep(3_500);

    const orchestratorEvents = ctx.persistence.getMissionEvents(missionId).filter((e) => e.eventType.startsWith("orchestrator_action"));
    const appliedCount = orchestratorEvents.filter((e) => e.eventType === "orchestrator_action.applied").length;
    expect(appliedCount).toBe(1);
    expect(ctx.persistence.getMission(missionId)?.state).toBe("building");

    const builderPrompts = ctx.adapter.prompts().filter((p) => p.sessionId === ROLE_SESSION.builder);
    expect(builderPrompts).toHaveLength(1);
  }, 30_000);

  it("smoke test: action apply triggers a dispatch via reconcileOnce polling", async () => {
    const ctx = await setupContext();
    await startFakeController(ctx);

    await submitUserObjective(ctx, "Build the ORCA release");
    const missionId = await waitForMission(ctx, 0);

    await waitForRolePrompt(ctx, "planner");
    await submitWorkerResultAndAdvance(ctx, "planner", plannerResult(missionId, taskFor(ctx, missionId, "planner").taskId), missionId);
    const planPrompt = await waitForOrchestratorDecisionPrompt(ctx, "plan");
    const plannerTaskId = taskFor(ctx, missionId, "planner").taskId;
    const responseId = "smoke-approval";
    ctx.adapter.addMessage(assistantMessage(responseId, ROLE_SESSION.orchestrator, planPrompt, orchestratorAction(missionId, "approve", plannerTaskId)));
    ctx.adapter.emit({ type: "message.updated", sessionId: ROLE_SESSION.orchestrator, messageId: responseId });
    await sleep(3_000);

    expect(ctx.persistence.getMission(missionId)?.state).toBe("building");
    const pendingDispatches = ctx.persistence.getPendingDispatches();
    expect(pendingDispatches.length).toBe(0);
  }, 30_000);

  it("routes a review-rejection back to the Builder instead of the Tester or Reviewer", async () => {
    const ctx = await setupContext();
    await startFakeController(ctx);

    await submitUserObjective(ctx, "Build the ORCA release");
    const missionId = await waitForMission(ctx, 0);

    await waitForRolePrompt(ctx, "planner");
    await submitWorkerResultAndAdvance(ctx, "planner", plannerResult(missionId, taskFor(ctx, missionId, "planner").taskId), missionId);
    await waitForOrchestratorDecisionPrompt(ctx, "plan");
    await submitOrchestratorActionAndAdvance(ctx, missionId, "approve", "plan", taskFor(ctx, missionId, "planner").taskId);

    await waitForRolePrompt(ctx, "builder");
    const firstBuilderTaskId = taskFor(ctx, missionId, "builder").taskId;
    await submitWorkerResultAndAdvance(ctx, "builder", builderResult(missionId, firstBuilderTaskId), missionId);
    await waitForOrchestratorDecisionPrompt(ctx, "builder");
    await submitOrchestratorActionAndAdvance(ctx, missionId, "approve", "builder", firstBuilderTaskId);

    await waitForRolePrompt(ctx, "reviewer");
    const reviewerTaskId = taskFor(ctx, missionId, "reviewer").taskId;
    await submitWorkerResultAndAdvance(ctx, "reviewer", reviewerChangesRequired(missionId, reviewerTaskId), missionId);
    await waitForOrchestratorDecisionPrompt(ctx, "review");
    await submitOrchestratorActionAndAdvance(ctx, missionId, "reject", "review", reviewerTaskId, ["add the missing test"]);

    try {
      await waitForRolePrompt(ctx, "builder", 2);
    } catch (error) {
      const debug = ctx.persistence.getMissionEvents(missionId).map((e) => `${e.eventType}:${JSON.stringify(e.payload)}`).join(" | ");
      throw new Error(`${(error as Error).message}; state: ${ctx.persistence.getMission(missionId)?.state}; events: ${debug}`);
    }
    const secondBuilderPrompt = ctx.adapter.prompts().filter((p) => p.sessionId === ROLE_SESSION.builder).at(-1);
    expect(secondBuilderPrompt).toBeDefined();
    const builderTasks = ctx.persistence.listAllTaskExecutions().filter((t) => t.missionId === missionId && t.role === "builder");
    expect(builderTasks.length).toBeGreaterThanOrEqual(2);
    const secondBuilderTask = builderTasks.at(-1);
    if (!secondBuilderTask) throw new Error("expected a second builder task");
    const secondBuilderTaskId = secondBuilderTask.taskId;
    expect(secondBuilderTaskId).not.toBe(firstBuilderTaskId);
    const testerPrompts = ctx.adapter.prompts().filter((p) => p.sessionId === ROLE_SESSION.tester);
    expect(testerPrompts).toEqual([]);
    void secondBuilderPrompt;
  }, 60_000);

  it("rejects a stale approval when the gate has already advanced", async () => {
    const ctx = await setupContext();
    await startFakeController(ctx);

    await submitUserObjective(ctx, "Build the ORCA release");
    const missionId = await waitForMission(ctx, 0);

    await waitForRolePrompt(ctx, "planner");
    await submitWorkerResultAndAdvance(ctx, "planner", plannerResult(missionId, taskFor(ctx, missionId, "planner").taskId), missionId);
    const planPrompt = await waitForOrchestratorDecisionPrompt(ctx, "plan");
    const plannerTaskId = taskFor(ctx, missionId, "planner").taskId;

    await submitOrchestratorActionAndAdvance(ctx, missionId, "approve", "plan", plannerTaskId);
    await waitForRolePrompt(ctx, "builder");
    expect(ctx.persistence.getMission(missionId)?.state).toBe("building");

    ctx.adapter.addMessage(assistantMessage("stale-approval", ROLE_SESSION.orchestrator, planPrompt, orchestratorAction(missionId, "approve", plannerTaskId)));
    ctx.adapter.emit({ type: "message.updated", sessionId: ROLE_SESSION.orchestrator, messageId: "stale-approval" });
    await sleep(2_000);

    expect(ctx.persistence.getMission(missionId)?.state).toBe("building");
    const staleEvents = ctx.persistence.getMissionEvents(missionId).filter((event) => event.eventType === "orchestrator_action.rejected");
    expect(staleEvents.length).toBeGreaterThan(0);
  }, 30_000);

  it("uses distinct mission ids, task ids, and dispatch keys for two separate missions", async () => {
    const firstCtx = await setupContext();
    await startFakeController(firstCtx);

    await submitUserObjective(firstCtx, "First mission");
    const firstMissionId = await waitForMission(firstCtx, 0);

    await waitForRolePrompt(firstCtx, "planner");
    await submitWorkerResultAndAdvance(firstCtx, "planner", plannerResult(firstMissionId, taskFor(firstCtx, firstMissionId, "planner").taskId), firstMissionId);
    await waitForOrchestratorDecisionPrompt(firstCtx, "plan");
    await submitOrchestratorActionAndAdvance(firstCtx, firstMissionId, "approve", "plan", taskFor(firstCtx, firstMissionId, "planner").taskId);
    await waitForRolePrompt(firstCtx, "builder");
    const firstBuilderTaskId = taskFor(firstCtx, firstMissionId, "builder").taskId;
    expect(firstBuilderTaskId).not.toMatch(/bootstrap/);
    expect(firstMissionId).not.toMatch(/bootstrap/);

    const secondCtx = await setupContext();
    await startFakeController(secondCtx);

    await submitUserObjective(secondCtx, "Second mission");
    const secondMissionId = await waitForMission(secondCtx, 0);
    expect(secondMissionId).not.toBe(firstMissionId);
    expect(secondMissionId).not.toMatch(/bootstrap/);

    const secondPlannerTaskId = taskFor(secondCtx, secondMissionId, "planner").taskId;
    expect(secondPlannerTaskId).not.toBe(taskFor(firstCtx, firstMissionId, "planner").taskId);

    const allDispatchKeys = new Set<string>();
    for (const task of firstCtx.persistence.listAllTaskExecutions()) {
      const dispatch = firstCtx.persistence.getDispatchByPromptMessageId(task.controllerPromptMessageId);
      if (dispatch) allDispatchKeys.add(dispatch.dispatchKey);
    }
    for (const task of secondCtx.persistence.listAllTaskExecutions()) {
      const dispatch = secondCtx.persistence.getDispatchByPromptMessageId(task.controllerPromptMessageId);
      if (dispatch) allDispatchKeys.add(dispatch.dispatchKey);
    }
    expect(allDispatchKeys.size).toBeGreaterThan(0);
  }, 60_000);
});
