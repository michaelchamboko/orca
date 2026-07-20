export type Role = "orchestrator" | "planner" | "builder" | "reviewer" | "tester";

export interface ModelRef {
  providerId: string;
  modelId: string;
  displayName?: string;
}

export interface SessionBinding {
  sessionId: string;
  position: 1 | 2 | 3 | 4 | 5;
  role: Role;
  model: ModelRef;
  agentName: string;
  projectRoot: string;
  projectFingerprint: string;
  serverBaseUrl: string;
  sessionCreatedAt: string;
  pairedAt: string;
  rolePromptHash: string;
  expectedTitle: string;
}

export type MissionState =
  | "planning"
  | "awaiting_plan_approval"
  | "building"
  | "awaiting_builder_approval"
  | "reviewing"
  | "awaiting_review_approval"
  | "testing"
  | "awaiting_test_approval"
  | "awaiting_final_approval"
  | "needs_user_input"
  | "blocked"
  | "recovering"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskState =
  | "queued"
  | "dispatched"
  | "running"
  | "awaiting_permission"
  | "result_contract_violation"
  | "reviewer_high_risk"
  | "completed"
  | "approved"
  | "rejected"
  | "timed_out"
  | "failed"
  | "cancelled";

export type EvidenceRequirement =
  | "summary"
  | "files"
  | "commands"
  | "tests"
  | "findings"
  | "risk_summary"
  | "recommended_next_action";

export interface TaskEnvelope {
  schemaVersion: "1.0";
  missionId: string;
  taskId: string;
  role: Exclude<Role, "orchestrator">;
  objective: string;
  acceptanceCriteria: string[];
  constraints: string[];
  requiredEvidence: EvidenceRequirement[];
  parentTaskIds: string[];
  attempt: number;
  projectRoot: string;
  baseCommit: string;
  sourceWorkspaceFingerprint: string;
  allowedPaths?: string[];
  createdAt: string;
  timeoutMs: number;
}

export type WorkerTaskStatus = "completed" | "blocked" | "failed";

export interface BaseWorkerResult {
  schemaVersion: "1.0";
  missionId: string;
  taskId: string;
  role: Exclude<Role, "orchestrator">;
  status: WorkerTaskStatus;
  summary: string;
  workPerformed: string[];
  files: Array<{
    path: string;
    action: "read" | "created" | "modified" | "deleted";
    summary: string;
  }>;
  commands: Array<{
    command: string;
    exitCode: number | null;
    summary: string;
  }>;
  tests: Array<{
    name: string;
    command: string;
    status: "passed" | "failed" | "not_run";
    evidence: string;
  }>;
  findings: Array<{
    severity: "info" | "low" | "medium" | "high" | "critical";
    title: string;
    description: string;
    file?: string;
    line?: number;
    blocking: boolean;
  }>;
  risks: string[];
  questions: string[];
  recommendedNextAction: string;
  sourceWorkspaceFingerprint: string;
  completedAt: string;
}

export interface PlannerResult {
  planVerdict: "ready" | "blocked";
  implementationSteps: string[];
  expectedFiles: string[];
  validationPlan: string[];
}

export interface BuilderResult {
  implementationVerdict: "implemented" | "blocked" | "failed";
  changedFiles: string[];
  targetedTestsRun: string[];
}

export interface ReviewerResult {
  reviewVerdict: "pass" | "changes_required" | "blocked";
  reviewedWorkspaceFingerprint: string;
}

export interface TesterResult {
  testVerdict: "pass" | "fail" | "blocked";
  testedWorkspaceFingerprint: string;
  requiredChecks: string[];
  passedChecks: string[];
  failedChecks: string[];
}

export type RoleWorkerResult = BaseWorkerResult &
  (
    | (BaseWorkerResult & PlannerResult)
    | (BaseWorkerResult & BuilderResult)
    | (BaseWorkerResult & ReviewerResult)
    | (BaseWorkerResult & TesterResult)
  );

export interface ValidationFieldError {
  path: string;
  message: string;
}

export interface ParsedWorkerResult {
  role: Exclude<Role, "orchestrator">;
  result: RoleWorkerResult;
}
