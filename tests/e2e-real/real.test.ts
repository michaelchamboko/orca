import { afterEach, describe, expect, it } from "vitest";
import { URL, URLSearchParams } from "node:url";

import { resolveOpenCodeConnectionConfig } from "../../src/config/opencode-auth.js";
import { RealOpenCodeAdapter } from "../../src/integrations/opencode/real.js";
import { startLauncherUi, type RunningLauncherUi } from "../../src/launcher/server.js";
import { resolveCanonicalProjectRoot, validateLoopbackOpenCodeOrigin } from "../../src/launcher/project.js";
import { assignmentSchema } from "../../src/launcher/contracts.js";
import { roleProfiles } from "../../src/roles/profiles.js";

const isEnabled = process.env.ORCA_REAL_E2E === "1";
const runningLaunchers: RunningLauncherUi[] = [];

afterEach(async () => {
  await Promise.all(runningLaunchers.splice(0).map((launcher) => launcher.stop()));
});

if (isEnabled) {
  describe("real e2e", () => {
    it("drives swarmctl ui against standalone OpenCode through pairing, controller start, and stop", async () => {
      const projectRoot = await resolveCanonicalProjectRoot(process.cwd());
      const connection = await resolveOpenCodeConnectionConfig({ interactive: false });
      validateLoopbackOpenCodeOrigin(connection.baseUrl);
      const adapter = new RealOpenCodeAdapter(connection);
      const launcher = await startLauncherUi({
        projectRoot,
        opencodeOrigin: connection.baseUrl,
        adapter,
        version: "0.1.0",
        port: 0
      });
      runningLaunchers.push(launcher);

      const auth = await bootstrap(launcher);
      let state = await apiJson<Record<string, unknown>>(launcher, "/api/state", auth);
      expect(readPath(state, ["project", "root"])).toBe(projectRoot);
      expect(readPath(state, ["opencode", "healthy"])).toBe(true);

      if (readPath(state, ["assets", "active"]) !== true) {
        state = await apiJson<Record<string, unknown>>(launcher, "/api/assets/install", auth, {});
      }
      if (readPath(state, ["assets", "restartRequired"]) === true) {
        throw new Error("PROFILE_RELOAD_REQUIRED: restart OpenCode after asset installation, then rerun ORCA_REAL_E2E=1.");
      }

      state = await apiJson<Record<string, unknown>>(launcher, "/api/state", auth);
      const sessions = readSessions(state).filter((session) => session.eligible === true);
      expect(sessions).toHaveLength(5);
      const assignments = assignmentSchema.parse(Object.fromEntries(roleProfiles.map((profile, index) => [profile.role, sessions[index]?.id])));

      state = await apiJson<Record<string, unknown>>(launcher, "/api/roster/pair", auth, { assignments });
      expect(readPath(state, ["roster", "present"])).toBe(true);
      expect(readPath(state, ["roster", "drift"])).toBe("none");

      state = await apiJson<Record<string, unknown>>(launcher, "/api/controller/start", auth, {});
      expect(readPath(state, ["controller", "ownership"])).toBe("owned");
      expect(readPath(state, ["controller", "ready"])).toBe(true);
      expect(readPath(state, ["controller", "address"])).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      state = await apiJson<Record<string, unknown>>(launcher, "/api/controller/stop", auth, {});
      expect(readPath(state, ["controller", "ownership"])).toBe("none");
      expect(readPath(state, ["controller", "lifecycle"])).toBe("stopped");
    }, 120_000);
  });
} else {
  describe.skip("real e2e", () => {
    it("requires ORCA_REAL_E2E=1, standalone OpenCode credentials, and exactly five eligible current sessions", () => {
      // Intentionally skipped by default: this lane mutates local ORCA assets,
      // pairs live sessions, and starts a localhost controller.
    });
  });
}

interface LauncherAuth {
  cookie: string;
  csrfToken: string;
}

async function bootstrap(launcher: RunningLauncherUi): Promise<LauncherAuth> {
  const nonce = new URLSearchParams(new URL(launcher.url).hash.slice(1)).get("nonce");
  if (!nonce) throw new Error("launcher URL did not include a bootstrap nonce");
  const response = await fetch(`${launcher.origin}/api/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: launcher.origin },
    body: JSON.stringify({ nonce })
  });
  if (!response.ok) throw new Error(`launcher bootstrap failed with HTTP ${response.status}`);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("launcher bootstrap did not set a session cookie");
  const body = await response.json() as { csrfToken?: unknown };
  if (typeof body.csrfToken !== "string") throw new Error("launcher bootstrap did not return a CSRF token");
  return { cookie, csrfToken: body.csrfToken };
}

async function apiJson<T>(launcher: RunningLauncherUi, path: string, auth: LauncherAuth, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${launcher.origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      cookie: auth.cookie,
      origin: launcher.origin,
      ...(body === undefined ? {} : { "content-type": "application/json", "x-orca-csrf": auth.csrfToken })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`${path} failed with HTTP ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function readSessions(state: Record<string, unknown>): Array<{ id: string; eligible: boolean }> {
  const sessions = state.sessions;
  if (!Array.isArray(sessions)) return [];
  return sessions.flatMap((session) => {
    if (!session || typeof session !== "object" || Array.isArray(session)) return [];
    const record = session as Record<string, unknown>;
    return typeof record.id === "string" && typeof record.eligible === "boolean" ? [{ id: record.id, eligible: record.eligible }] : [];
  });
}
