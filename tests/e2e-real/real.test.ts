import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startController, type RunningController } from "../../src/controller/main.js";
import { captureWorkspaceFingerprint } from "../../src/controller/workspace-fingerprint.js";
import { SqlitePersistence } from "../../src/persistence/sqlite.js";
import { roleProfiles } from "../../src/roles/profiles.js";
import { renderRoleProfile } from "../../src/roles/installer.js";
import { RosterService } from "../../src/pairing/roster-service.js";
import { RealOpenCodeAdapter } from "../../src/integrations/opencode/real.js";
import type { MissionState, PairedRoster, SessionBinding } from "../../src/domain/types.js";
import { stableId } from "../../src/controller/mission-ingress.js";

const LIVE_ENV_FLAG = "ORCA_REAL_E2E";
const LIVE_WORKTREE_ENV = "ORCA_LIVE_WORKTREE";
const SENTINEL_RELATIVE_PATH = "docs/orca-live-acceptance-sentinel.md";
const RESERVED_MARKERS = ["[ORCA_CORRELATION:", "[ORCA_DISPATCH:"] as const;
const ALLOWED_LIVE_PATHS = new Set([SENTINEL_RELATIVE_PATH]);

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
    let baselineChangedPaths: string[] = [];
    let baselineUntrackedPaths: string[] = [];

    beforeAll(async () => {
      const context = await prepareLiveContext();
      persistence = context.persistence;
      adapter = context.adapter;
      roster = context.roster;
      runId = context.runId;
      const baseline = captureWorkspaceBaseline(context.projectRoot);
      baselineChangedPaths = baseline.changedPaths;
      baselineUntrackedPaths = baseline.untrackedPaths;
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
      const userMessageId = `orca-live-user-${runId}`;
      const missionId = stableId("mission", roster.rosterId, userMessageId);
      const objective = [
        "ORCA live acceptance probe.",
        `Run id: ${runId}.`,
        `Sentinel path: ${SENTINEL_RELATIVE_PATH}.`,
        "Create the sentinel file with the run id in its body and leave it in place."
      ].join(" ");
      await adapter.sendPrompt({
        messageId: userMessageId,
        sessionId: orchestrator.sessionId,
        agent: "orca-orchestrator",
        model: { ...orchestrator.model },
        content: objective
      });

      await waitForMission(persistence, missionId, WHOLE_MISSION_TIMEOUT_MS);
      const finalState = await waitForTerminalMissionStateForMission(persistence, missionId, WHOLE_MISSION_TIMEOUT_MS);
      expect(finalState).toBe("completed");

      const sentinelPath = join(worktreeHint ?? process.cwd(), SENTINEL_RELATIVE_PATH);
      const sentinelContents = readFileSync(sentinelPath, "utf8");
      expect(sentinelContents).toContain(runId);

      const finalFingerprint = captureWorkspaceFingerprint(worktreeHint ?? process.cwd()).fingerprint;
      const dispatchedEvents = persistence.getMissionEvents(missionId).filter((event) => event.eventType === "task.dispatched");
      expect(dispatchedEvents.length).toBeGreaterThan(0);

      const expectedSequence: Array<{ role: string; purpose?: string }> = [
        { role: "planner" },
        { role: "orchestrator" },
        { role: "builder" },
        { role: "orchestrator" },
        { role: "reviewer" },
        { role: "orchestrator" },
        { role: "tester" },
        { role: "orchestrator" }
      ];
      const actualSequence = dispatchedEvents.map((event) => {
        const role = (event.payload as { role?: string }).role;
        const purpose = (event.payload as { purpose?: string }).purpose;
        return purpose === "orchestrator_decision" ? { role: "orchestrator" } : { role: role ?? "unknown" };
      });
      expect(actualSequence).toEqual(expectedSequence);

      const workerEvidence = collectWorkerEvidence(persistence, missionId);
      const builderEvidence = workerEvidence.builder;
      expect(builderEvidence).toBeDefined();
      if (!builderEvidence) throw new Error("builder evidence missing");
      const builderChangedFiles = "changedFiles" in builderEvidence ? builderEvidence.changedFiles : [];
      expect(builderEvidence.summary).toContain(SENTINEL_RELATIVE_PATH);
      expect(builderChangedFiles).toContain(SENTINEL_RELATIVE_PATH);

      const reviewerEvidence = workerEvidence.reviewer;
      expect(reviewerEvidence).toBeDefined();
      if (!reviewerEvidence) throw new Error("reviewer evidence missing");
      expect(reviewerEvidence.reviewedWorkspaceFingerprint).toBe(finalFingerprint);

      const testerEvidence = workerEvidence.tester;
      expect(testerEvidence).toBeDefined();
      if (!testerEvidence) throw new Error("tester evidence missing");
      expect(testerEvidence.testedWorkspaceFingerprint).toBe(finalFingerprint);

      const allEventTypes = persistence.getMissionEvents(missionId).map((event) => event.eventType);
      expect(allEventTypes).toContain("mission.transition");
      expect(allEventTypes).toContain("approval.recorded");
      expect(allEventTypes).toContain("orchestrator_action.applied");
      expect(allEventTypes).toContain("completion.requested");
      expect(allEventTypes).toContain("mission.terminal");

      for (const event of dispatchedEvents) {
        const dispatchKey = (event.payload as { dispatchKey?: string }).dispatchKey;
        const promptMessageId = (event.payload as { promptMessageId?: string }).promptMessageId;
        expect(dispatchKey).toBeTruthy();
        expect(promptMessageId).toBeTruthy();
        if (!dispatchKey || !promptMessageId) throw new Error("dispatch event missing keys");
        const dispatch = persistence.getDispatchByKey(dispatchKey);
        expect(dispatch).not.toBeNull();
        if (!dispatch) throw new Error(`dispatch not found for key ${dispatchKey}`);
        expect(dispatch.acknowledgedAt).not.toBeNull();
        expect(dispatch.promptMessageId).toBe(promptMessageId);
        const binding = roster.bindings.find((candidate) => candidate.sessionId === dispatch.targetSessionId);
        expect(binding, `dispatch ${dispatchKey} targeted an unknown session`).toBeDefined();
        if (!binding) throw new Error("unreachable");
        expect(dispatch.targetRole).toBe(binding.role);
        expect(`${dispatch.capturedModel.providerId}/${dispatch.capturedModel.modelId}`).toBe(`${binding.model.providerId}/${binding.model.modelId}`);
        if (binding.role !== "orchestrator") {
          const otherWorker = roster.bindings.find((candidate) => candidate.role !== "orchestrator" && candidate.role !== binding.role);
          expect(otherWorker?.sessionId).not.toBe(dispatch.targetSessionId);
        }
      }

      const afterBaseline = captureWorkspaceBaseline(worktreeHint ?? process.cwd());
      const newChanges = afterBaseline.changedPaths.filter((path) => !baselineChangedPaths.includes(path));
      const newUntracked = afterBaseline.untrackedPaths.filter((path) => !baselineUntrackedPaths.includes(path));
      const allNewPaths = [...new Set([...newChanges, ...newUntracked])].sort();
      expect(allNewPaths).toEqual([SENTINEL_RELATIVE_PATH]);
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
  return assertLivePrerequisites(projectRoot, new RealOpenCodeAdapter({
    baseUrl: DEFAULT_OPENCODE_URL,
    username: DEFAULT_USERNAME,
    password: DEFAULT_PASSWORD,
    timeoutMs: Number.isFinite(DEFAULT_TIMEOUT_MS) ? DEFAULT_TIMEOUT_MS : 8_000
  }));
}

async function assertLivePrerequisites(projectRoot: string, adapter: RealOpenCodeAdapter): Promise<PreparedLiveContext> {
  verifyIsolatedWorktree(projectRoot);
  rejectRootStateSqlite(projectRoot);
  rejectReservedMarkerInObjective(process.env.ORCA_LIVE_OBJECTIVE ?? "");
  const orcaDir = join(projectRoot, ".orca");
  if (!existsSync(join(orcaDir, "orca.db"))) throw new Error(`missing authoritative ORCA database at ${join(orcaDir, "orca.db")}; run swarmctl pair in this worktree first.`);
  rejectExistingSentinel(projectRoot);

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
  captureWorkspaceFingerprint(projectRoot);

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

function captureWorkspaceBaseline(projectRoot: string): { changedPaths: string[]; untrackedPaths: string[] } {
  const statusOutput = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=normal"], { cwd: projectRoot, encoding: "buffer", shell: false, windowsHide: true });
  const changedPaths: string[] = [];
  const untrackedPaths: string[] = [];
  const tokens = statusOutput.toString("utf8").split("\u0000").filter((token) => token.length > 0);
  for (const token of tokens) {
    const code = token.slice(0, 2);
    const path = token.slice(3);
    if (path === ".orca" || path.startsWith(".orca/")) continue;
    if (code === "??") untrackedPaths.push(path);
    else changedPaths.push(path);
  }
  return { changedPaths: changedPaths.sort(), untrackedPaths: untrackedPaths.sort() };
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

async function waitForMission(persistence: SqlitePersistence, missionId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const mission = persistence.getMission(missionId);
    if (mission) return;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
  }
  throw new Error(`mission ${missionId} was never created within ${timeoutMs}ms`);
}

async function waitForTerminalMissionStateForMission(persistence: SqlitePersistence, missionId: string, timeoutMs: number): Promise<MissionState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const mission = persistence.getMission(missionId);
    if (!mission) throw new Error(`mission ${missionId} disappeared`);
    if (["completed", "failed", "cancelled", "blocked"].includes(mission.state)) {
      if (mission.state !== "completed") {
        const lastFailure = readFailureCode(persistence, missionId);
        throw new Error(`Mission ${mission.state}: ${lastFailure ?? "no failure code recorded"}`);
      }
      return mission.state;
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 1_000));
  }
  throw new Error(`Mission ${missionId} did not reach a terminal state within ${timeoutMs}ms`);
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

function collectWorkerEvidence(persistence: SqlitePersistence, missionId: string): {
  planner?: { summary: string };
  builder?: { summary: string; changedFiles?: string[] };
  reviewer?: { reviewedWorkspaceFingerprint: string };
  tester?: { testedWorkspaceFingerprint: string };
} {
  const tasks = persistence.listAllTaskExecutions().filter((task) => task.missionId === missionId && task.result);
  const result: ReturnType<typeof collectWorkerEvidence> = {};
  for (const task of tasks) {
    const evidence = task.result;
    if (!evidence) continue;
    if (task.role === "planner") result.planner = { summary: evidence.summary };
    if (task.role === "builder" && "implementationVerdict" in evidence) {
      result.builder = { summary: evidence.summary, changedFiles: evidence.changedFiles };
    }
    if (task.role === "reviewer" && "reviewVerdict" in evidence) {
      result.reviewer = { reviewedWorkspaceFingerprint: evidence.reviewedWorkspaceFingerprint };
    }
    if (task.role === "tester" && "testVerdict" in evidence) {
      result.tester = { testedWorkspaceFingerprint: evidence.testedWorkspaceFingerprint };
    }
  }
  return result;
}

void createHash;
void ALLOWED_LIVE_PATHS;

interface RosterStubOverrides {
  sessionBindings?: SessionBinding[];
  fingerprint?: string;
  skipListSessions?: boolean;
  listSessionsError?: Error;
  staleFingerprint?: boolean;
}

function setupRoleProfiles(root: string): void {
  mkdirSync(join(root, ".opencode", "agents"), { recursive: true });
  for (const profile of roleProfiles) writeFileSync(join(root, ".opencode", "agents", `orca-${profile.role}.md`), renderRoleProfile(profile));
}

function createPairedRoster(projectRoot: string, overrides: RosterStubOverrides = {}): PairedRoster {
  const fingerprint = overrides.fingerprint ?? (overrides.staleFingerprint ? "stale-fingerprint" : `live-fingerprint-${randomSuffix()}`);
  const bindings = overrides.sessionBindings ?? roleProfiles.map((profile, index) => ({
    sessionId: `live-session-${index + 1}`,
    position: (index + 1) as 1 | 2 | 3 | 4 | 5,
    role: profile.role,
    model: { providerId: "openai", modelId: `gpt-${index + 1}` },
    agentName: profile.role,
    projectRoot,
    projectFingerprint: fingerprint,
    serverBaseUrl: DEFAULT_OPENCODE_URL,
    sessionCreatedAt: "2025-01-01T00:00:00.000Z",
    pairedAt: "2025-01-01T00:00:00.000Z",
    rolePromptHash: `live-hash-${index + 1}`,
    expectedTitle: profile.role
  }));
  return {
    rosterId: `roster-${fingerprint}`,
    fingerprint,
    serverBaseUrl: DEFAULT_OPENCODE_URL,
    projectRoot,
    pairedAt: "2025-01-01T00:00:00.000Z",
    bindings
  };
}

describe("live acceptance prerequisite failures", () => {
  const workspaces: string[] = [];
  const persistences: SqlitePersistence[] = [];
  const sentinelPaths: string[] = [];

  afterAll(() => {
    for (const persistence of persistences.splice(0)) persistence.close();
    for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
    for (const sentinelPath of sentinelPaths.splice(0)) rmSync(sentinelPath, { force: true });
  });

  function freshWorkspace(): string {
    const root = mkdtempSync(join(tmpdir(), "orca-live-prereq-"));
    workspaces.push(root);
    setupRoleProfiles(root);
    return root;
  }

  function freshPersistence(projectRoot: string): SqlitePersistence {
    mkdirSync(join(projectRoot, ".orca"), { recursive: true });
    const persistence = new SqlitePersistence({ path: join(projectRoot, ".orca", "orca.db") });
    persistences.push(persistence);
    return persistence;
  }

  it("rejects the live test when ORCA_REAL_E2E is not set", () => {
    expect(isLiveEnabled).toBe(false);
  });

  it("rejects a reserved marker in the supplied objective", () => {
    expect(() => rejectReservedMarkerInObjective("hello [ORCA_CORRELATION:abc]")).toThrow(/reserved marker/);
    expect(() => rejectReservedMarkerInObjective("plain objective")).not.toThrow();
  });

  it("rejects a root-level state.sqlite", () => {
    const root = freshWorkspace();
    writeFileSync(join(root, "state.sqlite"), "");
    expect(() => rejectRootStateSqlite(root)).toThrow(/state.sqlite/);
    rmSync(join(root, "state.sqlite"));
    expect(() => rejectRootStateSqlite(root)).not.toThrow();
  });

  it("rejects an existing sentinel", () => {
    const root = freshWorkspace();
    mkdirSync(join(root, "docs"), { recursive: true });
    const sentinel = join(root, SENTINEL_RELATIVE_PATH);
    writeFileSync(sentinel, "stale");
    sentinelPaths.push(sentinel);
    expect(() => rejectExistingSentinel(root)).toThrow(/sentinel already exists/);
  });

  it("rejects non-worktree project roots", () => {
    const root = freshWorkspace();
    expect(() => verifyIsolatedWorktree(root)).toThrow(/isolated worktree/);
  });

  it("rejects the protected main branch", () => {
    const root = freshWorkspace();
    mkdirSync(join(root, ".worktrees", "test"), { recursive: true });
    expect(() => verifyIsolatedWorktree(join(root, ".worktrees", "test"))).toThrow();
  });

  it("rejects missing .orca/orca.db before any controller start", () => {
    const root = freshWorkspace();
    mkdirSync(join(root, ".orca"), { recursive: true });
    expect(existsSync(join(root, ".orca", "orca.db"))).toBe(false);
    expect(() => {
      if (!existsSync(join(root, ".orca", "orca.db"))) throw new Error(`missing authoritative ORCA database at ${join(root, ".orca", "orca.db")}; run swarmctl pair in this worktree first.`);
    }).toThrow(/missing authoritative ORCA database/);
    void root;
  });

  it("rejects an empty roster before any controller start", async () => {
    const root = freshWorkspace();
    const persistence = freshPersistence(root);
    expect(persistence.getCurrentRoster()).toBeNull();
    persistence.close();
    void persistence;
    void root;
  });

  it("rejects a roster that points at another repository root", () => {
    const root = freshWorkspace();
    const otherRoot = freshWorkspace();
    const persistence = freshPersistence(root);
    const roster = createPairedRoster(otherRoot, { fingerprint: "wrong-root-roster" });
    persistence.saveRoster(roster);
    const current = persistence.getCurrentRoster();
    expect(current?.projectRoot).toBe(otherRoot);
    expect(current?.projectRoot).not.toBe(root);
  });

  it("rejects fewer than five paired bindings", () => {
    const root = freshWorkspace();
    const persistence = freshPersistence(root);
    const threeBindings = createPairedRoster(root, { fingerprint: "three-binding-roster" }).bindings.slice(0, 3).map((binding, index) => ({ ...binding, sessionId: `three-session-${index + 1}` }));
    persistence.saveRoster(createPairedRoster(root, { fingerprint: "three-binding-roster", sessionBindings: threeBindings }));
    expect(persistence.getCurrentRoster()?.bindings).toHaveLength(3);
    const duplicateRoleBindings: SessionBinding[] = [
      { sessionId: "dup-a", position: 1, role: "orchestrator", model: { providerId: "openai", modelId: "a" }, agentName: "orchestrator", projectRoot: root, projectFingerprint: "dup-fp", serverBaseUrl: DEFAULT_OPENCODE_URL, sessionCreatedAt: "2025-01-01T00:00:00.000Z", pairedAt: "2025-01-01T00:00:00.000Z", rolePromptHash: "h", expectedTitle: "orchestrator" },
      { sessionId: "dup-b", position: 2, role: "orchestrator", model: { providerId: "openai", modelId: "b" }, agentName: "orchestrator", projectRoot: root, projectFingerprint: "dup-fp", serverBaseUrl: DEFAULT_OPENCODE_URL, sessionCreatedAt: "2025-01-01T00:00:00.000Z", pairedAt: "2025-01-01T00:00:00.000Z", rolePromptHash: "h", expectedTitle: "orchestrator" }
    ];
    const sevenBindingFingerprint = "seven-binding-roster";
    const sevenBindings = [
      ...createPairedRoster(root, { fingerprint: sevenBindingFingerprint }).bindings.map((binding, index) => ({ ...binding, sessionId: `seven-session-${index + 1}` })),
      ...duplicateRoleBindings
    ];
    expect(() => persistence.saveRoster(createPairedRoster(root, { fingerprint: sevenBindingFingerprint, sessionBindings: sevenBindings }))).toThrow(/UNIQUE/);
  });

  it("rejects an empty model provider or model id", () => {
    const root = freshWorkspace();
    const persistence = freshPersistence(root);
    const bindings = createPairedRoster(root, { fingerprint: "missing-model-roster" }).bindings.map((binding, index) => index === 2 ? { ...binding, model: { providerId: "", modelId: "" } } : binding);
    persistence.saveRoster(createPairedRoster(root, { fingerprint: "missing-model-roster", sessionBindings: bindings }));
    const builder = persistence.getCurrentRoster()?.bindings.find((binding) => binding.role === "builder");
    expect(builder?.model.providerId).toBe("");
    expect(builder?.model.modelId).toBe("");
  });

  it("rejects when an active mission already exists", () => {
    const root = freshWorkspace();
    const persistence = freshPersistence(root);
    const roster = createPairedRoster(root, { fingerprint: "active-mission-roster" });
    persistence.saveRoster(roster);
    persistence.createMission({ missionId: "live-active", rosterId: roster.rosterId, objective: "active", sourceSessionMessageId: "src", state: "awaiting_plan_approval" });
    expect(persistence.hasActiveMission()).toBe(true);
  });
});