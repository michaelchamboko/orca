import { describe, expect, it } from "vitest";

import {
  nextMissionStateFromResult,
  nextTaskStateFromMissionState,
  requiredRoleForMissionState,
  WorkerResult
} from "../../src/domain/workflow.js";
import { nextStateForDeniedApproval, resolveMissionApproval } from "../../src/domain/policy.js";

const baseResult = {
  schemaVersion: "1.0" as const,
  missionId: "mission-1",
  taskId: "task-1",
      status: "completed" as const,
  summary: "done",
  workPerformed: ["done"],
  files: [
      {
        path: "src/index.ts",
        action: "read" as const,
        summary: "checked"
      }
  ],
  commands: [
    {
      command: "pnpm test",
      exitCode: 0,
      summary: "pass"
    }
  ],
  tests: [
    {
      name: "not run",
      command: "pnpm test",
      status: "not_run" as const,
      evidence: "not run"
    }
  ],
  findings: [],
  risks: [],
  questions: [],
  recommendedNextAction: "continue",
  sourceWorkspaceFingerprint: "fp",
  completedAt: new Date().toISOString()
};

describe("workflow roles", () => {
  it("maps active states to expected worker", () => {
    expect(requiredRoleForMissionState("planning")).toBe("planner");
    expect(requiredRoleForMissionState("building")).toBe("builder");
    expect(requiredRoleForMissionState("reviewing")).toBe("reviewer");
    expect(requiredRoleForMissionState("testing")).toBe("tester");
    expect(requiredRoleForMissionState("completed")).toBeNull();
  });
});

describe("workflow transitions", () => {
  it("moves to plan approval after planner success", () => {
    const result: WorkerResult = {
      ...baseResult,
      role: "planner",
      planVerdict: "ready",
      implementationSteps: ["one"],
      expectedFiles: ["src/index.ts"],
      validationPlan: ["pnpm test"]
    };

    expect(nextMissionStateFromResult("planning", result)).toBe("awaiting_plan_approval");
  });

  it("moves to builder approval when builder implements", () => {
    const result: WorkerResult = {
      ...baseResult,
      role: "builder",
      implementationVerdict: "implemented",
      changedFiles: ["src/index.ts"],
      targetedTestsRun: ["pnpm test"]
    };

    expect(nextMissionStateFromResult("building", result)).toBe("awaiting_builder_approval");
  });

  it("moves to review approval when reviewer passes", () => {
    const result: WorkerResult = {
      ...baseResult,
      role: "reviewer",
      reviewVerdict: "pass",
      reviewedWorkspaceFingerprint: "fp-review"
    };

    expect(nextMissionStateFromResult("reviewing", result)).toBe("awaiting_review_approval");
  });

  it("moves to test approval when tester passes", () => {
    const result: WorkerResult = {
      ...baseResult,
      role: "tester",
      testVerdict: "pass",
      testedWorkspaceFingerprint: "fp-test",
      requiredChecks: ["pnpm test"],
      passedChecks: ["pnpm test"],
      failedChecks: []
    };

    expect(nextMissionStateFromResult("testing", result)).toBe("awaiting_test_approval");
  });

  it("throws on invalid state/result mismatch", () => {
    const result: WorkerResult = {
      ...baseResult,
      role: "planner",
      planVerdict: "ready",
      implementationSteps: ["one"],
      expectedFiles: ["src/index.ts"],
      validationPlan: ["pnpm test"]
    };

    expect(() => nextMissionStateFromResult("building", result)).toThrow(/planner result not valid/);
  });
});

describe("workflow policy", () => {
  it("approves plan gate into build", () => {
    expect(resolveMissionApproval("awaiting_plan_approval", true)).toBe("building");
  });

  it("rejects plan gate into user input", () => {
    expect(resolveMissionApproval("awaiting_plan_approval", false)).toBe("needs_user_input");
    expect(nextStateForDeniedApproval("awaiting_test_approval")).toBe("needs_user_input");
  });

  it("routes approval gates forward", () => {
    expect(resolveMissionApproval("awaiting_builder_approval", true)).toBe("reviewing");
    expect(resolveMissionApproval("awaiting_review_approval", true)).toBe("testing");
    expect(resolveMissionApproval("awaiting_test_approval", true)).toBe("awaiting_final_approval");
    expect(resolveMissionApproval("awaiting_final_approval", true)).toBe("completed");
  });

  it("derives task state by mission state", () => {
    expect(nextTaskStateFromMissionState("planning")).toBe("running");
    expect(nextTaskStateFromMissionState("awaiting_plan_approval")).toBe("awaiting_permission");
    expect(nextTaskStateFromMissionState("completed")).toBe("approved");
    expect(nextTaskStateFromMissionState("blocked")).toBe("approved");
  });
});
