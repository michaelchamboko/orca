import { describe, expect, it } from "vitest";

import {
  evaluateBuilderResult,
  evaluatePlannerResult,
  evaluateReviewerResult,
  evaluateTesterResult,
  evaluateBuilderWorkspaceDelta,
  detectReadOnlyRoleWorkspaceMutation,
  MAX_GATE_CORRECTIONS,
  PROTECTED_PATHS
} from "../../src/controller/quality-gates.js";
import type { BuilderResult, PlannerResult, ReviewerResult, RoleWorkerResult, TesterResult } from "../../src/domain/types.js";

function base(role: RoleWorkerResult["role"]): RoleWorkerResult {
  const result = {
    schemaVersion: "1.0" as const,
    missionId: "mission-1",
    taskId: "task-1",
    role,
    status: "completed" as const,
    summary: "ok",
    workPerformed: [],
    files: [],
    commands: [],
    tests: [],
    findings: [],
    risks: [],
    questions: [],
    recommendedNextAction: "proceed",
    sourceWorkspaceFingerprint: "fp",
    completedAt: "2026-01-01T00:00:00.000Z"
  };
  switch (role) {
    case "planner":
      return { ...result, role: "planner", planVerdict: "ready", implementationSteps: ["step"], expectedFiles: [], validationPlan: [] };
    case "builder":
      return { ...result, role: "builder", implementationVerdict: "implemented", changedFiles: [], targetedTestsRun: [] };
    case "reviewer":
      return { ...result, role: "reviewer", reviewVerdict: "pass", reviewedWorkspaceFingerprint: "fp" };
    case "tester":
      return { ...result, role: "tester", testVerdict: "pass", testedWorkspaceFingerprint: "fp", requiredChecks: [], passedChecks: [], failedChecks: [] };
    default:
      throw new Error(`unexpected role ${role}`);
  }
}

describe("evaluatePlannerResult", () => {
  it("passes when planner returns ready with implementation steps", () => {
    const result = { ...base("planner"), planVerdict: "ready", implementationSteps: ["step"], expectedFiles: [], validationPlan: [] } satisfies PlannerResult & RoleWorkerResult;
    expect(evaluatePlannerResult({ result, projectRoot: "/", fingerprint: "fp", workerFingerprint: "fp", correctedFingerprint: null })).toMatchObject({ passed: true });
  });

  it("rejects ready verdict with no implementation steps", () => {
    const result = { ...base("planner"), planVerdict: "ready", implementationSteps: [], expectedFiles: [], validationPlan: [] } satisfies PlannerResult & RoleWorkerResult;
    expect(evaluatePlannerResult({ result, projectRoot: "/", fingerprint: "fp", workerFingerprint: "fp", correctedFingerprint: null })).toMatchObject({ passed: false, reasonCode: "empty_implementation_steps" });
  });

  it("rejects non-planner results", () => {
    const result = { ...base("builder"), implementationVerdict: "implemented", changedFiles: ["a.ts"], targetedTestsRun: [] } as unknown as RoleWorkerResult;
    expect(evaluatePlannerResult({ result, projectRoot: "/", fingerprint: "fp", workerFingerprint: "fp", correctedFingerprint: null })).toMatchObject({ passed: false, reasonCode: "not_planner_role" });
  });
});

describe("evaluateBuilderResult", () => {
  it("passes when implemented with changed files and command/test evidence", () => {
    const result: RoleWorkerResult = {
      ...base("builder"),
      implementationVerdict: "implemented",
      changedFiles: ["src/foo.ts"],
      targetedTestsRun: ["vitest run foo.test.ts"],
      files: [{ path: "src/foo.ts", action: "modified", summary: "updated" }],
      commands: [{ command: "pnpm test", exitCode: 0, summary: "passed" }],
      tests: [{ name: "foo", command: "pnpm test foo", status: "passed", evidence: "1 passed" }]
    };
    expect(evaluateBuilderResult({ result: result as never, projectRoot: "/", fingerprint: "fp", workerFingerprint: "fp", correctedFingerprint: null })).toMatchObject({ passed: true });
  });

  it("rejects implemented verdict with no changed files", () => {
    const result: RoleWorkerResult = {
      ...base("builder"),
      implementationVerdict: "implemented",
      changedFiles: [],
      targetedTestsRun: [],
      files: [],
      commands: [],
      tests: []
    };
    expect(evaluateBuilderResult({ result: result as never, projectRoot: "/", fingerprint: "fp", workerFingerprint: "fp", correctedFingerprint: null })).toMatchObject({ passed: false, reasonCode: "builder_missing_changed_files" });
  });

  it("rejects when a changed file is not declared in files list", () => {
    const result: RoleWorkerResult = {
      ...base("builder"),
      implementationVerdict: "implemented",
      changedFiles: ["src/foo.ts", "src/bar.ts"],
      targetedTestsRun: ["pnpm test"],
      files: [{ path: "src/foo.ts", action: "modified", summary: "updated" }],
      commands: [{ command: "pnpm test", exitCode: 0, summary: "passed" }],
      tests: [{ name: "foo", command: "pnpm test foo", status: "passed", evidence: "ok" }]
    };
    expect(evaluateBuilderResult({ result: result as never, projectRoot: "/", fingerprint: "fp", workerFingerprint: "fp", correctedFingerprint: null })).toMatchObject({ passed: false, reasonCode: "builder_changed_file_undeclared" });
  });

  it.each([".orca/state.sqlite", ".opencode/agents/orca-builder.md", "orca.config.json"])(
    "rejects Builder mutation of protected path %s",
    (path) => {
      const result: RoleWorkerResult = {
        ...base("builder"),
        implementationVerdict: "implemented",
        changedFiles: [path],
        targetedTestsRun: ["pnpm test"],
        files: [{ path, action: "modified", summary: "updated" }],
        commands: [{ command: "pnpm test", exitCode: 0, summary: "passed" }],
        tests: [{ name: "t", command: "pnpm test", status: "passed", evidence: "ok" }]
      };
      expect(evaluateBuilderResult({ result: result as never, projectRoot: "/", fingerprint: "fp", workerFingerprint: "fp", correctedFingerprint: null })).toMatchObject({ passed: false, reasonCode: "builder_touched_control_plane" });
      expect(PROTECTED_PATHS.has(path.split("/")[0]) || PROTECTED_PATHS.has(path)).toBe(true);
    }
  );

  it("rejects implemented verdict without command evidence", () => {
    const result: RoleWorkerResult = {
      ...base("builder"),
      implementationVerdict: "implemented",
      changedFiles: ["src/foo.ts"],
      targetedTestsRun: ["pnpm test"],
      files: [{ path: "src/foo.ts", action: "modified", summary: "updated" }],
      commands: [],
      tests: [{ name: "foo", command: "pnpm test foo", status: "passed", evidence: "ok" }]
    };
    expect(evaluateBuilderResult({ result: result as never, projectRoot: "/", fingerprint: "fp", workerFingerprint: "fp", correctedFingerprint: null })).toMatchObject({ passed: false, reasonCode: "builder_missing_command_evidence" });
  });

  it("rejects implemented verdict without test evidence", () => {
    const result: RoleWorkerResult = {
      ...base("builder"),
      implementationVerdict: "implemented",
      changedFiles: ["src/foo.ts"],
      targetedTestsRun: [],
      files: [{ path: "src/foo.ts", action: "modified", summary: "updated" }],
      commands: [{ command: "pnpm test", exitCode: 0, summary: "passed" }],
      tests: []
    };
    expect(evaluateBuilderResult({ result: result as never, projectRoot: "/", fingerprint: "fp", workerFingerprint: "fp", correctedFingerprint: null })).toMatchObject({ passed: false, reasonCode: "builder_missing_test_evidence" });
  });

  it("accepts blocked verdict with summary", () => {
    const result: RoleWorkerResult = {
      ...base("builder"),
      implementationVerdict: "blocked",
      changedFiles: [],
      targetedTestsRun: [],
      summary: "cannot proceed"
    };
    expect(evaluateBuilderResult({ result: result as never, projectRoot: "/", fingerprint: "fp", workerFingerprint: "fp", correctedFingerprint: null })).toMatchObject({ passed: true });
  });
});

describe("evaluateReviewerResult", () => {
  it("passes when reviewer matches fingerprint and has no blocking findings", () => {
    const result = { ...base("reviewer"), reviewVerdict: "pass", reviewedWorkspaceFingerprint: "fp" } satisfies ReviewerResult & RoleWorkerResult;
    expect(evaluateReviewerResult({ result, projectRoot: "/", fingerprint: "fp", workerFingerprint: "fp", correctedFingerprint: null })).toMatchObject({ passed: true });
  });

  it("rejects reviewer pass with blocking high finding", () => {
    const result: RoleWorkerResult = {
      ...base("reviewer"),
      reviewVerdict: "pass",
      reviewedWorkspaceFingerprint: "fp",
      findings: [{ severity: "high", title: "x", description: "y", blocking: true }]
    };
    expect(evaluateReviewerResult({ result, projectRoot: "/", fingerprint: "fp", workerFingerprint: "fp", correctedFingerprint: null })).toMatchObject({ passed: false, reasonCode: "reviewer_pass_with_blocking_finding" });
  });

  it("rejects reviewer pass with mismatched fingerprint", () => {
    const result = { ...base("reviewer"), reviewVerdict: "pass", reviewedWorkspaceFingerprint: "different" } satisfies ReviewerResult & RoleWorkerResult;
    expect(evaluateReviewerResult({ result, projectRoot: "/", fingerprint: "fp", workerFingerprint: "fp", correctedFingerprint: null })).toMatchObject({ passed: false, reasonCode: "reviewer_fingerprint_mismatch" });
  });
});

describe("evaluateTesterResult", () => {
  it("passes when tester pass covers all configured checks", () => {
    const result = { ...base("tester"), testVerdict: "pass", testedWorkspaceFingerprint: "fp", requiredChecks: ["lint"], passedChecks: ["lint"], failedChecks: [] } satisfies TesterResult & RoleWorkerResult;
    expect(evaluateTesterResult({ result, projectRoot: "/", fingerprint: "fp", workerFingerprint: "fp", correctedFingerprint: null, configuredChecks: ["lint"] })).toMatchObject({ passed: true });
  });

  it("rejects tester pass with mismatched fingerprint", () => {
    const result = { ...base("tester"), testVerdict: "pass", testedWorkspaceFingerprint: "different", requiredChecks: ["lint"], passedChecks: ["lint"], failedChecks: [] } satisfies TesterResult & RoleWorkerResult;
    expect(evaluateTesterResult({ result, projectRoot: "/", fingerprint: "fp", workerFingerprint: "fp", correctedFingerprint: null, configuredChecks: ["lint"] })).toMatchObject({ passed: false, reasonCode: "tester_fingerprint_mismatch" });
  });

  it("rejects tester pass that misses a configured check", () => {
    const result = { ...base("tester"), testVerdict: "pass", testedWorkspaceFingerprint: "fp", requiredChecks: ["lint"], passedChecks: [], failedChecks: [] } satisfies TesterResult & RoleWorkerResult;
    expect(evaluateTesterResult({ result, projectRoot: "/", fingerprint: "fp", workerFingerprint: "fp", correctedFingerprint: null, configuredChecks: ["lint"] })).toMatchObject({ passed: false, reasonCode: "tester_missing_required_pass" });
  });
});

describe("evaluateBuilderWorkspaceDelta", () => {
  it("passes when claimed changes match the observed delta", () => {
    const fingerprint = { fingerprint: "fp", gitHead: "", statusHash: "", diffHash: "", untrackedContentHash: "", controlPlaneHash: "", changedPaths: ["src/foo.ts"], capturedAt: "" };
    const result: BuilderResult = { implementationVerdict: "implemented", changedFiles: ["src/foo.ts"], targetedTestsRun: [] };
    expect(evaluateBuilderWorkspaceDelta({ fingerprint, result })).toMatchObject({ passed: true });
  });

  it("rejects unobserved claim", () => {
    const fingerprint = { fingerprint: "fp", gitHead: "", statusHash: "", diffHash: "", untrackedContentHash: "", controlPlaneHash: "", changedPaths: [], capturedAt: "" };
    const result: BuilderResult = { implementationVerdict: "implemented", changedFiles: ["src/foo.ts"], targetedTestsRun: [] };
    expect(evaluateBuilderWorkspaceDelta({ fingerprint, result })).toMatchObject({ passed: false, reasonCode: expect.stringMatching(/builder_changed_files_unobserved/) });
  });

  it("rejects unclaimed observation", () => {
    const fingerprint = { fingerprint: "fp", gitHead: "", statusHash: "", diffHash: "", untrackedContentHash: "", controlPlaneHash: "", changedPaths: ["src/foo.ts"], capturedAt: "" };
    const result: BuilderResult = { implementationVerdict: "implemented", changedFiles: [], targetedTestsRun: [] };
    expect(evaluateBuilderWorkspaceDelta({ fingerprint, result })).toMatchObject({ passed: false, reasonCode: expect.stringMatching(/builder_changed_files_unclaimed/) });
  });
});

describe("detectReadOnlyRoleWorkspaceMutation", () => {
  it("detects fingerprint change", () => {
    const before = fingerprintOf("a");
    const after = fingerprintOf("b");
    expect(detectReadOnlyRoleWorkspaceMutation({ before, after })).toBe(true);
  });

  it("returns false when fingerprint is unchanged", () => {
    const before = fingerprintOf("a");
    const after = fingerprintOf("a");
    expect(detectReadOnlyRoleWorkspaceMutation({ before, after })).toBe(false);
  });
});

describe("MAX_GATE_CORRECTIONS", () => {
  it("is two corrections per gate", () => {
    expect(MAX_GATE_CORRECTIONS).toBe(2);
  });
});

function fingerprintOf(value: string): { fingerprint: string; gitHead: string; statusHash: string; diffHash: string; untrackedContentHash: string; controlPlaneHash: string; changedPaths: string[]; capturedAt: string } {
  return { fingerprint: value, gitHead: "", statusHash: "", diffHash: "", untrackedContentHash: "", controlPlaneHash: "", changedPaths: [], capturedAt: "" };
}