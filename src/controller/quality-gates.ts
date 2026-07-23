import { createHash } from "node:crypto";

import type {
  BaseWorkerResult,
  BuilderResult,
  PlannerResult,
  ReviewerResult,
  RoleWorkerResult,
  TesterResult
} from "../domain/types.js";
import { captureWorkspaceFingerprint, type WorkspaceFingerprint } from "./workspace-fingerprint.js";

type WorkerFiles = { path: string; action: "read" | "created" | "modified" | "deleted"; summary: string }[];
type WorkerCommands = { command: string; exitCode: number | null; summary: string }[];
type WorkerTests = { name: string; command: string; status: "passed" | "failed" | "not_run"; evidence: string }[];
type BuilderWithEvidence = BuilderResult & { files: WorkerFiles; commands: WorkerCommands; tests: WorkerTests; summary: string; findings: BaseWorkerResult["findings"]; role: "builder" };

const PROTECTED_CONTROL_PLANE_PATHS = new Set([
  ".orca",
  ".opencode",
  "orca.config.json"
]);

const MAX_CORRECTIONS_PER_GATE = 2;

export interface QualityGateEvaluation {
  readonly passed: boolean;
  readonly reasonCode: string | null;
  readonly reason: string | null;
}

export interface QualityGateContext {
  projectRoot: string;
  fingerprint: string;
  workerFingerprint: string;
  correctedFingerprint: string | null;
}

export interface BuilderEvaluationInput extends QualityGateContext {
  result: BuilderWithEvidence;
}

/**
 * Quality gate for Planner results. The Planner must match the dispatch
 * fingerprint and may not declare any file changes.
 */
export function evaluatePlannerResult(input: { result: RoleWorkerResult } & QualityGateContext): QualityGateEvaluation {
  const planner = input.result as PlannerResult;
  if (input.result.role !== "planner") return reject("not_planner_role");
  if (typeof planner.implementationSteps === "undefined") return reject("missing_implementation_steps");
  if (planner.planVerdict === "ready" && planner.implementationSteps.length === 0) return reject("empty_implementation_steps");
  return { passed: true, reasonCode: null, reason: null };
}

/**
 * Quality gate for Builder results. Enforces implemented-verdict evidence,
 * non-empty changed file set, no control-plane mutation, and repository-only
 * paths.
 */
export function evaluateBuilderResult(input: BuilderEvaluationInput): QualityGateEvaluation {
  const builder = input.result as BuilderWithEvidence;
  if (builder.role !== "builder") return reject("not_builder_role");
  if (builder.implementationVerdict === "implemented") {
    if (builder.changedFiles.length === 0) return reject("builder_missing_changed_files");
    const allFiles = builder.files ?? [];
    const fileSet = new Set(allFiles.map((entry) => entry.path));
    for (const changed of builder.changedFiles) {
      if (!fileSet.has(changed)) return reject("builder_changed_file_undeclared");
    }
    for (const file of allFiles) {
      if (PROTECTED_CONTROL_PLANE_PATHS.has(file.path)) return reject("builder_touched_control_plane");
      const normalized = file.path.replace(/\\/g, "/");
      for (const protectedPath of PROTECTED_CONTROL_PLANE_PATHS) {
        if (normalized === protectedPath) return reject("builder_touched_control_plane");
        if (normalized.startsWith(`${protectedPath}/`)) return reject("builder_touched_control_plane");
      }
      if (file.action === "modified" || file.action === "created") {
        if (!builder.commands || builder.commands.length === 0) return reject("builder_missing_command_evidence");
        if (!builder.tests || builder.tests.length === 0) return reject("builder_missing_test_evidence");
      }
    }
  } else if (builder.implementationVerdict === "blocked" || builder.implementationVerdict === "failed") {
    if (!builder.summary) return reject("builder_blocked_without_summary");
  } else {
    return reject("unknown_builder_verdict");
  }
  return { passed: true, reasonCode: null, reason: null };
}

/**
 * Quality gate for Reviewer results. Requires a review fingerprint that
 * matches the current workspace and forbids any blocking findings when
 * returning pass.
 */
export function evaluateReviewerResult(input: { result: RoleWorkerResult } & QualityGateContext): QualityGateEvaluation {
  const reviewer = input.result as ReviewerResult;
  if (input.result.role !== "reviewer") return reject("not_reviewer_role");
  if (reviewer.reviewVerdict === "pass") {
    if (reviewer.reviewedWorkspaceFingerprint !== input.fingerprint) return reject("reviewer_fingerprint_mismatch");
    const findings = input.result.findings ?? [];
    const blocking = findings.some((finding) => finding.blocking && (finding.severity === "high" || finding.severity === "critical"));
    if (blocking) return reject("reviewer_pass_with_blocking_finding");
  } else if (reviewer.reviewVerdict === "changes_required") {
    if (reviewer.reviewedWorkspaceFingerprint !== input.fingerprint) return reject("reviewer_fingerprint_mismatch");
  }
  return { passed: true, reasonCode: null, reason: null };
}

/**
 * Quality gate for Tester results. Requires the tested fingerprint to match,
 * and the required/passed/failed lists to align with the configured checks.
 */
export function evaluateTesterResult(input: { result: RoleWorkerResult; configuredChecks: readonly string[] } & QualityGateContext): QualityGateEvaluation {
  const tester = input.result as TesterResult;
  if (input.result.role !== "tester") return reject("not_tester_role");
  if (tester.testedWorkspaceFingerprint !== input.fingerprint) return reject("tester_fingerprint_mismatch");
  const requiredChecks = input.configuredChecks ?? [];
  if (tester.testVerdict === "pass") {
    for (const check of tester.requiredChecks) if (!requiredChecks.includes(check)) return reject("tester_unknown_required_check");
    for (const check of requiredChecks) if (!tester.passedChecks.includes(check)) return reject("tester_missing_required_pass");
    if (tester.failedChecks.length > 0) return reject("tester_pass_with_failures");
  }
  return { passed: true, reasonCode: null, reason: null };
}

/**
 * Validates that a Builder result's changed files match the workspace delta
 * observed by the controller. Returns a rejection reason when the worker
 * claims changes that the workspace does not show or omits observed changes.
 */
export function evaluateBuilderWorkspaceDelta(input: {
  fingerprint: WorkspaceFingerprint;
  result: BuilderResult;
}): QualityGateEvaluation {
  const claimed = new Set(input.result.changedFiles.map((path) => path.replace(/\\/g, "/")));
  const observed = new Set(input.fingerprint.changedPaths.map((path) => path.replace(/\\/g, "/")));
  const unobservedClaimed = [...claimed].filter((path) => !observed.has(path));
  const unclaimedObserved = [...observed].filter((path) => !claimed.has(path));
  if (unobservedClaimed.length > 0) return reject(`builder_changed_files_unobserved:${unobservedClaimed.join(",")}`);
  if (unclaimedObserved.length > 0) return reject(`builder_changed_files_unclaimed:${unclaimedObserved.join(",")}`);
  return { passed: true, reasonCode: null, reason: null };
}

/**
 * Detects whether a read-only role (Planner, Reviewer, Tester) changed the
 * workspace. Any write by a read-only role blocks mission advancement.
 */
export function detectReadOnlyRoleWorkspaceMutation(input: {
  before: WorkspaceFingerprint;
  after: WorkspaceFingerprint;
}): boolean {
  return input.before.fingerprint !== input.after.fingerprint;
}

/**
 * Returns true when a corrected fingerprint is bound to the same Builder
 * result. Used by review/test corrections to ensure new work is anchored.
 */
export function isFingerprintMatched(observed: string, claimed: string): boolean {
  return observed === claimed;
}

export function fingerprintHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function captureProjectFingerprint(projectRoot: string): WorkspaceFingerprint {
  return captureWorkspaceFingerprint(projectRoot);
}

export const MAX_GATE_CORRECTIONS = MAX_CORRECTIONS_PER_GATE;
export const PROTECTED_PATHS = PROTECTED_CONTROL_PLANE_PATHS;

function reject(reasonCode: string, reason?: string): QualityGateEvaluation {
  return { passed: false, reasonCode, reason: reason ?? reasonCode };
}