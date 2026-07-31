import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { ZodError, type ZodSchema } from "zod";

import { controllerTokenPath, readControllerMetadata } from "../controller/runtime.js";
import { controllerStatus, startController, type RunningController } from "../controller/main.js";
import type { ControllerStatusSnapshot } from "../controller/api.js";
import type { PairedRoster, Role } from "../domain/types.js";
import type { OpenCodeLiveAdapter } from "../integrations/opencode/adapter.js";
import type { OpenCodeSession } from "../integrations/opencode/types.js";
import { openProjectPersistence } from "../persistence/project.js";
import type { SqlitePersistence } from "../persistence/sqlite.js";
import { RosterService } from "../pairing/roster-service.js";
import { installOrcaAssets } from "../roles/installer.js";
import { roleProfiles } from "../roles/profiles.js";
import { inspectOrcaAssets } from "./assets.js";
import {
  bootstrapBodySchema,
  emptyBodySchema,
  LauncherError,
  type LauncherErrorCode,
  type LauncherLifecycle,
  orderedAssignmentSessionIds,
  pairBodySchema,
  type LauncherAssignments
} from "./contracts.js";
import { renderLauncherHtml } from "./html.js";
import { canonicalPath } from "./project.js";
import { readActiveMissionReadonly, readCurrentRosterReadonly } from "./read-only-roster.js";

const UI_HOST = "127.0.0.1";
const BOOTSTRAP_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 8 * 60 * 60_000;

export interface StartLauncherUiOptions {
  projectRoot: string;
  opencodeOrigin: string;
  adapter: OpenCodeLiveAdapter;
  version: string;
  port?: number;
}

export interface RunningLauncherUi {
  app: FastifyInstance;
  url: string;
  origin: string;
  stop(): Promise<void>;
}

interface BrowserSession {
  csrfToken: string;
  expiresAt: number;
}

interface OwnedController {
  controller: RunningController;
  persistence: SqlitePersistence;
}

interface SessionSnapshot {
  id: string;
  serverBaseUrl: string;
  projectRoot: string;
  canonicalProjectRoot: string | null;
  model: { providerId: string; modelId: string };
  status: string;
  inFlightToolCalls: number;
}

interface UiSession {
  id: string;
  shortId: string;
  title: string;
  model: { providerId: string; modelId: string };
  activity: string;
  projectRoot: string;
  directoryVerified: boolean;
  eligible: boolean;
  blockerCodes: LauncherErrorCode[];
}

interface UiState {
  project: { root: string };
  opencode: { origin: string; healthy: boolean; version: string | null };
  roles: Array<{ position: number; role: Role; label: string; selectedSessionId: string | null }>;
  sessions: UiSession[];
  assets: { active: boolean; restartRequired: boolean };
  roster: { present: boolean; drift: "none" | "detected" | "unknown"; pairedAt: string | null };
  controller: {
    ownership: "none" | "owned" | "external";
    lifecycle: LauncherLifecycle;
    address: string | null;
    ready: boolean;
    ingressHealth: "connected" | "polling" | "stopped" | "unknown";
    lastFailureCode: string | null;
  };
  activeMission: { active: boolean; missionId: string | null; state: string | null };
  permittedActions: { installAssets: boolean; pairRoster: boolean; startController: boolean; stopController: boolean };
  blockers: LauncherErrorCode[];
}

export async function startLauncherUi(options: StartLauncherUiOptions): Promise<RunningLauncherUi> {
  const service = new LauncherService(options);
  await service.app.listen({ host: UI_HOST, port: options.port ?? 0 });
  const address = service.app.server.address() as AddressInfo;
  const origin = `http://${UI_HOST}:${address.port}`;
  service.setOrigin(origin);
  return {
    app: service.app,
    origin,
    url: `${origin}/#nonce=${service.bootstrapNonce}`,
    stop: () => service.stop()
  };
}

class LauncherService {
  public readonly app: FastifyInstance;
  public readonly bootstrapNonce = token();

  private readonly browserSessions = new Map<string, BrowserSession>();
  private readonly bootstrapExpiresAt = Date.now() + BOOTSTRAP_TTL_MS;
  private readonly latestSnapshot = new Map<string, SessionSnapshot>();
  private expectedOrigin: string | null = null;
  private bootstrapUsed = false;
  private assetRestartRequired = false;
  private operationInProgress = false;
  private ownedController: OwnedController | null = null;
  private lifecycle: LauncherLifecycle = "stopped";
  private lastFailureCode: string | null = null;

  constructor(private readonly options: StartLauncherUiOptions) {
    this.app = Fastify({ logger: false, bodyLimit: 16 * 1024 });
    this.configureSecurity();
    this.configureRoutes();
  }

  public setOrigin(origin: string): void {
    this.expectedOrigin = origin;
  }

  public async stop(): Promise<void> {
    await this.stopOwnedController();
    await this.app.close();
  }

  private configureSecurity(): void {
    this.app.addHook("onRequest", async (request, reply) => {
      this.setSecurityHeaders(reply);
      if (!this.expectedOrigin) return;
      const expectedHost = new URL(this.expectedOrigin).host;
      if (request.headers.host !== expectedHost) {
        await reply.code(403).send({ error: "UNAUTHORIZED" });
        return;
      }
      if (request.method === "POST") {
        const origin = request.headers.origin;
        if (origin !== this.expectedOrigin) {
          await reply.code(403).send({ error: "UNAUTHORIZED" });
          return;
        }
        const contentType = String(request.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
        if (contentType !== "application/json") {
          await reply.code(415).send({ error: "INVALID_REQUEST" });
          return;
        }
      }
    });
    this.app.setErrorHandler(async (error, _request, reply) => {
      if (error instanceof LauncherError) {
        await reply.code(error.statusCode).send({ error: error.code, message: error.message });
        return;
      }
      if (error instanceof ZodError) {
        await reply.code(400).send({ error: "INVALID_REQUEST", message: "Request body does not match the launcher contract." });
        return;
      }
      await reply.code(500).send({ error: "RECOVERY_REQUIRED", message: "Launcher operation failed." });
    });
  }

  private configureRoutes(): void {
    this.app.get("/", async (_request, reply) => {
      const nonce = token();
      reply.header("content-type", "text/html; charset=utf-8");
      reply.header("content-security-policy", htmlCsp(nonce));
      return renderLauncherHtml(nonce);
    });
    this.app.post("/api/bootstrap", async (request, reply) => {
      const body = parseBody(bootstrapBodySchema, request.body);
      if (this.bootstrapUsed || Date.now() > this.bootstrapExpiresAt || body.nonce !== this.bootstrapNonce) {
        throw new LauncherError("UNAUTHORIZED", "Invalid launcher bootstrap.", 401);
      }
      this.bootstrapUsed = true;
      const sessionId = token();
      const csrfToken = token();
      this.browserSessions.set(sessionId, { csrfToken, expiresAt: Date.now() + SESSION_TTL_MS });
      reply.header("set-cookie", `orca_ui_session=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
      return { csrfToken };
    });
    this.app.get("/api/state", async (request) => {
      this.requireSession(request, false);
      return this.readState();
    });
    this.app.post("/api/assets/install", async (request) => {
      this.requireSession(request, true);
      parseBody(emptyBodySchema, request.body);
      return this.runSerialized(async () => {
        const result = installOrcaAssets(this.options.projectRoot);
        this.assetRestartRequired = [...result.profiles, ...result.skills].some((asset) => asset.change !== "unchanged");
        return this.readState();
      });
    });
    this.app.post("/api/roster/pair", async (request) => {
      this.requireSession(request, true);
      const body = parseBody(pairBodySchema, request.body);
      return this.runSerialized(async () => {
        await this.pairRoster(body.assignments);
        return this.readState();
      });
    });
    this.app.post("/api/controller/start", async (request) => {
      this.requireSession(request, true);
      parseBody(emptyBodySchema, request.body);
      return this.runSerialized(async () => {
        await this.startOwnedController();
        return this.readState();
      });
    });
    this.app.post("/api/controller/stop", async (request) => {
      this.requireSession(request, true);
      parseBody(emptyBodySchema, request.body);
      return this.runSerialized(async () => {
        if (!this.ownedController) throw new LauncherError("CONTROLLER_ALREADY_RUNNING", "Only a UI-owned controller can be stopped from this dashboard.", 409);
        await this.stopOwnedController();
        return this.readState();
      });
    });
  }

  private async readState(): Promise<UiState> {
    const blockers: LauncherErrorCode[] = [];
    const assets = inspectOrcaAssets(this.options.projectRoot);
    const activeMission = readActiveMissionReadonly(this.options.projectRoot);
    const roster = readCurrentRosterReadonly(this.options.projectRoot);
    const opencode = await this.readOpenCodeState(blockers);
    const sessions = opencode.sessions.map((session) => toUiSession(session, this.options.projectRoot));
    const rosterDrift = roster ? evaluateRosterDrift(roster, opencode.sessions, this.options.projectRoot) : "none";
    const controller = await this.readControllerState();

    if (!opencode.healthy) blockers.push("OPENCODE_UNAVAILABLE");
    if (this.assetRestartRequired) blockers.push("PROFILE_RELOAD_REQUIRED");
    if (roster && rosterDrift === "detected") blockers.push("SESSION_CHANGED");
    if (activeMission) blockers.push("ROSTER_LOCKED");
    if (controller.ownership === "external") blockers.push("CONTROLLER_ALREADY_RUNNING");
    if (this.lifecycle === "recovery-required") blockers.push("RECOVERY_REQUIRED");

    const selected = new Set(roster?.bindings.map((binding) => binding.sessionId) ?? []);
    const selectedIdle = roster ? opencode.sessions.filter((session) => selected.has(session.id)).every(isIdleSession) : false;
    const canPair = assets.active && !this.assetRestartRequired && sessions.filter((session) => session.eligible).length >= roleProfiles.length && !activeMission && !this.operationInProgress;
    const canStart = Boolean(
      roster
      && assets.active
      && !this.assetRestartRequired
      && rosterDrift === "none"
      && opencode.healthy
      && !activeMission
      && selectedIdle
      && controller.ownership === "none"
      && !this.operationInProgress
    );

    return {
      project: { root: this.options.projectRoot },
      opencode: { origin: this.options.opencodeOrigin, healthy: opencode.healthy, version: opencode.version },
      roles: roleProfiles.map((profile) => ({
        position: profile.position,
        role: profile.role,
        label: roleLabel(profile.role),
        selectedSessionId: roster?.bindings.find((binding) => binding.role === profile.role)?.sessionId ?? null
      })),
      sessions,
      assets: { active: assets.active, restartRequired: this.assetRestartRequired },
      roster: { present: Boolean(roster), drift: roster ? rosterDrift : "none", pairedAt: roster?.pairedAt ?? null },
      controller,
      activeMission: { active: Boolean(activeMission), missionId: activeMission?.missionId ?? null, state: activeMission?.state ?? null },
      permittedActions: {
        installAssets: !this.operationInProgress && controller.ownership === "none",
        pairRoster: canPair,
        startController: canStart,
        stopController: Boolean(this.ownedController) && !this.operationInProgress
      },
      blockers: unique(blockers)
    };
  }

  private async readOpenCodeState(blockers: LauncherErrorCode[]): Promise<{ healthy: boolean; version: string | null; sessions: OpenCodeSession[] }> {
    let healthy = false;
    let version: string | null = null;
    try {
      const health = await this.options.adapter.health();
      healthy = health.healthy;
      version = health.version ?? null;
    } catch {
      blockers.push("OPENCODE_UNAVAILABLE");
    }
    let sessions: OpenCodeSession[] = [];
    if (healthy) {
      try {
        sessions = await this.options.adapter.listSessions(this.options.projectRoot);
        this.latestSnapshot.clear();
        for (const session of sessions) this.latestSnapshot.set(session.id, toSnapshot(session));
      } catch {
        healthy = false;
        blockers.push("OPENCODE_UNAVAILABLE");
      }
    }
    return { healthy, version, sessions };
  }

  private async pairRoster(assignments: LauncherAssignments): Promise<void> {
    if (this.assetRestartRequired || !inspectOrcaAssets(this.options.projectRoot).active) {
      throw new LauncherError("PROFILE_RELOAD_REQUIRED", "Install ORCA assets and restart OpenCode before pairing.", 409);
    }
    if (this.latestSnapshot.size === 0) await this.readState();
    const selectedIds = orderedAssignmentSessionIds(assignments);
    if (new Set(selectedIds).size !== roleProfiles.length) {
      throw new LauncherError("INVALID_REQUEST", "Each fixed role must use a unique session.", 400);
    }
    const snapshot = selectedIds.map((id) => this.latestSnapshot.get(id));
    if (snapshot.some((session) => !session)) {
      throw new LauncherError("SESSION_CHANGED", "Selected sessions are no longer in the discovery snapshot.", 409);
    }
    const liveSessions = await this.options.adapter.listSessions(this.options.projectRoot);
    const liveById = new Map(liveSessions.map((session) => [session.id, session]));
    const selected = selectedIds.map((id, index) => verifiedLiveSelection(id, snapshot[index] as SessionSnapshot, liveById.get(id), this.options.projectRoot));
    if (selected.some((session) => !isIdleSession(session))) {
      throw new LauncherError("SESSION_NOT_IDLE", "All selected sessions must be idle before pairing.", 409);
    }
    const persistence = openProjectPersistence(this.options.projectRoot);
    try {
      await new RosterService(this.options.adapter, persistence).pairSelected(selected);
    } catch (error) {
      if (error instanceof Error && /active mission/i.test(error.message)) {
        throw new LauncherError("ROSTER_LOCKED", "Cannot re-pair while a mission is active.", 409);
      }
      throw error;
    } finally {
      persistence.close();
    }
  }

  private async startOwnedController(): Promise<void> {
    if (this.ownedController) throw new LauncherError("CONTROLLER_ALREADY_RUNNING", "A UI-owned controller is already running.", 409);
    const external = await controllerStatus(this.options.projectRoot).catch(() => ({ running: false }));
    if (external.running) throw new LauncherError("CONTROLLER_ALREADY_RUNNING", "A controller is already running for this project.", 409);

    this.lifecycle = "starting";
    this.lastFailureCode = null;
    let persistence: SqlitePersistence | null = openProjectPersistence(this.options.projectRoot);
    try {
      const assets = inspectOrcaAssets(this.options.projectRoot);
      if (!assets.active || this.assetRestartRequired) throw new LauncherError("PROFILE_RELOAD_REQUIRED", "ORCA assets are not active in OpenCode.", 409);
      if (persistence.hasActiveMission()) throw new LauncherError("ROSTER_LOCKED", "A mission is already active.", 409);
      const roster = await new RosterService(this.options.adapter, persistence).assertCurrent();
      await this.assertRosterIdle(roster);
      const controller = await startController({
        projectRoot: this.options.projectRoot,
        adapter: this.options.adapter,
        persistence,
        version: this.options.version,
        port: 0
      });
      this.ownedController = { controller, persistence };
      persistence = null;
      const status = await fetchControllerStatus(controller.address.port, controller.token);
      if (!status.rosterCurrent || !status.controlPlaneCurrent || (status.eventStream !== "connected" && !status.pollingFallbackActive)) {
        throw new LauncherError("START_FAILED", "Controller started but did not reach the required ingress readiness.", 500);
      }
      this.lifecycle = status.ready ? "ready" : "running-not-ready";
    } catch (error) {
      this.lastFailureCode = error instanceof LauncherError ? error.code : "START_FAILED";
      this.lifecycle = this.lastFailureCode === "RECOVERY_REQUIRED" ? "recovery-required" : "blocked";
      if (this.ownedController) await this.stopOwnedController();
      this.lifecycle = this.lastFailureCode === "RECOVERY_REQUIRED" ? "recovery-required" : "blocked";
      persistence?.close();
      if (error instanceof LauncherError) throw error;
      throw new LauncherError("START_FAILED", "Controller start failed.", 500);
    }
  }

  private async assertRosterIdle(roster: PairedRoster): Promise<void> {
    const live = await this.options.adapter.listSessions(this.options.projectRoot);
    const byId = new Map(live.map((session) => [session.id, session]));
    for (const binding of roster.bindings) {
      const session = byId.get(binding.sessionId);
      if (!session || !isSameSessionIdentity(binding, session, this.options.projectRoot)) {
        throw new LauncherError("SESSION_CHANGED", "The paired roster changed before start.", 409);
      }
      if (!isIdleSession(session)) throw new LauncherError("SESSION_NOT_IDLE", "All paired sessions must be idle before start.", 409);
    }
  }

  private async stopOwnedController(): Promise<void> {
    if (!this.ownedController) {
      this.lifecycle = "stopped";
      return;
    }
    this.lifecycle = "stopping";
    const owned = this.ownedController;
    this.ownedController = null;
    try {
      await owned.controller.stop();
    } finally {
      owned.persistence.close();
      this.lifecycle = "stopped";
    }
  }

  private async readControllerState(): Promise<UiState["controller"]> {
    if (this.ownedController) {
      const status = await fetchControllerStatus(this.ownedController.controller.address.port, this.ownedController.controller.token).catch(() => null);
      if (!status) {
        this.lifecycle = "reconnecting";
        return controllerState("owned", "reconnecting", this.ownedController.controller.address.port, null, this.lastFailureCode);
      }
      this.lifecycle = status.ready ? "ready" : status.eventStream === "reconnecting" ? "reconnecting" : "running-not-ready";
      return controllerState("owned", this.lifecycle, this.ownedController.controller.address.port, status, this.lastFailureCode);
    }
    const metadata = readControllerMetadata(this.options.projectRoot);
    if (!metadata) return controllerState("none", this.lifecycle === "blocked" ? "blocked" : "stopped", null, null, this.lastFailureCode);
    const tokenValue = await readFile(controllerTokenPath(this.options.projectRoot), "utf8").then((value) => value.trim()).catch(() => null);
    if (!tokenValue) return controllerState("external", "recovery-required", metadata.port, null, "RECOVERY_REQUIRED");
    const status = await fetchControllerStatus(metadata.port, tokenValue).catch(() => null);
    if (!status) return controllerState("external", "recovery-required", metadata.port, null, "RECOVERY_REQUIRED");
    return controllerState("external", status.ready ? "ready" : "running-not-ready", metadata.port, status, null);
  }

  private requireSession(request: FastifyRequest, requireCsrf: boolean): void {
    const sessionId = parseCookie(String(request.headers.cookie ?? "")).orca_ui_session;
    const session = sessionId ? this.browserSessions.get(sessionId) : undefined;
    if (!session || session.expiresAt < Date.now()) throw new LauncherError("UNAUTHORIZED", "Launcher session is not authorized.", 401);
    if (requireCsrf && request.headers["x-orca-csrf"] !== session.csrfToken) {
      throw new LauncherError("UNAUTHORIZED", "Launcher CSRF token is invalid.", 401);
    }
  }

  private async runSerialized<T>(operation: () => Promise<T>): Promise<T> {
    if (this.operationInProgress) throw new LauncherError("OPERATION_IN_PROGRESS", "Another launcher operation is already running.", 409);
    this.operationInProgress = true;
    try {
      return await operation();
    } finally {
      this.operationInProgress = false;
    }
  }

  private setSecurityHeaders(reply: FastifyReply): void {
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("cache-control", "no-store");
    if (!reply.getHeader("content-security-policy")) {
      reply.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
    }
  }
}

function parseBody<T>(schema: ZodSchema<T>, body: unknown): T {
  return schema.parse(body ?? {});
}

function htmlCsp(nonce: string): string {
  return `default-src 'self'; connect-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'`;
}

function toSnapshot(session: OpenCodeSession): SessionSnapshot {
  return {
    id: session.id,
    serverBaseUrl: session.serverBaseUrl,
    projectRoot: session.projectRoot,
    canonicalProjectRoot: canonicalSessionRoot(session.projectRoot),
    model: { providerId: session.model.providerId, modelId: session.model.modelId },
    status: session.status,
    inFlightToolCalls: session.inFlightToolCalls
  };
}

function toUiSession(session: OpenCodeSession, projectRoot: string): UiSession {
  const blockers = sessionBlockers(session, projectRoot);
  return {
    id: session.id,
    shortId: session.id.slice(0, 8),
    title: session.title || "Untitled",
    model: { providerId: session.model.providerId || "unknown", modelId: session.model.modelId || "unknown" },
    activity: isIdleSession(session) ? "idle" : session.status || "busy",
    projectRoot: session.projectRoot,
    directoryVerified: canonicalSessionRoot(session.projectRoot) === projectRoot,
    eligible: blockers.length === 0,
    blockerCodes: blockers
  };
}

function sessionBlockers(session: OpenCodeSession, projectRoot: string): LauncherErrorCode[] {
  const blockers: LauncherErrorCode[] = [];
  if (canonicalSessionRoot(session.projectRoot) !== projectRoot) blockers.push("SESSION_CHANGED");
  if (!isActiveSession(session)) blockers.push("SESSION_CHANGED");
  if (!isKnownModel(session)) blockers.push("SESSION_CHANGED");
  if (!isIdleSession(session)) blockers.push("SESSION_NOT_IDLE");
  return blockers;
}

function verifiedLiveSelection(id: string, snapshot: SessionSnapshot, live: OpenCodeSession | undefined, projectRoot: string): OpenCodeSession {
  if (!live) throw new LauncherError("SESSION_CHANGED", "Selected session is no longer open.", 409);
  const liveSnapshot = toSnapshot(live);
  if (
    liveSnapshot.id !== id
    || liveSnapshot.serverBaseUrl !== snapshot.serverBaseUrl
    || liveSnapshot.canonicalProjectRoot !== snapshot.canonicalProjectRoot
    || liveSnapshot.model.providerId !== snapshot.model.providerId
    || liveSnapshot.model.modelId !== snapshot.model.modelId
    || liveSnapshot.status !== snapshot.status
    || liveSnapshot.inFlightToolCalls !== snapshot.inFlightToolCalls
  ) {
    throw new LauncherError("SESSION_CHANGED", "Selected session changed after discovery.", 409);
  }
  if (canonicalSessionRoot(live.projectRoot) !== projectRoot || !isActiveSession(live) || !isKnownModel(live)) {
    throw new LauncherError("SESSION_CHANGED", "Selected session is not eligible for this project.", 409);
  }
  return { ...live, projectRoot, model: { ...live.model } };
}

function evaluateRosterDrift(roster: PairedRoster, sessions: readonly OpenCodeSession[], projectRoot: string): "none" | "detected" | "unknown" {
  if (sessions.length === 0) return "unknown";
  const byId = new Map(sessions.map((session) => [session.id, session]));
  for (const binding of roster.bindings) {
    const session = byId.get(binding.sessionId);
    if (!session || !isSameSessionIdentity(binding, session, projectRoot) || !isActiveSession(session)) return "detected";
  }
  return "none";
}

function isSameSessionIdentity(binding: PairedRoster["bindings"][number], session: OpenCodeSession, projectRoot: string): boolean {
  return binding.serverBaseUrl === session.serverBaseUrl
    && binding.projectRoot === projectRoot
    && canonicalSessionRoot(session.projectRoot) === projectRoot
    && binding.model.providerId === session.model.providerId
    && binding.model.modelId === session.model.modelId;
}

async function fetchControllerStatus(port: number, tokenValue: string): Promise<ControllerStatusSnapshot> {
  const response = await fetch(`http://${UI_HOST}:${port}/status`, {
    headers: { authorization: `Bearer ${tokenValue}` },
    signal: AbortSignal.timeout(1_000)
  });
  if (!response.ok) throw new Error("controller status failed");
  return response.json() as Promise<ControllerStatusSnapshot>;
}

function controllerState(ownership: "none" | "owned" | "external", lifecycle: LauncherLifecycle, port: number | null, status: ControllerStatusSnapshot | null, failure: string | null): UiState["controller"] {
  const ingressHealth = status?.eventStream === "connected" ? "connected" : status?.pollingFallbackActive ? "polling" : status ? "stopped" : "unknown";
  return {
    ownership,
    lifecycle,
    address: port ? `http://${UI_HOST}:${port}` : null,
    ready: status?.ready === true,
    ingressHealth,
    lastFailureCode: failure
  };
}

function isActiveSession(session: OpenCodeSession): boolean {
  return session.status !== "closed" && session.status !== "inactive";
}

function isIdleSession(session: OpenCodeSession): boolean {
  return isActiveSession(session) && (session.status === "idle" || !session.status) && session.inFlightToolCalls === 0;
}

function isKnownModel(session: OpenCodeSession): boolean {
  return Boolean(session.model.providerId && session.model.modelId && session.model.providerId !== "unknown" && session.model.modelId !== "unknown");
}

function canonicalSessionRoot(path: string): string | null {
  if (!path) return null;
  try {
    return canonicalPath(path);
  } catch {
    return null;
  }
}

function roleLabel(role: Role): string {
  return role.slice(0, 1).toUpperCase() + role.slice(1);
}

function parseCookie(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (!name || rest.length === 0) continue;
    cookies[name] = rest.join("=");
  }
  return cookies;
}

function token(): string {
  return randomBytes(32).toString("base64url");
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
