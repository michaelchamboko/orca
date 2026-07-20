import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CONTROLLER_HOST = "127.0.0.1";
export const CONTROLLER_PORT = 4317;

export interface ControllerRuntimeMetadata {
  schemaVersion: 1;
  pid: number;
  processIdentity: string;
  port: typeof CONTROLLER_PORT;
  version: string;
  createdAt: string;
}

export interface ControllerRuntimeState {
  running: boolean;
  reason: "no validated controller runtime metadata" | "controller runtime verifier is unavailable" | "controller runtime verification failed";
}

export function controllerRuntimePath(projectRoot: string): string {
  return join(projectRoot, ".orca", "controller.json");
}

export function controllerTokenPath(projectRoot: string): string {
  return join(projectRoot, ".orca", "controller-token");
}

export function readControllerRuntime(projectRoot: string): ControllerRuntimeState {
  const metadata = readControllerMetadata(projectRoot);
  if (!metadata) return { running: false, reason: "no validated controller runtime metadata" };
  return { running: false, reason: "controller runtime verifier is unavailable" };
}

export function readControllerMetadata(projectRoot: string): ControllerRuntimeMetadata | null {
  try {
    const value: unknown = JSON.parse(readFileSync(controllerRuntimePath(projectRoot), "utf8"));
    return isRuntimeMetadata(value) ? value : null;
  } catch {
    return null;
  }
}

export async function verifyControllerRuntime(projectRoot: string): Promise<ControllerRuntimeState> {
  const metadata = readControllerMetadata(projectRoot);
  let token: string;
  try {
    token = readFileSync(controllerTokenPath(projectRoot), "utf8").trim();
  } catch {
    return { running: false, reason: "no validated controller runtime metadata" };
  }
  if (!metadata || !token) return { running: false, reason: "no validated controller runtime metadata" };
  try {
    const response = await fetch(`http://${CONTROLLER_HOST}:${metadata.port}/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(500)
    });
    const health = await response.json() as { healthy?: unknown; processIdentity?: unknown; version?: unknown; port?: unknown };
    if (response.ok && health.healthy === true && health.processIdentity === metadata.processIdentity && health.version === metadata.version && health.port === metadata.port) return { running: true, reason: "controller runtime verifier is unavailable" };
  } catch {
    // Metadata is not evidence of a live process; the caller can replace stale state.
  }
  return { running: false, reason: "controller runtime verification failed" };
}

export function writeControllerRuntime(projectRoot: string, metadata: ControllerRuntimeMetadata, token: string): void {
  writeFileSync(controllerTokenPath(projectRoot), `${token}\n`, { mode: 0o600 });
  try { chmodSync(controllerTokenPath(projectRoot), 0o600); } catch { /* Windows may not support POSIX file modes. */ }
  writeFileSync(controllerRuntimePath(projectRoot), JSON.stringify(metadata), { mode: 0o600 });
}

export function removeControllerRuntime(projectRoot: string): void {
  rmSync(controllerRuntimePath(projectRoot), { force: true });
  rmSync(controllerTokenPath(projectRoot), { force: true });
}

export function hasControllerRuntime(projectRoot: string): boolean {
  return existsSync(controllerRuntimePath(projectRoot)) || existsSync(controllerTokenPath(projectRoot));
}

function isRuntimeMetadata(value: unknown): value is ControllerRuntimeMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const metadata = value as Record<string, unknown>;
  return metadata.schemaVersion === 1
    && Number.isInteger(metadata.pid) && (metadata.pid as number) > 0
    && typeof metadata.processIdentity === "string" && metadata.processIdentity.length >= 16
    && metadata.port === CONTROLLER_PORT
    && typeof metadata.version === "string" && metadata.version.length > 0
    && typeof metadata.createdAt === "string" && !Number.isNaN(Date.parse(metadata.createdAt));
}
