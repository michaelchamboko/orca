import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqlitePersistence } from "../../src/persistence/sqlite.js";
import { CompletionGateEvaluator } from "../../src/controller/completion-gate-evaluator.js";
import type { PairedRoster } from "../../src/domain/types.js";

const roots: string[] = [];
const stores: SqlitePersistence[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "orca-completion-"));
  roots.push(root);
  mkdirSync(join(root, ".opencode"));
  const persistence = new SqlitePersistence({ path: join(root, "state.sqlite") });
  stores.push(persistence);
  const roster: PairedRoster = {
    rosterId: "roster-1",
    fingerprint: "fp",
    serverBaseUrl: "http://127.0.0.1:4096",
    projectRoot: root,
    pairedAt: "2025-01-01T00:00:00.000Z",
    bindings: []
  };
  persistence.saveRoster(roster);
  return { root, persistence };
}

describe("CompletionGateEvaluator", () => {
  it("rejects completion before the final approval gate", () => {
    const { persistence, root } = setup();
    persistence.createMission({ missionId: "mission-1", rosterId: "roster-1", objective: "test", sourceSessionMessageId: "src", state: "awaiting_test_approval" });
    const evaluator = new CompletionGateEvaluator({ persistence, projectRoot: root, controlPlaneHash: "cp", configHash: "cfg" });
    const result = evaluator.evaluate({ missionId: "mission-1", fingerprint: "fp", configuredChecks: [], pendingPermissionCount: 0, hasExplicitCompletionRequest: true });
    expect(result.satisfied).toBe(false);
    expect(result.missing).toContain("mission_not_at_final_gate");
  });

  it("rejects completion when review or test approvals are missing", () => {
    const { persistence, root } = setup();
    persistence.createMission({ missionId: "mission-1", rosterId: "roster-1", objective: "test", sourceSessionMessageId: "src", state: "awaiting_final_approval" });
    const evaluator = new CompletionGateEvaluator({ persistence, projectRoot: root, controlPlaneHash: "cp", configHash: "cfg" });
    const result = evaluator.evaluate({ missionId: "mission-1", fingerprint: "fp", configuredChecks: [], pendingPermissionCount: 0, hasExplicitCompletionRequest: true });
    expect(result.satisfied).toBe(false);
    expect(result.missing).toContain("currentReviewApproved");
    expect(result.missing).toContain("currentTestApproved");
    expect(result.missing).not.toContain("mission_not_at_final_gate");
  });

  it("rejects completion when pending permission requests exist", () => {
    const { persistence, root } = setup();
    persistence.createMission({ missionId: "mission-1", rosterId: "roster-1", objective: "test", sourceSessionMessageId: "src", state: "awaiting_final_approval" });
    persistence.recordApproval({ approvalId: "ap-review", missionId: "mission-1", taskId: null, decision: "approved", reason: null });
    persistence.recordApproval({ approvalId: "ap-test", missionId: "mission-1", taskId: null, decision: "approved", reason: null });
    persistence.recordPermissionRequest({ missionId: "mission-1", sessionId: "session-3", toolName: "bash", details: {} });
    const evaluator = new CompletionGateEvaluator({ persistence, projectRoot: root, controlPlaneHash: "cp", configHash: "cfg" });
    const result = evaluator.evaluate({ missionId: "mission-1", fingerprint: "fp", configuredChecks: [], pendingPermissionCount: 1, hasExplicitCompletionRequest: true });
    expect(result.satisfied).toBe(false);
    expect(result.missing).toContain("noPermissionRequests");
  });

  it("rejects completion when the orchestrator has not requested completion", () => {
    const { persistence, root } = setup();
    persistence.createMission({ missionId: "mission-1", rosterId: "roster-1", objective: "test", sourceSessionMessageId: "src", state: "awaiting_final_approval" });
    persistence.recordApproval({ approvalId: "ap-review", missionId: "mission-1", taskId: null, decision: "approved", reason: null });
    persistence.recordApproval({ approvalId: "ap-test", missionId: "mission-1", taskId: null, decision: "approved", reason: null });
    const evaluator = new CompletionGateEvaluator({ persistence, projectRoot: root, controlPlaneHash: "cp", configHash: "cfg" });
    const result = evaluator.evaluate({ missionId: "mission-1", fingerprint: "fp", configuredChecks: [], pendingPermissionCount: 0, hasExplicitCompletionRequest: false });
    expect(result.missing).toContain("explicitRequestCompletion");
  });
});