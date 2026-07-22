import Fastify, { type FastifyInstance } from "fastify";

import type { PairedRoster } from "../domain/types.js";
import type { ControllerRuntimeMetadata } from "./runtime.js";
import { isAuthorizedBearer } from "./auth.js";

export interface ControllerApiOptions {
  token: string;
  metadata: () => ControllerRuntimeMetadata;
  roster: PairedRoster;
  status: () => Promise<{ opencodeHealthy: boolean; bindingsCurrent: boolean; eventListening: boolean }>;
  shutdown: () => Promise<void>;
}

export function createControllerApi(options: ControllerApiOptions): FastifyInstance {
  const api = Fastify({ logger: false });
  api.addHook("preHandler", async (request, reply) => {
    if (isAuthorizedBearer(request.headers.authorization, options.token)) return;
    await reply.code(401).send({ error: "unauthorized" });
  });
  api.get("/health", async () => health(options));
  api.get("/status", async () => health(options));
  api.post("/shutdown", async () => {
    globalThis.queueMicrotask(() => { void options.shutdown(); });
    return { stopping: true };
  });
  return api;
}

async function health(options: ControllerApiOptions): Promise<Record<string, unknown>> {
  const status = await options.status();
  const metadata = options.metadata();
  return {
    healthy: true,
    ...status,
    processIdentity: metadata.processIdentity,
    version: metadata.version,
    port: metadata.port,
    createdAt: metadata.createdAt,
    bindingCount: options.roster.bindings.length,
    eventListening: status.eventListening
  };
}
