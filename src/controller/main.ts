import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";

import type { OpenCodeLiveAdapter } from "../integrations/opencode/adapter.js";
import { RosterService, type RosterPersistence } from "../pairing/roster-service.js";
import { roleProfiles } from "../roles/profiles.js";
import { generateBearerToken } from "./auth.js";
import { createControllerApi } from "./api.js";
import {
  CONTROLLER_HOST,
  CONTROLLER_PORT,
  controllerTokenPath,
  hasControllerRuntime,
  readControllerMetadata,
  removeControllerRuntime,
  verifyControllerRuntime,
  writeControllerRuntime,
  type ControllerRuntimeMetadata
} from "./runtime.js";

export interface StartControllerOptions {
  projectRoot: string;
  adapter: OpenCodeLiveAdapter;
  persistence: RosterPersistence;
  version: string;
  port?: number;
}

export interface RunningController {
  readonly api: FastifyInstance;
  readonly token: string;
  readonly address: { host: typeof CONTROLLER_HOST; port: typeof CONTROLLER_PORT };
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
  if (options.port !== undefined && options.port !== CONTROLLER_PORT) throw new Error(`controller must bind ${CONTROLLER_HOST}:${CONTROLLER_PORT}`);
  await rejectOrCleanRuntime(options.projectRoot);
  await validateStartup(options);

  const roster = await new RosterService(options.adapter, options.persistence).assertCurrent();
  const token = generateBearerToken();
  const metadata: ControllerRuntimeMetadata = {
    schemaVersion: 1,
    pid: process.pid,
    processIdentity: randomUUID(),
    port: CONTROLLER_PORT,
    version: options.version,
    createdAt: new Date().toISOString()
  };
  let stopped = false;
  let api: FastifyInstance;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await api.close();
    removeControllerRuntime(options.projectRoot);
  };
  api = createControllerApi({
    token,
    metadata,
    roster,
    shutdown: stop,
    status: async () => ({
      opencodeHealthy: await options.adapter.health().then((health) => health.healthy).catch(() => false),
      bindingsCurrent: await new RosterService(options.adapter, options.persistence).assertCurrent().then(() => true).catch(() => false)
    })
  });
  try {
    await api.listen({ host: CONTROLLER_HOST, port: CONTROLLER_PORT });
    writeControllerRuntime(options.projectRoot, metadata, token);
  } catch (error) {
    await api.close();
    removeControllerRuntime(options.projectRoot);
    throw error;
  }
  return { api, token, address: { host: CONTROLLER_HOST, port: CONTROLLER_PORT }, stop };
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
    if (!existsSync(`${options.projectRoot}/.opencode/agents/orca-${profile.role}.md`)) throw new Error(`missing ORCA role profile: ${profile.role}`);
  }
}
