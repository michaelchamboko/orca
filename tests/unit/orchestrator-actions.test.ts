import { describe, expect, it } from "vitest";

import {
  ORCHESTRATOR_ACTION_SCHEMA_VERSION,
  isApproval,
  isRejection,
  isRequestCompletion,
  validateOrchestratorAction
} from "../../src/domain/action-schemas.js";

function valid(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: ORCHESTRATOR_ACTION_SCHEMA_VERSION,
    missionId: "mission-1",
    action: "approve",
    taskId: "task-1",
    rationale: "looks good",
    correctionInstructions: [],
    ...overrides
  };
}

describe("orchestrator action schema", () => {
  it("accepts a well-formed approve action", () => {
    const result = validateOrchestratorAction(valid());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isApproval(result.value)).toBe(true);
  });

  it("accepts a well-formed reject action with correction instructions", () => {
    const result = validateOrchestratorAction(valid({ action: "reject", correctionInstructions: ["fix the bug"] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isRejection(result.value)).toBe(true);
  });

  it("accepts a request_completion without a taskId", () => {
    const result = validateOrchestratorAction({ ...valid({ action: "request_completion" }), taskId: undefined });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.taskId).toBeUndefined();
    expect(isRequestCompletion(result.value)).toBe(true);
  });

  it("rejects unknown schema versions", () => {
    const result = validateOrchestratorAction(valid({ schemaVersion: "2.0" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("schema");
  });

  it("rejects unknown fields", () => {
    const result = validateOrchestratorAction({ ...valid(), injected: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("schema");
  });

  it("rejects unknown action kinds", () => {
    const result = validateOrchestratorAction(valid({ action: "explode" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("schema");
  });

  it("rejects approve without a taskId", () => {
    const result = validateOrchestratorAction(valid({ taskId: undefined }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("task_required");
  });

  it("rejects reject without a taskId", () => {
    const result = validateOrchestratorAction(valid({ action: "reject", taskId: undefined }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("task_required");
  });

  it("rejects request_completion with a taskId", () => {
    const mutated = { ...valid({ action: "request_completion" }), taskId: "task-1" };
    const mutatedResult = validateOrchestratorAction(mutated);
    expect(mutatedResult.ok).toBe(false);
    if (mutatedResult.ok) return;
    expect(mutatedResult.error.kind).toBe("task_forbidden");
  });

  it("rejects empty mission id", () => {
    const result = validateOrchestratorAction(valid({ missionId: "" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("schema");
  });

  it("rejects non-string rationale", () => {
    const result = validateOrchestratorAction({ ...valid(), rationale: 42 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("schema");
  });
});