import Fastify, { type FastifyInstance } from "fastify";

import type { PairedRoster } from "../domain/types.js";
import type { ControllerRuntimeMetadata } from "./runtime.js";
import { isAuthorizedBearer } from "./auth.js";

export interface ControllerStatusSnapshot {
  opencodeHealthy: boolean;
  bindingsCurrent: boolean;
  eventListening: boolean;
  ready: boolean;
  activeMissionId: string | null;
  missionState: string | null;
  currentTaskRole: string | null;
  currentTaskState: string | null;
  pendingDispatchCount: number;
  eventStream: "connected" | "reconnecting" | "stopped";
  pollingFallbackActive: boolean;
  rosterCurrent: boolean;
  controlPlaneCurrent: boolean;
  lastFailureCode: string | null;
}

export interface ControllerApiOptions {
  token: string;
  metadata: ControllerRuntimeMetadata | (() => ControllerRuntimeMetadata);
  roster: PairedRoster;
  status: () => Promise<ControllerStatusSnapshot>;
  shutdown: () => Promise<void>;
}

export function createControllerApi(options: ControllerApiOptions): FastifyInstance {
  const api = Fastify({ logger: false });
  api.addHook("preHandler", async (request, reply) => {
    if (isAuthorizedBearer(request.headers.authorization, options.token)) return;
    await reply.code(401).send({ error: "unauthorized" });
  });
  api.get("/health", async () => liveness(options));
  api.get("/status", async () => readiness(options));
  api.post("/shutdown", async () => {
    globalThis.queueMicrotask(() => { void options.shutdown(); });
    return { stopping: true };
  });
  return api;
}

async function liveness(options: ControllerApiOptions): Promise<Record<string, unknown>> {
  const status = await options.status();
  const metadata = resolveMetadata(options);
  return {
    healthy: true,
    processIdentity: metadata.processIdentity,
    version: metadata.version,
    port: metadata.port,
    createdAt: metadata.createdAt,
    bindingCount: options.roster.bindings.length,
    opencodeHealthy: status.opencodeHealthy,
    bindingsCurrent: status.bindingsCurrent
  };
}

async function readiness(options: ControllerApiOptions): Promise<Record<string, unknown>> {
  const status = await options.status();
  const metadata = resolveMetadata(options);
  return {
    ready: status.ready,
    live: status.opencodeHealthy && status.bindingsCurrent,
    activeMissionId: status.activeMissionId,
    missionState: status.missionState,
    currentTaskRole: status.currentTaskRole,
    currentTaskState: status.currentTaskState,
    pendingDispatchCount: status.pendingDispatchCount,
    eventStream: status.eventStream,
    pollingFallbackActive: status.pollingFallbackActive,
    rosterCurrent: status.rosterCurrent,
    controlPlaneCurrent: status.controlPlaneCurrent,
    lastFailureCode: status.lastFailureCode,
    processIdentity: metadata.processIdentity,
    version: metadata.version,
    port: metadata.port,
    createdAt: metadata.createdAt
  };
}

function resolveMetadata(options: ControllerApiOptions): ControllerRuntimeMetadata {
  return typeof options.metadata === "function" ? options.metadata() : options.metadata;
}