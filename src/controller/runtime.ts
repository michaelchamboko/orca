import { chmodSync, existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export const CONTROLLER_HOST = "127.0.0.1";
export const CONTROLLER_PORT = 4317;

export interface ControllerRuntimeMetadata {
  schemaVersion: 1;
  pid: number;
  processIdentity: string;
  port: typeof CONTROLLER_PORT | number;
  version: string;
  createdAt: string;
}

export interface ControllerRuntimeState {
  running: boolean;
  reason: "no validated controller runtime metadata" | "controller runtime verifier is unavailable" | "controller runtime verification failed";
}

export interface ControllerStartClaim {
  owner: string;
  path: string;
}

export type TokenPermissionApplier = (path: string) => void;

type ExecuteFile = (file: string, args: readonly string[], options: { windowsHide: boolean; stdio: "ignore" }) => unknown;
type ErrnoLike = Error & { code?: string };

export function controllerRuntimePath(projectRoot: string): string {
  return join(projectRoot, ".orca", "controller.json");
}

export function controllerTokenPath(projectRoot: string): string {
  return join(projectRoot, ".orca", "controller-token");
}

export function controllerStartLockPath(projectRoot: string): string {
  return join(projectRoot, ".orca", "controller-start.lock");
}

export function claimControllerStart(projectRoot: string, owner: string): ControllerStartClaim {
  const path = controllerStartLockPath(projectRoot);
  try {
    writeFileSync(path, JSON.stringify({ owner, pid: process.pid, createdAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
    return { owner, path };
  } catch (error) {
    if (!isExistsError(error) || !tryRemoveDeadClaim(path)) throw new Error("controller start is already in progress");
    writeFileSync(path, JSON.stringify({ owner, pid: process.pid, createdAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
    return { owner, path };
  }
}

export function releaseControllerStart(claim: ControllerStartClaim): void {
  try {
    const current = JSON.parse(readFileSync(claim.path, "utf8")) as { owner?: unknown };
    if (current.owner === claim.owner) unlinkSync(claim.path);
  } catch {
    // The claim is already gone or unreadable; it cannot be safely removed by this owner.
  }
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
      signal: AbortSignal.timeout(2_000)
    });
    const health = await response.json() as { healthy?: unknown; processIdentity?: unknown; version?: unknown; port?: unknown };
    if (response.ok && health.healthy === true && health.processIdentity === metadata.processIdentity && health.version === metadata.version && health.port === metadata.port) return { running: true, reason: "controller runtime verifier is unavailable" };
  } catch {
    // Metadata is not evidence of a live process; the caller can replace stale state.
  }
  return { running: false, reason: "controller runtime verification failed" };
}

export function writeControllerRuntime(projectRoot: string, metadata: ControllerRuntimeMetadata, token: string, applyPermissions: TokenPermissionApplier = restrictTokenPermissions): void {
  writeFileSync(controllerTokenPath(projectRoot), `${token}\n`, { mode: 0o600 });
  try {
    applyPermissions(controllerTokenPath(projectRoot));
  } catch (error) {
    rmSync(controllerTokenPath(projectRoot), { force: true });
    throw error;
  }
  writeFileSync(controllerRuntimePath(projectRoot), JSON.stringify(metadata), { mode: 0o600 });
}

export function removeControllerRuntime(projectRoot: string, expectedProcessIdentity?: string): void {
  if (expectedProcessIdentity) {
    const metadata = readControllerMetadata(projectRoot);
    if (metadata && metadata.processIdentity !== expectedProcessIdentity) return;
  }
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
    && (metadata.port === CONTROLLER_PORT || metadata.port === 0 || (typeof metadata.port === "number" && Number.isInteger(metadata.port) && (metadata.port as number) > 0 && (metadata.port as number) < 65536))
    && typeof metadata.version === "string" && metadata.version.length > 0
    && typeof metadata.createdAt === "string" && !Number.isNaN(Date.parse(metadata.createdAt));
}

export function restrictTokenPermissions(path: string, platform = process.platform, username = process.env.USERNAME, execute: ExecuteFile = executeFile): void {
  if (platform === "win32") {
    if (!username) throw new Error("cannot secure controller token: Windows username is unavailable");
    execute("icacls.exe", [path, "/inheritance:r", "/grant:r", `${username}:(R,W)`], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try { chmodSync(path, 0o600); } catch { /* Some filesystems do not support POSIX permissions. */ }
}

function executeFile(file: string, args: readonly string[], options: { windowsHide: boolean; stdio: "ignore" }): void {
  execFileSync(file, args, options);
}

function isExistsError(error: unknown): error is ErrnoLike {
  return error instanceof Error && (error as ErrnoLike).code === "EEXIST";
}

function tryRemoveDeadClaim(path: string): boolean {
  try {
    const claim = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
    if (!Number.isInteger(claim.pid) || typeof claim.pid !== "number") return false;
    try {
      process.kill(claim.pid, 0);
      return false;
    } catch (error) {
      if (!(error instanceof Error) || (error as ErrnoLike).code !== "ESRCH") return false;
    }
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}
