import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startController } from "../../src/controller/main.js";
import { readControllerRuntime } from "../../src/controller/runtime.js";
import type { PairedRoster } from "../../src/domain/types.js";
import type { OpenCodeLiveAdapter } from "../../src/integrations/opencode/adapter.js";
import type { OpenCodeEvent, OpenCodeSession, SessionPrompt, SessionStatus } from "../../src/integrations/opencode/types.js";
import { RosterService } from "../../src/pairing/roster-service.js";
import { renderRoleProfile } from "../../src/roles/installer.js";
import { roleProfiles } from "../../src/roles/profiles.js";

const workspaces: string[] = [];
const controllers: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.stop()));
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

describe("authenticated controller startup", () => {
  it("binds only the required loopback address and rejects unauthenticated requests", async () => {
    const controller = await runningController();

    expect(controller.address).toEqual({ host: "127.0.0.1", port: 4317 });
    expect((await controller.api.inject({ method: "GET", url: "/health" })).statusCode).toBe(401);
    expect((await controller.api.inject({ method: "GET", url: "/health", headers: { authorization: `Bearer ${controller.token}` } })).json()).toMatchObject({ healthy: true, opencodeHealthy: true, bindingsCurrent: true, bindingCount: 5 });
  });

  it("stores a generated token separately from durable runtime metadata and never leaks it", async () => {
    const controller = await runningController();
    const runtime = readFileSync(join(controller.projectRoot, ".orca", "controller.json"), "utf8");
    const token = readFileSync(join(controller.projectRoot, ".orca", "controller-token"), "utf8").trim();

    expect(token).toBe(controller.token);
    expect(token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(runtime).not.toContain(token);
    expect(JSON.stringify(await controller.api.inject({ method: "GET", url: "/health" }))).not.toContain(token);
  });

  it("rejects a second start after validating the existing authenticated runtime", async () => {
    const first = await runningController();

    await expect(startController(first.options)).rejects.toThrow("controller is already running");
  });

  it("shuts down gracefully and removes its runtime state", async () => {
    const controller = await runningController();
    await controller.stop();
    controllers.splice(controllers.indexOf(controller), 1);

    expect(readControllerRuntime(controller.projectRoot)).toEqual({ running: false, reason: "no validated controller runtime metadata" });
    expect(existsSync(join(controller.projectRoot, ".orca", "controller-token"))).toBe(false);
  });

  it("cleans stale metadata without trusting a PID alone", async () => {
    const setup = controllerSetup();
    await setup.rosterService.pair();
    writeFileSync(join(setup.projectRoot, ".orca", "controller.json"), JSON.stringify({ schemaVersion: 1, pid: process.pid, processIdentity: "reused-process", port: 4317, version: "0.1.0", createdAt: "2026-01-01T00:00:00.000Z" }));
    writeFileSync(join(setup.projectRoot, ".orca", "controller-token"), "stale-token");

    const controller = await startController(setup.options);
    controllers.push(controller);

    expect(controller.token).not.toBe("stale-token");
    expect(readFileSync(join(setup.projectRoot, ".orca", "controller.json"), "utf8")).not.toContain("reused-process");
  });

  it("refuses to listen when the paired roster has drifted", async () => {
    const setup = controllerSetup();
    await setup.rosterService.pair();
    setup.adapter.replaceSession({ ...setup.sessions[2], model: { providerId: "other", modelId: "changed" } });

    await expect(startController(setup.options)).rejects.toThrow("roster drift");
    expect(existsSync(join(setup.projectRoot, ".orca", "controller.json"))).toBe(false);
  });

  it("refuses a modified, skeletal, or otherwise mismatched ORCA profile", async () => {
    const setup = controllerSetup();
    await setup.rosterService.pair();
    writeFileSync(join(setup.projectRoot, ".opencode", "agents", "orca-builder.md"), "---\nmode: primary\n---\nwrong profile\n");

    await expect(startController(setup.options)).rejects.toThrow("ORCA role profile mismatch: builder");
    expect(existsSync(join(setup.projectRoot, ".orca", "controller.json"))).toBe(false);
  });

  it("refuses a roster whose persisted role-profile fingerprint no longer matches", async () => {
    const setup = controllerSetup();
    const roster = await setup.rosterService.pair();
    roster.bindings[2].rolePromptHash = "tampered-profile-hash";
    setup.persistence.saveRoster(roster);

    await expect(startController(setup.options)).rejects.toThrow("ORCA role profile mismatch: builder");
  });

  it("preserves the winning runtime when concurrent starts race for the controller port", async () => {
    const setup = controllerSetup();
    await setup.rosterService.pair();

    const results = await Promise.allSettled([startController(setup.options), startController(setup.options)]);
    const winner = results.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof startController>>> => result.status === "fulfilled")?.value;

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(winner).toBeDefined();
    if (!winner) throw new Error("controller start race produced no winner");
    expect(readFileSync(join(setup.projectRoot, ".orca", "controller-token"), "utf8").trim()).toBe(winner?.token);
    controllers.push(winner);
  });

  it("refuses to listen when authentication or OpenCode health fails", async () => {
    const setup = controllerSetup();
    setup.adapter.health = async () => { throw new Error("OpenCode authentication failed (401)"); };

    await expect(startController(setup.options)).rejects.toThrow("authentication failed");
    expect(existsSync(join(setup.projectRoot, ".orca", "controller.json"))).toBe(false);
  });
});

async function runningController() {
  const setup = controllerSetup();
  await setup.rosterService.pair();
  const controller = await startController(setup.options);
  controllers.push(controller);
  return { ...controller, projectRoot: setup.projectRoot, options: setup.options };
}

function controllerSetup() {
  const projectRoot = mkdtempSync(join(tmpdir(), "orca-controller-"));
  workspaces.push(projectRoot);
  mkdirSync(join(projectRoot, ".orca"));
  mkdirSync(join(projectRoot, ".opencode", "agents"), { recursive: true });
  for (const profile of roleProfiles) writeFileSync(join(projectRoot, ".opencode", "agents", `orca-${profile.role}.md`), renderRoleProfile(profile));
  const sessions = [1, 2, 3, 4, 5].map((position) => ({ id: `session-${position}`, position, serverBaseUrl: "http://127.0.0.1:4096", projectRoot, model: { providerId: "openai", modelId: "gpt-5" }, title: `Session ${position}`, status: "idle", inFlightToolCalls: 0 }));
  const adapter = new MutableAdapter(sessions);
  const persistence = new MemoryPersistence();
  const rosterService = new RosterService(adapter, persistence);
  return { projectRoot, sessions, adapter, persistence, rosterService, options: { projectRoot, adapter, persistence, version: "0.1.0" } };
}

class MemoryPersistence {
  private roster: PairedRoster | null = null;

  saveRoster(roster: PairedRoster): void { this.roster = roster; }
  getCurrentRoster(): PairedRoster | null { return this.roster; }
}

class MutableAdapter implements OpenCodeLiveAdapter {
  public health = async (): Promise<{ healthy: boolean; version?: string }> => ({ healthy: true, version: "test" });

  constructor(private sessions: OpenCodeSession[]) {}

  async listSessions(): Promise<OpenCodeSession[]> { return this.sessions.map((session) => ({ ...session, model: { ...session.model } })); }
  async getSessionModel(sessionId: string) { return { ...this.requireSession(sessionId).model }; }
  async sendPrompt(input: SessionPrompt): Promise<void> { this.requireSession(input.sessionId); }
  async deliverTask(sessionId: string): Promise<void> { this.requireSession(sessionId); }
  async getSessionStatus(sessionId: string): Promise<SessionStatus> { const session = this.requireSession(sessionId); return { idle: session.status === "idle", inFlightToolCalls: session.inFlightToolCalls }; }
  subscribe(): () => void { return () => {}; }
  async *subscribeEvents(signal: AbortSignal): AsyncIterable<OpenCodeEvent> {
    await new Promise((resolve) => globalThis.setTimeout(resolve, 1));
    if (!signal.aborted) yield { sessionId: "unused", type: "unused" };
  }
  emit(): void {}
  replaceSession(session: OpenCodeSession): void { this.sessions = this.sessions.map((current) => current.id === session.id ? session : current); }

  private requireSession(sessionId: string): OpenCodeSession {
    const session = this.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    return session;
  }
}
