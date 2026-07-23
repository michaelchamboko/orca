import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createControllerApi, type ControllerStatusSnapshot } from "../../src/controller/api.js";
import type { PairedRoster } from "../../src/domain/types.js";

const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

function makeWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "orca-api-"));
  workspaces.push(workspace);
  mkdirSync(join(workspace, ".orca"));
  return workspace;
}

const roster: PairedRoster = {
  rosterId: "roster-1",
  fingerprint: "fp",
  serverBaseUrl: "http://127.0.0.1:4096",
  projectRoot: "/workspace",
  pairedAt: "2025-01-01T00:00:00.000Z",
  bindings: []
};

function makeMetadata(workspace: string) {
  return {
    schemaVersion: 1 as const,
    pid: 42,
    processIdentity: "pid-1",
    port: 4317,
    version: "0.1.0",
    createdAt: "2025-01-01T00:00:00.000Z"
  };
}

const healthyStatus: ControllerStatusSnapshot = {
  opencodeHealthy: true,
  bindingsCurrent: true,
  eventListening: true,
  ready: true,
  activeMissionId: "mission-1",
  missionState: "awaiting_plan_approval",
  currentTaskRole: "planner",
  currentTaskState: "completed",
  pendingDispatchCount: 0,
  eventStream: "connected",
  pollingFallbackActive: false,
  rosterCurrent: true,
  controlPlaneCurrent: true,
  lastFailureCode: null
};

describe("controller API", () => {
  it("rejects unauthenticated health requests", async () => {
    const workspace = makeWorkspace();
    const api = createControllerApi({
      token: "secret-token",
      metadata: makeMetadata(workspace),
      roster,
      status: async () => healthyStatus,
      shutdown: async () => undefined
    });
    const response = await api.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(401);
    await api.close();
  });

  it("rejects unauthenticated status requests", async () => {
    const workspace = makeWorkspace();
    const api = createControllerApi({
      token: "secret-token",
      metadata: makeMetadata(workspace),
      roster,
      status: async () => ({ ...healthyStatus, ready: false }),
      shutdown: async () => undefined
    });
    const response = await api.inject({ method: "GET", url: "/status" });
    expect(response.statusCode).toBe(401);
    await api.close();
  });

  it("returns a redacted liveness payload on /health", async () => {
    const workspace = makeWorkspace();
    const api = createControllerApi({
      token: "secret-token",
      metadata: makeMetadata(workspace),
      roster,
      status: async () => healthyStatus,
      shutdown: async () => undefined
    });
    const response = await api.inject({ method: "GET", url: "/health", headers: { authorization: "Bearer secret-token" } });
    const body = response.json();
    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      healthy: true,
      bindingCount: 0,
      opencodeHealthy: true,
      bindingsCurrent: true,
      port: 4317
    });
    expect(JSON.stringify(body)).not.toContain("secret-token");
    expect(JSON.stringify(body)).not.toContain("planner");
    await api.close();
  });

  it("returns the readiness snapshot on /status without raw model output", async () => {
    const workspace = makeWorkspace();
    const api = createControllerApi({
      token: "secret-token",
      metadata: () => makeMetadata(workspace),
      roster,
      status: async () => ({ ...healthyStatus, ready: false, lastFailureCode: "roster_drift" }),
      shutdown: async () => undefined
    });
    const response = await api.inject({ method: "GET", url: "/status", headers: { authorization: "Bearer secret-token" } });
    const body = response.json();
    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      ready: false,
      live: true,
      activeMissionId: "mission-1",
      missionState: "awaiting_plan_approval",
      pendingDispatchCount: 0,
      eventStream: "connected",
      lastFailureCode: "roster_drift"
    });
    expect(JSON.stringify(body)).not.toContain("prompt");
    expect(JSON.stringify(body)).not.toContain("rationale");
    await api.close();
  });

  it("accepts shutdown and invokes the shutdown hook", async () => {
    const workspace = makeWorkspace();
    let stopped = false;
    const api = createControllerApi({
      token: "secret-token",
      metadata: makeMetadata(workspace),
      roster,
      status: async () => healthyStatus,
      shutdown: async () => { stopped = true; }
    });
    const response = await api.inject({ method: "POST", url: "/shutdown", headers: { authorization: "Bearer secret-token" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ stopping: true });
    await new Promise((resolve) => globalThis.setTimeout(resolve, 10));
    expect(stopped).toBe(true);
    await api.close();
  });
});