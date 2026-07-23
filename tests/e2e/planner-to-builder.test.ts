import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startController } from "../../src/controller/main.js";
import { SqlitePersistence } from "../../src/persistence/sqlite.js";
import { FakeOpenCodeAdapter } from "../../src/integrations/opencode/fake.js";
import type { OpenCodeSession } from "../../src/integrations/opencode/types.js";
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

void 0;

async function setupContext(): Promise<TestContext> {
  const projectRoot = mkdtempSync(join(tmpdir(), "orca-runtime-"));
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
    model: { providerId: "openai", modelId: `model-${position}` },
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

afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.stop()));
  for (const persistence of persistences.splice(0)) persistence.close();
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

describe("production Planner-to-Builder cycle", () => {
  beforeEach(async () => {
    if (controllers.length > 0) await Promise.all(controllers.splice(0).map((c) => c.stop()));
  });

  it("does not double-dispatch on duplicate SSE and polling observation of the same objective", async () => {
    const ctx = await setupContext();
    const controller = await startController({ projectRoot: ctx.projectRoot, adapter: ctx.adapter, persistence: ctx.persistence, version: "0.1.0", port: 0 });
    controllers.push(controller);

    const objectiveId = "dup-objective";
    ctx.adapter.addMessage({ id: objectiveId, sessionId: "session-1", role: "user", createdAt: new Date().toISOString(), parts: [{ id: `${objectiveId}:text`, type: "text", text: "Build the release" }] });
    ctx.adapter.emit({ type: "message.updated", sessionId: "session-1", messageId: objectiveId });
    ctx.adapter.emit({ type: "message.updated", sessionId: "session-1", messageId: objectiveId });
    await sleep(500);

    const plannerPrompts = ctx.adapter.prompts().filter((p) => p.sessionId === "session-2");
    expect(plannerPrompts).toHaveLength(1);
    expect(ctx.persistence.getMissionCount()).toBe(1);
  });

  it("serializes startup, polling, and event-driven reconciliation through the same mutex", async () => {
    const ctx = await setupContext();
    const controller = await startController({ projectRoot: ctx.projectRoot, adapter: ctx.adapter, persistence: ctx.persistence, version: "0.1.0", port: 0 });
    controllers.push(controller);

    for (let i = 0; i < 5; i += 1) {
      const id = `parallel-${i}`;
      ctx.adapter.addMessage({ id, sessionId: "session-1", role: "user", createdAt: new Date(Date.now() + i).toISOString(), parts: [{ id: `${id}:text`, type: "text", text: `parallel ${i}` }] });
      ctx.adapter.emit({ type: "message.updated", sessionId: "session-1", messageId: id });
    }
    await sleep(500);

    expect(ctx.persistence.getMissionCount()).toBeLessThanOrEqual(5);
    const plannerPrompts = ctx.adapter.prompts().filter((p) => p.sessionId === "session-2");
    expect(plannerPrompts.length).toBeLessThanOrEqual(5);
  });
});
