import { afterEach, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OpenCodeLiveAdapter } from "../../src/integrations/opencode/adapter.js";
import type { OpenCodeEvent, OpenCodeMessage, OpenCodeSession, SessionPrompt, SessionStatus } from "../../src/integrations/opencode/types.js";
import { startLauncherUi, type RunningLauncherUi } from "../../src/launcher/server.js";
import { validateLoopbackOpenCodeOrigin } from "../../src/launcher/project.js";
import { openProjectPersistence } from "../../src/persistence/project.js";
import { installOrcaAssets } from "../../src/roles/installer.js";

const workspaces: string[] = [];
const launchers: RunningLauncherUi[] = [];

interface LauncherApiState {
  project: { root: string };
  opencode: { healthy: boolean; version: string | null; error: string | null };
  sessions: unknown[];
}

afterEach(async () => {
  await Promise.all(launchers.splice(0).map((launcher) => launcher.stop()));
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

describe("swarmctl ui launcher API", () => {
  test("serves the page and state without creating project persistence", async () => {
    const projectRoot = workspace();
    const launcher = await launcherFor(projectRoot, new LauncherAdapter(sessions(projectRoot)));

    const page = await fetch(launcher.origin);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("ORCA Launcher");
    expect(existsSync(join(projectRoot, ".orca"))).toBe(false);

    const auth = await bootstrap(launcher);
    const state = await getState(launcher, auth);

    expect(state.project.root).toBe(projectRoot);
    expect(state.sessions).toHaveLength(5);
    expect(existsSync(join(projectRoot, ".orca"))).toBe(false);
  });

  test("rejects non-loopback OpenCode origins", () => {
    expect(validateLoopbackOpenCodeOrigin("http://127.0.0.1:4096")).toBe("http://127.0.0.1:4096");
    expect(() => validateLoopbackOpenCodeOrigin("http://localhost:4096")).toThrow("127.0.0.1");
    expect(() => validateLoopbackOpenCodeOrigin("https://127.0.0.1:4096")).toThrow("127.0.0.1");
    expect(() => validateLoopbackOpenCodeOrigin("file://127.0.0.1:4096")).toThrow("127.0.0.1");
  });

  test("requires origin, cookie, csrf, and JSON for mutations", async () => {
    const projectRoot = workspace();
    const launcher = await launcherFor(projectRoot, new LauncherAdapter(sessions(projectRoot)));
    const auth = await bootstrap(launcher);

    await expect(post(launcher, "/api/assets/install", {}, { ...auth, csrfToken: "" })).resolves.toMatchObject({ status: 401, error: "UNAUTHORIZED" });

    const missingOrigin = await fetch(`${launcher.origin}/api/assets/install`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: auth.cookie, "x-orca-csrf": auth.csrfToken },
      body: "{}"
    });
    expect(missingOrigin.status).toBe(403);

    const wrongType = await fetch(`${launcher.origin}/api/assets/install`, {
      method: "POST",
      headers: { origin: launcher.origin, cookie: auth.cookie, "x-orca-csrf": auth.csrfToken },
      body: "{}"
    });
    expect(wrongType.status).toBe(415);
  });

  test("pairs only the fixed five roles and preserves heterogeneous OpenCode models", async () => {
    const projectRoot = workspace();
    installOrcaAssets(projectRoot);
    const launcher = await launcherFor(projectRoot, new LauncherAdapter(sessions(projectRoot)));
    const auth = await bootstrap(launcher);

    const response = await post(launcher, "/api/roster/pair", { assignments: assignments() }, auth);

    expect(response.status).toBe(200);
    const persistence = openProjectPersistence(projectRoot);
    try {
      const roster = persistence.getCurrentRoster();
      expect(roster?.bindings.map((binding) => binding.role)).toEqual(["orchestrator", "planner", "builder", "reviewer", "tester"]);
      expect(roster?.bindings.map((binding) => binding.model.modelId)).toEqual(["gpt-5", "gpt-5-mini", "north-mini-code-free", "gpt-5-review", "gpt-5-test"]);
    } finally {
      persistence.close();
    }
  });

  test("starts and stops a UI-owned controller through the launcher API", async () => {
    const projectRoot = workspace();
    installOrcaAssets(projectRoot);
    const launcher = await launcherFor(projectRoot, new LauncherAdapter(sessions(projectRoot)));
    const auth = await bootstrap(launcher);
    await post(launcher, "/api/roster/pair", { assignments: assignments() }, auth);

    const started = await post(launcher, "/api/controller/start", {}, auth);
    expect(started.status).toBe(200);
    expect((started.controller as { ownership?: unknown }).ownership).toBe("owned");

    const stopped = await post(launcher, "/api/controller/stop", {}, auth);
    expect(stopped.status).toBe(200);
    expect((stopped.controller as { ownership?: unknown }).ownership).toBe("none");
  });

  test("rejects a selected session whose directory is missing from OpenCode evidence", async () => {
    const projectRoot = workspace();
    installOrcaAssets(projectRoot);
    const candidateSessions = sessions(projectRoot);
    candidateSessions[2] = { ...candidateSessions[2], projectRoot: "" };
    const launcher = await launcherFor(projectRoot, new LauncherAdapter(candidateSessions));
    const auth = await bootstrap(launcher);

    const response = await post(launcher, "/api/roster/pair", { assignments: assignments() }, auth);

    expect(response).toMatchObject({ status: 409, error: "SESSION_CHANGED" });
  });

  test("probes OpenCode health and surfaces the adapter error verbatim", async () => {
    const projectRoot = workspace();
    const adapter = new LauncherAdapter(sessions(projectRoot));
    const originalHealth = adapter.health.bind(adapter);
    (adapter as unknown as { health: () => Promise<{ healthy: boolean }> }).health = async () => {
      throw new Error("OpenCode authentication failed (401). Check OPENCODE_SERVER_USERNAME and OPENCODE_SERVER_PASSWORD.");
    };
    const launcher = await launcherFor(projectRoot, adapter);
    const auth = await bootstrap(launcher);

    const probe = await post(launcher, "/api/opencode/test", {}, auth);
    expect(probe.status).toBe(502);
    expect(probe).toMatchObject({ healthy: false, origin: "http://127.0.0.1:4096" });
    expect(String(probe.error)).toContain("401");

    (adapter as unknown as { health: () => Promise<{ healthy: boolean }> }).health = originalHealth;
    const ok = await post(launcher, "/api/opencode/test", {}, auth);
    expect(ok.status).toBe(200);
    expect(ok).toMatchObject({ healthy: true, origin: "http://127.0.0.1:4096" });
  });

  test("exposes the OpenCode error string in /api/state when health fails", async () => {
    const projectRoot = workspace();
    const adapter = new LauncherAdapter(sessions(projectRoot));
    (adapter as unknown as { health: () => Promise<{ healthy: boolean }> }).health = async () => {
      throw new Error("OpenCode request to /global/health failed with HTTP 401.");
    };
    const launcher = await launcherFor(projectRoot, adapter);
    const auth = await bootstrap(launcher);

    const state = await getState(launcher, auth);
    expect(state.opencode.healthy).toBe(false);
    expect(String(state.opencode.error)).toContain("401");
  });
});

async function launcherFor(projectRoot: string, adapter: OpenCodeLiveAdapter): Promise<RunningLauncherUi> {
  const launcher = await startLauncherUi({ projectRoot, opencodeOrigin: "http://127.0.0.1:4096", adapter, version: "0.1.0" });
  launchers.push(launcher);
  return launcher;
}

async function bootstrap(launcher: RunningLauncherUi): Promise<{ cookie: string; csrfToken: string }> {
  const nonce = new URL(launcher.url).hash.replace("#nonce=", "");
  const response = await fetch(`${launcher.origin}/api/bootstrap`, {
    method: "POST",
    headers: { origin: launcher.origin, "content-type": "application/json" },
    body: JSON.stringify({ nonce })
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  const body = await response.json() as { csrfToken: string };
  return { cookie, csrfToken: body.csrfToken };
}

async function getState(launcher: RunningLauncherUi, auth: { cookie: string }): Promise<LauncherApiState> {
  const response = await fetch(`${launcher.origin}/api/state`, { headers: { cookie: auth.cookie } });
  expect(response.status).toBe(200);
  return response.json() as Promise<LauncherApiState>;
}

async function post(launcher: RunningLauncherUi, path: string, body: unknown, auth: { cookie: string; csrfToken: string }): Promise<Record<string, unknown> & { status: number }> {
  const response = await fetch(`${launcher.origin}${path}`, {
    method: "POST",
    headers: { origin: launcher.origin, "content-type": "application/json", cookie: auth.cookie, "x-orca-csrf": auth.csrfToken },
    body: JSON.stringify(body)
  });
  const parsed = await response.json() as Record<string, unknown>;
  return { status: response.status, ...parsed };
}

function workspace(): string {
  const path = mkdtempSync(join(tmpdir(), "orca-ui-"));
  workspaces.push(path);
  return path;
}

function assignments(): Record<string, string> {
  return {
    orchestrator: "session-1",
    planner: "session-2",
    builder: "session-3",
    reviewer: "session-4",
    tester: "session-5"
  };
}

function sessions(projectRoot: string): OpenCodeSession[] {
  return [
    session(projectRoot, 1, "openai", "gpt-5"),
    session(projectRoot, 2, "openai", "gpt-5-mini"),
    session(projectRoot, 3, "opencode", "north-mini-code-free"),
    session(projectRoot, 4, "anthropic", "gpt-5-review"),
    session(projectRoot, 5, "google", "gpt-5-test")
  ];
}

function session(projectRoot: string, position: number, providerId: string, modelId: string): OpenCodeSession {
  return {
    id: `session-${position}`,
    position,
    serverBaseUrl: "http://127.0.0.1:4096",
    projectRoot,
    model: { providerId, modelId },
    title: `Session ${position}`,
    status: "idle",
    inFlightToolCalls: 0,
    lastActivity: "2026-07-30T07:00:00.000Z"
  };
}

class LauncherAdapter implements OpenCodeLiveAdapter {
  constructor(private readonly candidateSessions: OpenCodeSession[]) {}

  async health(): Promise<{ healthy: boolean; version?: string }> { return { healthy: true, version: "test" }; }
  async listSessions(): Promise<OpenCodeSession[]> { return this.candidateSessions.map((session) => ({ ...session, model: { ...session.model } })); }
  async getSessionModel(sessionId: string) { return { ...this.requireSession(sessionId).model }; }
  async listMessages(): Promise<OpenCodeMessage[]> { return []; }
  async getMessage(): Promise<OpenCodeMessage> { throw new Error("messages are not used by launcher API tests"); }
  async sendPrompt(input: SessionPrompt): Promise<void> { this.requireSession(input.sessionId); }
  async deliverTask(sessionId: string): Promise<void> { this.requireSession(sessionId); }
  async getSessionStatus(sessionId: string): Promise<SessionStatus> {
    const candidate = this.requireSession(sessionId);
    return { idle: candidate.status === "idle", inFlightToolCalls: candidate.inFlightToolCalls };
  }
  subscribe(): () => void { return () => {}; }
  async *subscribeEvents(signal: AbortSignal): AsyncIterable<OpenCodeEvent> {
    while (!signal.aborted) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 10));
      if (signal.aborted) return;
      yield { type: "heartbeat" };
    }
  }

  private requireSession(sessionId: string): OpenCodeSession {
    const session = this.candidateSessions.find((candidate) => candidate.id === sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    return session;
  }
}
