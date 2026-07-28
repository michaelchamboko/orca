import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startController, type RunningController } from "../../src/controller/main.js";
import { captureControlPlaneFingerprint } from "../../src/controller/workspace-fingerprint.js";
import { SqlitePersistence } from "../../src/persistence/sqlite.js";
import { roleProfiles } from "../../src/roles/profiles.js";
import { renderRoleProfile } from "../../src/roles/installer.js";
import { RosterService } from "../../src/pairing/roster-service.js";
import { RealOpenCodeAdapter } from "../../src/integrations/opencode/real.js";
import type { MissionState, PairedRoster } from "../../src/domain/types.js";

const LIVE_ENV_FLAG = "ORCA_REAL_E2E";
const LIVE_WORKTREE_ENV = "ORCA_LIVE_WORKTREE";
const SENTINEL_RELATIVE_PATH = "docs/orca-live-acceptance-sentinel.md";
const RESERVED_MARKERS = ["[ORCA_CORRELATION:", "[ORCA_DISPATCH:"] as const;

const DEFAULT_OPENCODE_URL = process.env.ORCA_OPENCODE_URL ?? "http://127.0.0.1:4096";
const DEFAULT_USERNAME = process.env.ORCA_OPENCODE_USERNAME ?? "opencode";
const DEFAULT_PASSWORD = process.env.ORCA_OPENCODE_PASSWORD ?? "";
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.ORCA_OPENCODE_TIMEOUT_MS ?? "8000", 10);
const ROLE_WAIT_MS = Number.parseInt(process.env.ORCA_LIVE_ROLE_WAIT_MS ?? "120000", 10);
const WHOLE_MISSION_TIMEOUT_MS = Number.parseInt(process.env.ORCA_LIVE_MISSION_TIMEOUT_MS ?? "1800000", 10);
const REQUIRED_BINDING_COUNT = roleProfiles.length;

const isLiveEnabled = process.env[LIVE_ENV_FLAG] === "1";
const worktreeHint = process.env[LIVE_WORKTREE_ENV];

if (!isLiveEnabled) {
  describe.skip("real OpenCode five-session live acceptance", () => {
    it("requires ORCA_REAL_E2E=1 and ORCA_LIVE_WORKTREE", () => {
      expect(isLiveEnabled).toBe(false);
    });
  });
} else {
  describe("real OpenCode five-session live acceptance", () => {
    let controller: RunningController | null = null;
    let persistence: SqlitePersistence | null = null;
    let adapter: RealOpenCodeAdapter | null = null;
    let roster: PairedRoster | null = null;
    let runId = "";

    beforeAll(async () => {
      const context = await prepareLiveContext();
      persistence = context.persistence;
      adapter = context.adapter;
      roster = context.roster;
      runId = context.runId;
      controller = await startController({
        projectRoot: context.projectRoot,
        adapter: context.adapter,
        persistence: context.persistence,
        version: "0.1.0-live",
        port: 0
      });
    }, ROLE_WAIT_MS);

    afterAll(async () => {
      if (controller) await controller.stop();
      if (persistence) persistence.close();
    });

    it("accepts a plain Session 1 user objective and proves the Builder-created sentinel", async () => {
      if (!adapter || !persistence || !roster || !controller) throw new Error("live prerequisites must be satisfied");
      const orchestrator = roster.bindings.find((binding) => binding.role === "orchestrator");
      if (!orchestrator) throw new Error("orchestrator binding missing from roster");
      const objective = [
        "ORCA live acceptance probe.",
        `Run id: ${runId}.`,
        `Sentinel path: ${SENTINEL_RELATIVE_PATH}.`,
        "Create the sentinel file with the run id in its body and leave it in place."
      ].join(" ");
      const userMessageId = `orca-live-user-${runId}`;
      await adapter.sendPrompt({
        messageId: userMessageId,
        sessionId: orchestrator.sessionId,
        agent: "orca-orchestrator",
        model: { ...orchestrator.model },
        content: objective
      });

      const finalState = await waitForTerminalMissionState(persistence, WHOLE_MISSION_TIMEOUT_MS);
      expect(finalState).toBe("completed");

      const sentinelPath = join(worktreeHint ?? process.cwd(), SENTINEL_RELATIVE_PATH);
      const sentinelContents = readFileSync(sentinelPath, "utf8");
      expect(sentinelContents).toContain(runId);

      const missionId = await currentMissionId(persistence);
      expect(missionId).toBeTruthy();
      if (!missionId) throw new Error("expected a mission id");
      const builderTasks = persistence.listAllTaskExecutions().filter((task) => task.missionId === missionId && task.role === "builder");
      expect(builderTasks.length).toBeGreaterThan(0);
      const builderEvidence = builderTasks.at(-1)?.result;
      const builderChangedFiles = builderEvidence && "changedFiles" in builderEvidence ? builderEvidence.changedFiles : [];
      expect(builderEvidence?.summary ?? "").toContain(SENTINEL_RELATIVE_PATH);
      expect(builderChangedFiles).toContain(SENTINEL_RELATIVE_PATH);

      const events = persistence.getMissionEvents(missionId);
      const eventTypes = events.map((event) => event.eventType);
      expect(eventTypes).toContain("mission.transition");
      expect(eventTypes).toContain("approval.recorded");
      expect(eventTypes).toContain("orchestrator_action.applied");
      expect(eventTypes).toContain("completion.requested");
      expect(eventTypes).toContain("mission.terminal");

      const dispatches = persistence.getPendingDispatches(1_000).concat(
        Array.from({ length: 0 }, () => ({} as never))
      );
      const acceptedDispatches = dispatches.filter((dispatch) => dispatch.acknowledgedAt !== null);
      for (const dispatch of acceptedDispatches) {
        const binding = roster.bindings.find((candidate) => candidate.sessionId === dispatch.targetSessionId);
        if (!binding) throw new Error(`dispatch targeted an unknown session: ${dispatch.targetSessionId}`);
        expect(`${dispatch.capturedModel.providerId}/${dispatch.capturedModel.modelId}`).toBe(`${binding.model.providerId}/${binding.model.modelId}`);
      }

      const reviewerTasks = persistence.listAllTaskExecutions().filter((task) => task.missionId === missionId && task.role === "reviewer");
      const testerTasks = persistence.listAllTaskExecutions().filter((task) => task.missionId === missionId && task.role === "tester");
      expect(reviewerTasks.length).toBeGreaterThan(0);
      expect(testerTasks.length).toBeGreaterThan(0);
    }, WHOLE_MISSION_TIMEOUT_MS);
  });
}

interface PreparedLiveContext {
  projectRoot: string;
  adapter: RealOpenCodeAdapter;
  persistence: SqlitePersistence;
  roster: PairedRoster;
  runId: string;
}

async function prepareLiveContext(): Promise<PreparedLiveContext> {
  if (!worktreeHint) throw new Error(`${LIVE_WORKTREE_ENV} must point to the isolated worktree (e.g. .worktrees/live-readiness-remediation).`);
  const projectRoot = worktreeHint;
  verifyIsolatedWorktree(projectRoot);
  rejectRootStateSqlite(projectRoot);
  rejectReservedMarkerInObjective(process.env.ORCA_LIVE_OBJECTIVE ?? "");
  const orcaDir = join(projectRoot, ".orca");
  if (!existsSync(join(orcaDir, "orca.db"))) throw new Error(`missing authoritative ORCA database at ${join(orcaDir, "orca.db")}; run swarmctl pair in this worktree first.`);
  rejectExistingSentinel(projectRoot);

  const adapter = new RealOpenCodeAdapter({
    baseUrl: DEFAULT_OPENCODE_URL,
    username: DEFAULT_USERNAME,
    password: DEFAULT_PASSWORD,
    timeoutMs: Number.isFinite(DEFAULT_TIMEOUT_MS) ? DEFAULT_TIMEOUT_MS : 8_000
  });
  const health = await adapter.health().catch(() => ({ healthy: false }));
  if (!health.healthy) throw new Error(`OpenCode server is not reachable at ${DEFAULT_OPENCODE_URL}; check authentication and availability.`);

  const persistence = new SqlitePersistence({ path: join(orcaDir, "orca.db") });
  const rosterService = new RosterService(adapter, persistence);
  let roster: PairedRoster;
  try {
    roster = await rosterService.assertCurrent();
  } catch (error) {
    persistence.close();
    throw error;
  }

  if (roster.bindings.length !== REQUIRED_BINDING_COUNT) {
    persistence.close();
    throw new Error(`paired roster must contain exactly ${REQUIRED_BINDING_COUNT} bindings (got ${roster.bindings.length}).`);
  }
  if (roster.projectRoot !== projectRoot) {
    persistence.close();
    throw new Error(`paired roster points at ${roster.projectRoot}; refusing to run against ${projectRoot}.`);
  }
  for (const binding of roster.bindings) {
    if (!binding.model.providerId || !binding.model.modelId) {
      persistence.close();
      throw new Error(`paired model missing for ${binding.role} session ${binding.sessionId}; re-pair with non-empty models.`);
    }
  }
  if (persistence.hasActiveMission()) {
    persistence.close();
    throw new Error(`another mission is already active; complete or cancel it before running the live acceptance suite.`);
  }
  captureControlPlaneFingerprint(projectRoot);

  const runId = `orca-live-${new Date().toISOString().replace(/[^0-9]/g, "")}-${randomSuffix()}`;
  return { projectRoot, adapter, persistence, roster, runId };
}

function verifyIsolatedWorktree(projectRoot: string): void {
  const normalized = projectRoot.replace(/\\/g, "/");
  if (!/\.worktrees\/[^/]+$/i.test(normalized)) {
    throw new Error(`real E2E must run inside an isolated worktree (got ${projectRoot}); set ${LIVE_WORKTREE_ENV} to a .worktrees/<name> path.`);
  }
  const gitHead = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();
  if (gitHead === "main" || gitHead === "master") {
    throw new Error(`real E2E refuses to run on protected branch ${gitHead}; use an isolated worktree branch.`);
  }
}

function rejectRootStateSqlite(projectRoot: string): void {
  const forbidden = join(projectRoot, "state.sqlite");
  if (existsSync(forbidden)) {
    throw new Error(`refusing to run: root-level state.sqlite exists at ${forbidden}; the live test must use .orca/orca.db.`);
  }
}

function rejectReservedMarkerInObjective(objective: string): void {
  for (const marker of RESERVED_MARKERS) {
    if (objective.includes(marker)) {
      throw new Error(`objective contains reserved marker ${marker}; live test must send a plain user objective.`);
    }
  }
}

function rejectExistingSentinel(projectRoot: string): void {
  const sentinelPath = join(projectRoot, SENTINEL_RELATIVE_PATH);
  if (existsSync(sentinelPath)) {
    throw new Error(`sentinel already exists at ${sentinelPath}; the live test never deletes it. Remove the sentinel manually after inspecting the prior run.`);
  }
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

async function currentMissionId(persistence: SqlitePersistence): Promise<string | null> {
  const tasks = persistence.listAllTaskExecutions();
  const ids = [...new Set(tasks.map((task) => task.missionId))];
  for (const missionId of ids.reverse()) {
    const mission = persistence.getMission(missionId);
    if (!mission) continue;
    if (!["completed", "failed", "cancelled", "blocked"].includes(mission.state)) return missionId;
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

void {} as never;

describe("live acceptance prerequisite failures", () => {
  const workspaces: string[] = [];
  const persistences: SqlitePersistence[] = [];

  afterAll(() => {
    for (const persistence of persistences.splice(0)) persistence.close();
    for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
  });

  function setupIsolatedWorkspace(): string {
    const root = mkdtempSync(join(tmpdir(), "orca-live-prereq-"));
    workspaces.push(root);
    mkdirSync(join(root, ".opencode", "agents"), { recursive: true });
    for (const profile of roleProfiles) writeFileSync(join(root, ".opencode", "agents", `orca-${profile.role}.md`), renderRoleProfile(profile));
    return root;
  }

  it("rejects the live test when ORCA_REAL_E2E is not set", () => {
    expect(isLiveEnabled).toBe(false);
  });

  it("rejects a reserved marker in the supplied objective", () => {
    expect(() => rejectReservedMarkerInObjective("hello [ORCA_CORRELATION:abc]")).toThrow(/reserved marker/);
    expect(() => rejectReservedMarkerInObjective("plain objective")).not.toThrow();
  });

  it("rejects a root-level state.sqlite", () => {
    const root = setupIsolatedWorkspace();
    writeFileSync(join(root, "state.sqlite"), "");
    expect(() => rejectRootStateSqlite(root)).toThrow(/state.sqlite/);
    rmSync(join(root, "state.sqlite"));
    expect(() => rejectRootStateSqlite(root)).not.toThrow();
  });

  it("rejects an existing sentinel", () => {
    const root = setupIsolatedWorkspace();
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, SENTINEL_RELATIVE_PATH), "stale");
    expect(() => rejectExistingSentinel(root)).toThrow(/sentinel already exists/);
    rmSync(join(root, SENTINEL_RELATIVE_PATH));
    expect(() => rejectExistingSentinel(root)).not.toThrow();
  });

  it("rejects non-worktree project roots", () => {
    const root = setupIsolatedWorkspace();
    expect(() => verifyIsolatedWorktree(root)).toThrow(/isolated worktree/);
  });

  it("rejects the protected main branch", () => {
    const root = setupIsolatedWorkspace();
    mkdirSync(join(root, ".worktrees", "test"), { recursive: true });
    expect(() => verifyIsolatedWorktree(join(root, ".worktrees", "test"))).toThrow();
  });
});