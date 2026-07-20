import { describe, expect, it } from "vitest";
import { z } from "zod";

import { parseTaskEnvelope, parseWorkerResult, taskEnvelopeSchema, formatValidationErrors } from "../../src/domain/schemas.js";

const baseTaskEnvelope = {
  schemaVersion: "1.0" as const,
  missionId: "mission-1",
  taskId: "task-1",
  role: "planner" as const,
  objective: "Inspect auth and suggest an implementation plan",
  acceptanceCriteria: ["Return a structured plan"],
  constraints: ["No scope creep"],
  requiredEvidence: ["summary", "files", "recommended_next_action"] as const,
  parentTaskIds: [],
  attempt: 1,
  projectRoot: "/repo",
  baseCommit: "abc123",
  sourceWorkspaceFingerprint: "fp-a",
  createdAt: new Date().toISOString(),
  timeoutMs: 5_000
};

function makeWorkerBase(role: "planner" | "builder" | "reviewer" | "tester") {
  return {
    schemaVersion: "1.0",
    missionId: "mission-1",
    taskId: "task-1",
    role,
    status: "completed",
    summary: "Work completed",
    workPerformed: ["Read and report context"],
    files: [
      {
        path: "src/auth.ts",
        action: "read",
        summary: "Read auth entry point"
      }
    ],
    commands: [
      {
        command: "ls",
        exitCode: 0,
        summary: "listed"
      }
    ],
    tests: [
      {
        name: "not run",
        command: "pnpm test",
        status: "not_run",
        evidence: "not run by design"
      }
    ],
    findings: [],
    risks: ["small risk"],
    questions: [],
    recommendedNextAction: "approve",
    sourceWorkspaceFingerprint: "fp-a",
    completedAt: new Date().toISOString()
  };
}

function makePlannerResult(overrides: Record<string, unknown> = {}) {
  return {
    ...makeWorkerBase("planner"),
    planVerdict: "ready",
    implementationSteps: ["Inspect", "Implement"],
    expectedFiles: ["src/auth.ts"],
    validationPlan: ["pnpm test"],
    ...overrides
  };
}

function makeBuilderResult(overrides: Record<string, unknown> = {}) {
  return {
    ...makeWorkerBase("builder"),
    implementationVerdict: "implemented",
    changedFiles: ["src/auth.ts"],
    targetedTestsRun: ["pnpm test"],
    ...overrides
  };
}

function makeReviewerResult(overrides: Record<string, unknown> = {}) {
  return {
    ...makeWorkerBase("reviewer"),
    reviewVerdict: "pass",
    reviewedWorkspaceFingerprint: "fp-b",
    ...overrides
  };
}

function makeTesterResult(overrides: Record<string, unknown> = {}) {
  return {
    ...makeWorkerBase("tester"),
    testVerdict: "pass",
    testedWorkspaceFingerprint: "fp-c",
    requiredChecks: ["lint", "unit"],
    passedChecks: ["lint", "unit"],
    failedChecks: [],
    ...overrides
  };
}

describe("schemas", () => {
  it("accepts a valid task envelope", () => {
    expect(() => parseTaskEnvelope(baseTaskEnvelope)).not.toThrow();
  });

  it("rejects invalid role", () => {
    const invalidRole = { ...baseTaskEnvelope, role: "manager" };
    expect(() => taskEnvelopeSchema.parse(invalidRole)).toThrow(z.ZodError);
  });

  it("rejects wrong schema version", () => {
    const wrong = { ...baseTaskEnvelope, schemaVersion: "2.0" };
    expect(() => parseTaskEnvelope(wrong)).toThrow(z.ZodError);
  });

  it("rejects result with mismatched task id", () => {
    expect(() => parseWorkerResult("planner", "mission-1", "task-1", makePlannerResult({ taskId: "wrong" }))).toThrow(
      /taskId mismatch/
    );
  });

  it("rejects result with mismatched mission id", () => {
    expect(() => parseWorkerResult("planner", "mission-2", "task-1", makePlannerResult({ missionId: "mission-1" }))).toThrow(
      /missionId mismatch/
    );
  });

  it("rejects result with mismatched role", () => {
    expect(() =>
      parseWorkerResult("planner", "mission-1", "task-1", makeBuilderResult({ role: "builder" }))
    ).toThrow(z.ZodError);
  });

  it("rejects planner result missing implementation steps", () => {
    expect(() =>
      parseWorkerResult("planner", "mission-1", "task-1", makePlannerResult({ implementationSteps: [] }))
    ).toThrow(/implementationSteps/);
  });

  it("rejects builder result missing changed files when implemented", () => {
    expect(() =>
      parseWorkerResult("builder", "mission-1", "task-1", {
        ...makeBuilderResult(),
        changedFiles: []
      })
    ).toThrow(/changedFiles/);
  });

  it("accepts reviewer pass with non-blocking high severity finding", () => {
    expect(() =>
      parseWorkerResult(
        "reviewer",
        "mission-1",
        "task-1",
        {
          ...makeReviewerResult(),
          findings: [
            {
              severity: "high",
              title: "non-blocking concern",
              description: "needs attention but accepted",
              blocking: false
            }
          ]
        }
      )
    ).not.toThrow();
  });

  it("rejects reviewer pass with blocking high finding", () => {
    expect(() =>
      parseWorkerResult(
        "reviewer",
        "mission-1",
        "task-1",
        {
          ...makeReviewerResult(),
          reviewVerdict: "pass",
          findings: [
            {
              severity: "high",
              title: "security risk",
              description: "blocking high-risk item",
              blocking: true
            }
          ]
        }
      )
    ).toThrow(/blocking high or critical findings/);
  });

  it("accepts tester pass when required checks are fully passed", () => {
    expect(() =>
      parseWorkerResult(
        "tester",
        "mission-1",
        "task-1",
        {
          ...makeTesterResult(),
          requiredChecks: ["lint", "unit", "typecheck"],
          passedChecks: ["typecheck", "lint", "unit"],
          failedChecks: []
        }
      )
    ).not.toThrow();
  });

  it("rejects tester pass with no required checks", () => {
    expect(() =>
      parseWorkerResult(
        "tester",
        "mission-1",
        "task-1",
        makeTesterResult({ requiredChecks: [], passedChecks: [], failedChecks: [] })
      )
    ).toThrow(/requiredChecks/);
  });

  it("rejects tester pass with failed check", () => {
    expect(() =>
      parseWorkerResult(
        "tester",
        "mission-1",
        "task-1",
        {
          ...makeTesterResult(),
          requiredChecks: ["lint"],
          passedChecks: ["lint"],
          failedChecks: ["unit"]
        }
      )
    ).toThrow(/failed checks/);
  });

  it("rejects unknown critical fields", () => {
    expect(() =>
      parseWorkerResult("planner", "mission-1", "task-1", {
        ...makePlannerResult(),
        rogueField: true
      })
    ).toThrow(z.ZodError);
  });

  it("formats validation errors with field path", () => {
    let thrownError: z.ZodError | undefined;

    try {
      parseTaskEnvelope({ ...baseTaskEnvelope, missionId: 123 as unknown as string });
    } catch (error) {
      thrownError = error as z.ZodError;
    }

    expect(thrownError).toBeDefined();
    expect(formatValidationErrors(thrownError as z.ZodError)).toEqual([
      {
        path: "missionId",
        message: expect.stringContaining("Expected string")
      }
    ]);
  });
});
