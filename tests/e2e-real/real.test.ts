import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startController, type ControllerStatus, type RunningController } from "../../src/controller/main.js";
import { captureControlPlaneFingerprint } from "../../src/controller/workspace-fingerprint.js";
import { SqlitePersistence } from "../../src/persistence/sqlite.js";
import { roleProfiles } from "../../src/roles/profiles.js";
import { RealOpenCodeAdapter } from "../../src/integrations/opencode/real.js";
import { RosterService } from "../../src/pairing/roster-service.js";
import type { MissionState, PairedRoster } from "../../src/domain/types.js";

const LIVE_ENV_FLAG = "ORCA_REAL_E2E";
const LIVE_BRANCH_HINT = "ORCA_LIVE_WORKTREE";
const DEFAULT_OPENCODE_URL = process.env.ORCA_OPENCODE_URL ?? "http://127.0.0.1:4096";
const DEFAULT_USERNAME = process.env.ORCA_OPENCODE_USERNAME ?? "opencode";
const DEFAULT_PASSWORD = process.env.ORCA_OPENCODE_PASSWORD ?? "";
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.ORCA_OPENCODE_TIMEOUT_MS ?? "8000", 10);
const ROLE_WAIT_MS = Number.parseInt(process.env.ORCA_LIVE_ROLE_WAIT_MS ?? "120000", 10);
const WHOLE_MISSION_TIMEOUT_MS = Number.parseInt(process.env.ORCA_LIVE_MISSION_TIMEOUT_MS ?? "1800000", 10);
const REQUIRED_BINDING_COUNT = 5;

interface LiveContext {
  projectRoot: string;
  adapter: RealOpenCodeAdapter;
  persistence: SqlitePersistence;
  roster: PairedRoster;
}

const liveState: { enabled: boolean; context: LiveContext | null; controller: RunningController | null } = {
  enabled: false,
  context: null,
  controller: null
};

const isLiveEnabled = process.env[LIVE_ENV_FLAG] === "1";
const worktreeHint = process.env[LIVE_BRANCH_HINT];

if (!isLiveEnabled) {
  describe.skip("real OpenCode five-session live acceptance", () => {
    it("requires ORCA_REAL_E2E=1", () => {
      expect(isLiveEnabled).toBe(false);
    });
  });
} else {
  describe("real OpenCode five-session live acceptance", () => {
    beforeAll(async () => {
      const context = await prepareLiveContext();
      liveState.context = context;
      const controller = await startController({
        projectRoot: context.projectRoot,
        adapter: context.adapter,
        persistence: context.persistence,
        version: "0.1.0-live",
        port: 0
      });
      liveState.controller = controller;
    }, ROLE_WAIT_MS);

    afterAll(async () => {
      const controller = liveState.controller;
      const context = liveState.context;
      liveState.controller = null;
      liveState.context = null;
      if (controller) await controller.stop();
      if (context?.persistence) context.persistence.close();
    });

    it("fails fast unless every prerequisite is met", async () => {
      const context = liveState.context;
      if (!context) throw new Error("live prerequisites must be satisfied before the test runs");
      expect(context.roster.bindings).toHaveLength(REQUIRED_BINDING_COUNT);
      const ids = new Set(context.roster.bindings.map((binding) => binding.sessionId));
      expect(ids.size).toBe(REQUIRED_BINDING_COUNT);
      const models = new Set(context.roster.bindings.map((binding) => `${binding.model.providerId}/${binding.model.modelId}`));
      expect(models.size).toBeGreaterThanOrEqual(2);
      for (const profile of roleProfiles) {
        const profilePath = join(context.projectRoot, ".opencode", "agents", `orca-${profile.role}.md`);
        expect(existsSync(profilePath), `missing role profile: ${profile.role}`).toBe(true);
      }
      const status = await readLiveStatus();
      expect(status.bindingsCurrent, "roster drift was detected").toBe(true);
      expect(status.opencodeHealthy, "OpenCode health check failed").toBe(true);
    });

    it("runs the user objective through the full five-role sequence", async () => {
      const context = liveState.context;
      if (!context) throw new Error("live prerequisites must be satisfied before the test runs");
      const objective = `ORCA live readiness probe at ${new Date().toISOString()}`;
      const orchestrator = context.roster.bindings.find((binding) => binding.role === "orchestrator");
      if (!orchestrator) throw new Error("orchestrator binding missing from roster");
      const userMessageId = `orca-live-user-${Date.now()}`;
      const sent = await context.adapter.sendPrompt({
        messageId: userMessageId,
        sessionId: orchestrator.sessionId,
        agent: "orca-orchestrator",
        model: { ...orchestrator.model },
        content: `[ORCA_CORRELATION:${userMessageId}]\n${objective}`
      }).then(() => true).catch((error) => {
        liveState.enabled = false;
        throw error;
      });
      expect(sent).toBe(true);

      const finalState = await waitForTerminalMissionState(context.persistence, WHOLE_MISSION_TIMEOUT_MS);
      expect(finalState).toBe("completed");

      const missionId = currentMissionId(context) ?? "";
      const events = context.persistence.getMissionEvents(missionId);
      const types = events.map((event) => event.eventType);
      expect(types).toContain("mission.transition");
      expect(types).toContain("approval.recorded");
      expect(types).toContain("orchestrator_action.applied");
    }, WHOLE_MISSION_TIMEOUT_MS);
  });
}

async function prepareLiveContext(): Promise<LiveContext> {
  if (!worktreeHint) {
    throw new Error(`${LIVE_BRANCH_HINT} must point to the isolated worktree (e.g. .worktrees/live-readiness-remediation).`);
  }
  const projectRoot = worktreeHint;
  verifyIsolatedWorktree(projectRoot);
  const fingerprint = captureControlPlaneFingerprint(projectRoot);
  void fingerprint;

  const adapter = new RealOpenCodeAdapter({
    baseUrl: DEFAULT_OPENCODE_URL,
    username: DEFAULT_USERNAME,
    password: DEFAULT_PASSWORD,
    timeoutMs: Number.isFinite(DEFAULT_TIMEOUT_MS) ? DEFAULT_TIMEOUT_MS : 8_000
  });

  const health = await adapter.health().catch(() => ({ healthy: false }));
  if (!health.healthy) throw new Error(`OpenCode server is not reachable at ${DEFAULT_OPENCODE_URL}`);

  const persistence = new SqlitePersistence({ path: join(projectRoot, "state.sqlite") });
  const rosterService = new RosterService(adapter, persistence);
  const current = persistence.getCurrentRoster();
  let roster: PairedRoster;
  try {
    roster = current ? await rosterService.assertCurrent() : await rosterService.pair();
  } catch (error) {
    persistence.close();
    throw error;
  }
  if (roster.bindings.length !== REQUIRED_BINDING_COUNT) {
    persistence.close();
    throw new Error(`roster must contain exactly ${REQUIRED_BINDING_COUNT} paired sessions`);
  }

  applySentinelChange(projectRoot);
  return { projectRoot, adapter, persistence, roster };
}

function verifyIsolatedWorktree(projectRoot: string): void {
  const normalized = projectRoot.replace(/\\/g, "/");
  if (!/\.worktrees\/[^/]+$/i.test(normalized)) {
    throw new Error(`real E2E must run inside an isolated worktree (got ${projectRoot}). Refusing to start against the primary checkout.`);
  }
  const gitHead = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();
  if (gitHead === "main" || gitHead === "master") {
    throw new Error(`real E2E refuses to run on protected branch ${gitHead}; use an isolated worktree branch.`);
  }
}

function applySentinelChange(projectRoot: string): void {
  const sentinelPath = join(projectRoot, ".orca", "live-acceptance-sentinel.md");
  const header = "# ORCA live acceptance sentinel\n\nThis file is created by `tests/e2e-real/real.test.ts` to prove the controller can mutate the worktree. It is left in place for inspection; the test never auto-commits or pushes.\n";
  let current = "";
  try {
    current = readFileSync(sentinelPath, "utf8");
  } catch {
    current = "";
  }
  if (!current.startsWith("# ORCA live acceptance sentinel")) {
    writeFileSync(sentinelPath, header, "utf8");
  }
}

async function readLiveStatus(): Promise<ControllerStatus> {
  const controller = liveState.controller;
  if (!controller) throw new Error("controller is not running");
  const response = await fetch(`http://127.0.0.1:${controller.address.port}/status`, {
    headers: { authorization: `Bearer ${controller.token}` }
  });
  if (!response.ok) throw new Error(`controller status ${response.status}`);
  const body = await response.json() as {
    opencodeHealthy?: boolean;
    rosterCurrent?: boolean;
    bindingCount?: number;
    activeMissionId?: string | null;
    missionState?: string | null;
    currentTaskRole?: string | null;
    currentTaskState?: string | null;
    pendingDispatchCount?: number;
    lastFailureCode?: string | null;
  };
  return {
    running: true,
    reason: "",
    opencodeHealthy: body.opencodeHealthy === true,
    bindingsCurrent: body.rosterCurrent === true,
    bindingCount: typeof body.bindingCount === "number" ? body.bindingCount : undefined
  };
}

function currentMissionId(context: LiveContext): string | null {
  const tasks = context.persistence.listAllTaskExecutions();
  const ids = [...new Set(tasks.map((task) => task.missionId))];
  for (const missionId of ids.reverse()) {
    const mission = context.persistence.getMission(missionId);
    if (mission && !["completed", "failed", "cancelled", "blocked"].includes(mission.state)) return missionId;
  }
  return ids[0] ?? null;
}

async function waitForTerminalMissionState(persistence: SqlitePersistence, timeoutMs: number): Promise<MissionState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tasks = persistence.listAllTaskExecutions();
    for (const task of tasks) {
      const mission = persistence.getMission(task.missionId);
      if (!mission) continue;
      if (["completed", "failed", "cancelled", "blocked"].includes(mission.state)) {
        if (mission.state === "blocked" || mission.state === "failed" || mission.state === "cancelled") {
          const lastFailure = readFailureCode(persistence, task.missionId);
          throw new Error(`Mission ${mission.state}: ${lastFailure ?? "no failure code recorded"}`);
        }
        return mission.state;
      }
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 1_000));
  }
  throw new Error(`Mission did not reach a terminal state within ${timeoutMs}ms`);
}

function readFailureCode(persistence: SqlitePersistence, missionId: string): string | null {
  const events = persistence.getMissionEvents(missionId);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.eventType === "mission.terminal" || event.eventType.startsWith("orchestrator_action.rejected")) {
      const payload = event.payload as Record<string, unknown> | undefined;
      if (payload && typeof payload.reason === "string") return payload.reason;
    }
  }
  return null;
}

void liveState;
