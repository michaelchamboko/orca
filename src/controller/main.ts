import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";

import type { OpenCodeLiveAdapter } from "../integrations/opencode/adapter.js";
import { RosterService } from "../pairing/roster-service.js";
import { roleProfiles } from "../roles/profiles.js";
import { generateBearerToken } from "./auth.js";
import { createControllerApi } from "./api.js";
import { EventRuntime } from "./event-runtime.js";
import { WorkerCompletionService } from "./worker-completion.js";
import { MissionIngress } from "./mission-ingress.js";
import { DispatchOutbox } from "./dispatch-outbox.js";
import type { WorkflowPersistence } from "./workflow-persistence.js";
import {
  CONTROLLER_HOST,
  CONTROLLER_PORT,
  claimControllerStart,
  controllerTokenPath,
  hasControllerRuntime,
  readControllerMetadata,
  removeControllerRuntime,
  releaseControllerStart,
  verifyControllerRuntime,
  writeControllerRuntime,
  type ControllerRuntimeMetadata
} from "./runtime.js";

export interface StartControllerOptions {
  projectRoot: string;
  adapter: OpenCodeLiveAdapter;
  persistence: WorkflowPersistence;
  version: string;
  port?: number;
}

export interface RunningController {
  readonly api: FastifyInstance;
  readonly token: string;
  readonly address: { host: typeof CONTROLLER_HOST; port: number };
  stop(): Promise<void>;
}

export async function stopController(projectRoot: string): Promise<boolean> {
  const metadata = readControllerMetadata(projectRoot);
  const state = await verifyControllerRuntime(projectRoot);
  if (!metadata || !state.running) {
    removeControllerRuntime(projectRoot);
    return false;
  }
  const token = await import("node:fs/promises").then(({ readFile }) => readFile(controllerTokenPath(projectRoot), "utf8")).then((value) => value.trim());
  const response = await fetch(`http://${CONTROLLER_HOST}:${metadata.port}/shutdown`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(1_000)
  });
  if (!response.ok) throw new Error("controller shutdown request failed");
  return true;
}

export interface ControllerStatus {
  running: boolean;
  reason: string;
  opencodeHealthy?: boolean;
  bindingsCurrent?: boolean;
  bindingCount?: number;
}

export async function controllerStatus(projectRoot: string): Promise<ControllerStatus> {
  const state = await verifyControllerRuntime(projectRoot);
  if (!state.running) return state;
  const metadata = readControllerMetadata(projectRoot);
  if (!metadata) return { running: false, reason: "controller runtime verification failed" };
  try {
    const token = await import("node:fs/promises").then(({ readFile }) => readFile(controllerTokenPath(projectRoot), "utf8")).then((value) => value.trim());
    const response = await fetch(`http://${CONTROLLER_HOST}:${metadata.port}/status`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1_000) });
    const body = await response.json() as { opencodeHealthy?: unknown; bindingsCurrent?: unknown; bindingCount?: unknown };
    return {
      ...state,
      opencodeHealthy: body.opencodeHealthy === true,
      bindingsCurrent: body.bindingsCurrent === true,
      bindingCount: typeof body.bindingCount === "number" ? body.bindingCount : undefined
    };
  } catch {
    return { running: false, reason: "controller runtime verification failed" };
  }
}

export async function startController(options: StartControllerOptions): Promise<RunningController> {
  const requestedPort = options.port ?? CONTROLLER_PORT;
  if (requestedPort !== CONTROLLER_PORT && requestedPort !== 0) throw new Error(`controller must bind ${CONTROLLER_HOST}:${CONTROLLER_PORT}`);
  const claim = claimControllerStart(options.projectRoot, randomUUID());
  let api: FastifyInstance | undefined;
  let metadata: ControllerRuntimeMetadata | undefined;
  let boundPort: number = requestedPort;
  try {
    await rejectOrCleanRuntime(options.projectRoot);
    await validateStartup(options);

    const roster = await new RosterService(options.adapter, options.persistence).assertCurrent();
    const rosterService = new RosterService(options.adapter, options.persistence);
    const dispatch = new DispatchOutbox(options.adapter, options.persistence, rosterService);
    const completion = new WorkerCompletionService(options.adapter, options.persistence, dispatch, {
      assertWorkerBinding: async (task) => {
        const current = await rosterService.assertCurrent();
        const binding = current.bindings.find((candidate) => candidate.role === task.role);
        if (!binding || binding.sessionId !== task.targetSessionId) throw new Error("roster drift");
        return { agent: `orca-${binding.role}`, model: { ...binding.model }, sessionId: binding.sessionId };
      }
    });
    const events = new EventRuntime(options.adapter, new MissionIngress(options.projectRoot, options.adapter, options.persistence, rosterService, dispatch), dispatch, completion);
    const token = generateBearerToken();
    metadata = {
    schemaVersion: 1,
    pid: process.pid,
    processIdentity: randomUUID(),
    port: requestedPort === 0 ? 0 : CONTROLLER_PORT,
    version: options.version,
    createdAt: new Date().toISOString()
    };
    let stopped = false;
    const stop = async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      await events.stop();
      await api?.close();
      removeControllerRuntime(options.projectRoot, metadata?.processIdentity);
    };
    api = createControllerApi({
    token,
    metadata: () => {
      if (!metadata) throw new Error("controller metadata not initialized");
      return metadata;
    },
    roster,
    shutdown: stop,
    status: async () => ({
      opencodeHealthy: await options.adapter.health().then((health) => health.healthy).catch(() => false),
      bindingsCurrent: await new RosterService(options.adapter, options.persistence).assertCurrent().then(() => true).catch(() => false),
      eventListening: events.eventListening
    })
  });
    const listenOptions = requestedPort === 0 ? { host: CONTROLLER_HOST, port: 0 } : { host: CONTROLLER_HOST, port: CONTROLLER_PORT };
    const address = await api.listen(listenOptions);
    if (address) {
      boundPort = typeof address === "string" ? Number(new URL(address).port) : Number((address as { port: number }).port);
    }
    metadata = { ...metadata, port: boundPort === 0 ? 0 : (boundPort === CONTROLLER_PORT ? CONTROLLER_PORT : boundPort) };
    await events.start();
    writeControllerRuntime(options.projectRoot, metadata, token);
    return { api, token, address: { host: CONTROLLER_HOST, port: boundPort }, stop };
  } catch (error) {
    await api?.close();
    if (metadata) removeControllerRuntime(options.projectRoot, metadata.processIdentity);
    throw error;
  } finally {
    releaseControllerStart(claim);
  }
}

async function rejectOrCleanRuntime(projectRoot: string): Promise<void> {
  if (!hasControllerRuntime(projectRoot)) return;
  const state = await verifyControllerRuntime(projectRoot);
  if (state.running) throw new Error("controller is already running");
  removeControllerRuntime(projectRoot);
}

async function validateStartup(options: StartControllerOptions): Promise<void> {
  const health = await options.adapter.health();
  if (!health.healthy) throw new Error("OpenCode health check failed");
  const roster = await new RosterService(options.adapter, options.persistence).assertCurrent();
  if (roster.projectRoot !== options.projectRoot || roster.bindings.length !== roleProfiles.length) throw new Error("roster drift");
  for (const profile of roleProfiles) {
    const binding = roster.bindings.find((candidate) => candidate.position === profile.position && candidate.role === profile.role);
    if (!binding?.model.providerId || !binding.model.modelId) throw new Error("roster drift");
    const profilePath = `${options.projectRoot}/.opencode/agents/orca-${profile.role}.md`;
    if (!existsSync(profilePath)) throw new Error(`missing ORCA role profile: ${profile.role}`);
    const profileHash = createHash("sha256").update(JSON.stringify({ mode: profile.mode, tools: profile.tools, instructions: profile.instructions })).digest("hex");
    if (readFileSync(profilePath, "utf8") !== renderProfile(profile) || binding.rolePromptHash !== profileHash) throw new Error(`ORCA role profile mismatch: ${profile.role}`);
  }
}

function renderProfile(profile: (typeof roleProfiles)[number]): string {
  return `---\ndescription: ORCA ${profile.role} role\nmode: ${profile.mode}\ntools:\n${profile.tools.map((tool) => `  ${tool}: true`).join("\n")}\n---\n\n${profile.instructions}\n`;
}
