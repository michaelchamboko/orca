import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readControllerRuntime } from "../../src/controller/runtime.js";

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

    expect(readControllerRuntime(workspace)).toEqual({ running: false, reason: "controller runtime verifier is unavailable" });
  });
});

function runtimeWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "orca-runtime-"));
  mkdirSync(join(workspace, ".orca"));
  workspaces.push(workspace);
  return workspace;
}
