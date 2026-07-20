import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { controllerTokenPath, readControllerRuntime, restrictTokenPermissions, writeControllerRuntime } from "../../src/controller/runtime.js";

const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

describe("controller runtime metadata", () => {
  it("does not treat an arbitrary legacy PID as a running controller", () => {
    const workspace = runtimeWorkspace();
    writeFileSync(join(workspace, ".orca", "controller.pid"), `${process.pid}\n`);

    expect(readControllerRuntime(workspace)).toEqual({ running: false, reason: "no validated controller runtime metadata" });
  });

  it("does not treat unverified metadata or a reused PID as a running controller", () => {
    const workspace = runtimeWorkspace();
    writeFileSync(join(workspace, ".orca", "controller.json"), JSON.stringify({ schemaVersion: "1", pid: process.pid, processIdentity: "stale-identity", token: "not-logged", port: 9999 }));

    expect(readControllerRuntime(workspace)).toEqual({ running: false, reason: "no validated controller runtime metadata" });
  });

  it("uses fixed icacls arguments for a Windows user-only token ACL", () => {
    const calls: Array<{ file: string; args: readonly string[]; options: unknown }> = [];

    restrictTokenPermissions("C:/orca/controller-token", "win32", "alice", (file, args, options) => { calls.push({ file, args, options }); });

    expect(calls).toEqual([{ file: "icacls.exe", args: ["C:/orca/controller-token", "/inheritance:r", "/grant:r", "alice:(R,W)"], options: { windowsHide: true, stdio: "ignore" } }]);
  });

  it("removes an unprotected token when Windows ACL assignment fails", () => {
    const workspace = runtimeWorkspace();

    expect(() => writeControllerRuntime(workspace, metadata(), "secret-token", () => { throw new Error("icacls failed"); })).toThrow("icacls failed");
    expect(existsSync(controllerTokenPath(workspace))).toBe(false);
  });
});

function metadata() {
  return { schemaVersion: 1 as const, pid: process.pid, processIdentity: "runtime-test-identity", port: 4317 as const, version: "0.1.0", createdAt: "2026-01-01T00:00:00.000Z" };
}

function runtimeWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "orca-runtime-"));
  mkdirSync(join(workspace, ".orca"));
  workspaces.push(workspace);
  return workspace;
}
