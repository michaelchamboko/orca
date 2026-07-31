import { randomUUID } from "node:crypto";

import type { OpenCodeLiveAdapter } from "../integrations/opencode/adapter.js";
import type {
  MissionState,
  ModelRef,
  PairedRoster,
  Role,
  RoleWorkerResult,
  TaskEnvelope
} from "../domain/types.js";
import { requiredRoleForMissionState, isApprovalGate, isTerminalState } from "../domain/workflow.js";
import type { DispatchPurpose } from "../persistence/sqlite.js";
import type { WorkflowPersistence } from "./workflow-persistence.js";
import type { OrchestratorAction } from "../domain/action-schemas.js";
import type {
  BuilderCorrectionContext,
  BuilderEvidence,
  ControllerCheckEvidence,
  MissionTaskContext,
  MissionTaskDescriptor,
  PlannerEvidence
} from "./mission-context.js";
import { MissionContextError } from "./mission-context.js";

const ROLE_SEQUENCE = ["planner", "builder", "reviewer", "tester"] as const;
const CORRECTION_ATTEMPT_CAP = 2;

export type CorrectionGate = "plan" | "builder" | "review" | "test";

export interface MissionTransitionInput {
  missionId: string;
  nextState: MissionState;
  failureReason?: string;
  expectedState?: MissionState;
  expectedVersion?: number;
}

export interface MissionTransitionResult {
  missionId: string;
  previousState: MissionState;
  nextState: MissionState;
  appliedAt: string;
  consumedTaskId: string | null;
  supersededApprovalCount: number;
  pendingDispatchKey: string | null;
  taskCreated: { taskId: string; role: Role; envelope: TaskEnvelope; targetSessionId: string; capturedModel: ModelRef; promptMessageId: string; dispatchKey: string } | null;
  stateVersion: number;
}

export interface MissionActionContext {
  getRoster(): Promise<PairedRoster>;
  bind(role: Role): { sessionId: string; agentName: string; model: ModelRef };
  nextTaskForRole(role: Role, missionId: string, attempt: number, context: MissionTaskContext): MissionTaskDescriptor;
  nextDecisionPrompt(missionId: string, gate: "plan" | "builder" | "review" | "test" | "final", taskId: string): { targetSessionId: string; capturedModel: ModelRef; promptMessageId: string; dispatchKey: string };
  publishNotice?(content: string, correlationId: string): Promise<void>;
}

export class MissionService {
  constructor(
    private readonly persistence: WorkflowPersistence,
    private readonly adapter: OpenCodeLiveAdapter,
    private readonly context: MissionActionContext
  ) {}

  /**
   * Reconcile completed-but-unconsumed tasks on startup so a restart never
   * re-advances a task the controller already finished before crashing.
   * The reconciliation advances the mission into the next approval gate and
   * enqueues the orchestrator decision dispatch so the workflow is genuinely
   * auto-completed.
   */
  reconcileCompletedTasks(): number {
    const allTasks = this.persistence.listAllTaskExecutions();
    let reconciled = 0;
    for (const task of allTasks) {
      if (task.result === null || task.consumedAt !== null) continue;
      const mission = this.persistence.getMission(task.missionId);
      if (!mission) continue;
      const nextState = nextStateAfterCompletion(mission.state);
      if (nextState === null) {
        this.persistence.runInTransaction(() => {
          this.persistence.consumeTask(task.taskId);
          this.persistence.recordMissionEvent(task.missionId, task.taskId, "task.consumed", { taskId: task.taskId, role: task.role });
        });
        reconciled += 1;
        continue;
      }
      const gate = gateFromNextState(nextState);
      this.persistence.runInTransaction(() => {
        this.persistence.consumeTask(task.taskId);
        this.persistence.saveMission(task.missionId, nextState, { ...(mission.payload ?? {}), failureReason: null });
        this.persistence.recordMissionEvent(task.missionId, task.taskId, "task.consumed", { taskId: task.taskId, role: task.role });
        this.persistence.recordMissionEvent(task.missionId, null, "mission.transition", { from: mission.state, to: nextState });
        if (gate !== null) {
          const decision = this.context.nextDecisionPrompt(task.missionId, gate, task.taskId);
          this.persistence.enqueueDispatch({
            missionId: task.missionId,
            dispatchKey: decision.dispatchKey,
            targetRole: "orchestrator",
            targetSessionId: decision.targetSessionId,
            capturedModel: decision.capturedModel,
            promptMessageId: decision.promptMessageId,
            purpose: "orchestrator_decision",
            parentPromptMessageId: task.controllerPromptMessageId,
            promptPayload: { kind: "orchestrator_decision", missionId: task.missionId, taskId: task.taskId, gate, result: task.result }
          });
          this.persistence.recordMissionEvent(task.missionId, task.taskId, "task.dispatched", { role: "orchestrator", purpose: "orchestrator_decision", dispatchKey: decision.dispatchKey, gate, promptMessageId: decision.promptMessageId });
        }
      });
      reconciled += 1;
    }
    return reconciled;
  }

  transitionMission(input: MissionTransitionInput): MissionTransitionResult {
    return this.persistence.runInTransaction(() => {
      const mission = this.persistence.getMission(input.missionId);
      if (!mission) throw new Error(`mission not found: ${input.missionId}`);
      const previousState = mission.state;
      if (input.expectedState !== undefined && input.expectedState !== previousState) {
        throw new Error(`stale mission transition: expected ${input.expectedState}, found ${previousState}`);
      }
      const currentVersion = this.persistence.getMissionStateVersion(input.missionId);
      if (input.expectedVersion !== undefined && input.expectedVersion !== currentVersion) {
        throw new Error(`stale mission transition: expected version ${input.expectedVersion}, found ${currentVersion}`);
      }
      const appliedAt = new Date().toISOString();
      const newVersion = this.persistence.casMission(input.missionId, currentVersion, input.nextState, { ...(mission.payload ?? {}), failureReason: input.failureReason ?? null });
      this.persistence.recordMissionEvent(input.missionId, null, "mission.transition", { from: previousState, to: input.nextState, reason: input.failureReason ?? null, stateVersion: newVersion });

      let consumedTaskId: string | null = null;
      let supersededApprovalCount = 0;

      if (isApprovalGate(previousState) && previousState !== input.nextState) {
        supersededApprovalCount = this.persistence.supersedeApprovalsBefore(input.missionId, gateFromState(previousState));
      }

      let pendingDispatchKey: string | null = null;
      let taskCreated: MissionTransitionResult["taskCreated"] = null;

      const nextRole = requiredRoleForMissionState(input.nextState);
      if (nextRole !== null && !isTerminalState(input.nextState)) {
        const attempt = correctionAttemptsFor(input.missionId, nextRole, this.persistence) + 1;
        let taskContext: MissionTaskContext;
        try {
          taskContext = buildTaskContextForRole(this.persistence, input.missionId, nextRole);
        } catch (error) {
          if (error instanceof MissionContextError) {
            this.persistence.setMissionFailure(input.missionId, error.message);
            this.persistence.recordMissionEvent(input.missionId, null, "mission.context_error", { role: nextRole, reason: error.message });
            throw error;
          }
          throw error;
        }
        let next: ReturnType<typeof this.context.nextTaskForRole>;
        try {
          next = this.context.nextTaskForRole(nextRole, input.missionId, attempt, taskContext);
        } catch (error) {
          if (error instanceof MissionContextError) {
            this.persistence.setMissionFailure(input.missionId, error.message);
            this.persistence.recordMissionEvent(input.missionId, null, "mission.context_error", { role: nextRole, reason: error.message });
            throw error;
          }
          throw error;
        }
        this.persistence.saveTaskExecution({ envelope: next.envelope, targetSessionId: next.targetSessionId, controllerPromptMessageId: next.promptMessageId, state: "dispatched" });
        this.persistence.recordTaskPromptAttempt(next.envelope.taskId, next.promptMessageId, "worker_task", attempt);
        this.persistence.enqueueDispatch({
          missionId: input.missionId,
          dispatchKey: next.dispatchKey,
          targetRole: nextRole,
          targetSessionId: next.targetSessionId,
          capturedModel: next.capturedModel,
          promptMessageId: next.promptMessageId,
          promptPayload: { ...next.promptPayload, envelope: next.envelope }
        });
        pendingDispatchKey = next.dispatchKey;
        taskCreated = { taskId: next.envelope.taskId, role: nextRole, envelope: next.envelope, targetSessionId: next.targetSessionId, capturedModel: next.capturedModel, promptMessageId: next.promptMessageId, dispatchKey: next.dispatchKey };
        this.persistence.recordMissionEvent(input.missionId, next.envelope.taskId, "task.dispatched", { role: nextRole, dispatchKey: next.dispatchKey, objective: next.envelope.objective, sourceWorkspaceFingerprint: next.envelope.sourceWorkspaceFingerprint });
      }

      if (isTerminalState(input.nextState) && previousState !== input.nextState) {
        this.persistence.recordMissionEvent(input.missionId, null, "mission.terminal", { state: input.nextState, reason: input.failureReason ?? null, stateVersion: newVersion });
      }

      void appliedAt;
      return {
        missionId: input.missionId,
        previousState,
        nextState: input.nextState,
        appliedAt: new Date().toISOString(),
        consumedTaskId,
        supersededApprovalCount,
        pendingDispatchKey,
        taskCreated,
        stateVersion: newVersion
      };
    });
  }

  applyOrchestratorAction(action: OrchestratorAction, sourceMessageId: string): { applied: boolean; superseded: boolean; missionBlocked: boolean } {
    const mission = this.persistence.getMission(action.missionId);
    if (!mission) return { applied: false, superseded: false, missionBlocked: false };
    const currentState = mission.state;
    const isCompletionAction = action.action === "request_completion";
    if (isCompletionAction && currentState !== "awaiting_final_approval") {
      this.persistence.recordMissionEvent(action.missionId, action.taskId ?? null, "orchestrator_action.rejected", { action: action.action, reason: "not at final approval gate", currentState });
      return { applied: false, superseded: false, missionBlocked: false };
    }
    if ((action.action === "approve" || action.action === "reject") && !isApprovalGate(currentState)) {
      this.persistence.recordMissionEvent(action.missionId, action.taskId ?? null, "orchestrator_action.rejected", { action: action.action, reason: "not at approval gate", currentState });
      return { applied: false, superseded: false, missionBlocked: false };
    }
    const taskIdForApproval: string | undefined = action.taskId && this.persistence.getTask(action.taskId) ? action.taskId : undefined;

    if (action.action === "approve") {
      const previousState = this.persistence.runInTransaction(() => {
        this.persistence.recordApproval({ approvalId: randomUUID(), missionId: action.missionId, taskId: taskIdForApproval, decision: "approved", reason: action.rationale });
        this.persistence.recordMissionEvent(action.missionId, taskIdForApproval ?? null, "approval.recorded", { decision: "approved", sourceMessageId });
        return this.persistence.getMission(action.missionId)?.state ?? currentState;
      });
      const nextState = nextStateForApproval(previousState);
      this.transitionMission({ missionId: action.missionId, nextState, expectedState: previousState });
      if (nextState === "awaiting_final_approval") {
        const finalGate = "final" as const;
        const decision = this.context.nextDecisionPrompt(action.missionId, finalGate, taskIdForApproval ?? `${action.missionId}-final`);
        this.persistence.enqueueDispatch({
          missionId: action.missionId,
          dispatchKey: decision.dispatchKey,
          targetRole: "orchestrator",
          targetSessionId: decision.targetSessionId,
          capturedModel: decision.capturedModel,
          promptMessageId: decision.promptMessageId,
          purpose: "orchestrator_decision",
          parentPromptMessageId: null,
          promptPayload: { kind: "orchestrator_decision", missionId: action.missionId, taskId: null, gate: finalGate }
        });
        this.persistence.recordMissionEvent(action.missionId, null, "task.dispatched", { role: "orchestrator", purpose: "orchestrator_decision", dispatchKey: decision.dispatchKey, gate: finalGate, promptMessageId: decision.promptMessageId });
      }
      return { applied: true, superseded: false, missionBlocked: false };
    }

    if (action.action === "reject") {
      const gate = gateFromState(currentState);
      const correctionRole: Exclude<Role, "orchestrator"> = gate === "plan" ? "planner" : "builder";
      const priorAttempts = correctionAttemptsFor(action.missionId, correctionRole, this.persistence);
      if (priorAttempts >= CORRECTION_ATTEMPT_CAP) {
        this.persistence.runInTransaction(() => {
          this.persistence.setMissionFailure(action.missionId, `exceeded correction cap on gate ${gate}`);
        });
        return { applied: false, superseded: false, missionBlocked: true };
      }
      this.persistence.runInTransaction(() => {
        this.persistence.recordApproval({ approvalId: randomUUID(), missionId: action.missionId, taskId: taskIdForApproval, decision: "rejected", reason: action.rationale });
        this.persistence.recordMissionEvent(action.missionId, taskIdForApproval ?? null, "approval.rejected", { decision: "rejected", sourceMessageId, gate });
      });
      let taskContext: MissionTaskContext;
      try {
        taskContext = buildTaskContextForRole(this.persistence, action.missionId, correctionRole, { rejectedTaskId: taskIdForApproval ?? null, correctionInstructions: action.correctionInstructions ?? [] });
      } catch (error) {
        if (error instanceof MissionContextError) {
          this.persistence.runInTransaction(() => {
            this.persistence.setMissionFailure(action.missionId, error.message);
            this.persistence.recordMissionEvent(action.missionId, null, "mission.context_error", { role: correctionRole, reason: error.message });
          });
          return { applied: false, superseded: false, missionBlocked: true };
        }
        throw error;
      }
      let next: ReturnType<typeof this.context.nextTaskForRole>;
      try {
        next = this.context.nextTaskForRole(correctionRole, action.missionId, priorAttempts + 1, taskContext);
      } catch (error) {
        if (error instanceof MissionContextError) {
          this.persistence.runInTransaction(() => {
            this.persistence.setMissionFailure(action.missionId, error.message);
            this.persistence.recordMissionEvent(action.missionId, null, "mission.context_error", { role: correctionRole, reason: error.message });
          });
          return { applied: false, superseded: false, missionBlocked: true };
        }
        throw error;
      }
      this.persistence.runInTransaction(() => {
        this.persistence.saveTaskExecution({ envelope: next.envelope, targetSessionId: next.targetSessionId, controllerPromptMessageId: next.promptMessageId, state: "dispatched" });
        this.persistence.recordTaskPromptAttempt(next.envelope.taskId, next.promptMessageId, "worker_task", priorAttempts + 1);
        this.persistence.enqueueDispatch({
          missionId: action.missionId,
          dispatchKey: next.dispatchKey,
          targetRole: correctionRole,
          targetSessionId: next.targetSessionId,
          capturedModel: next.capturedModel,
          promptMessageId: next.promptMessageId,
          promptPayload: { ...next.promptPayload, envelope: next.envelope }
        });
        this.persistence.recordMissionEvent(action.missionId, next.envelope.taskId, "task.correction", { role: correctionRole, dispatchKey: next.dispatchKey, attempt: priorAttempts + 1, objective: next.envelope.objective, sourceWorkspaceFingerprint: next.envelope.sourceWorkspaceFingerprint });
      });
      return { applied: true, superseded: false, missionBlocked: false };
    }

    if (action.action === "request_completion") {
      this.persistence.runInTransaction(() => {
        this.persistence.recordMissionEvent(action.missionId, null, "completion.requested", { sourceMessageId });
      });
      this.transitionMission({ missionId: action.missionId, nextState: "completed" });
      return { applied: true, superseded: false, missionBlocked: false };
    }

    return { applied: false, superseded: false, missionBlocked: false };
  }
}

export function dispatchPurposeForState(state: MissionState): DispatchPurpose {
  if (state === "completed") return "final_completion";
  if (state === "awaiting_final_approval") return "orchestrator_decision";
  if (state === "awaiting_plan_approval") return "orchestrator_decision";
  if (state === "awaiting_builder_approval") return "orchestrator_decision";
  if (state === "awaiting_review_approval") return "orchestrator_decision";
  if (state === "awaiting_test_approval") return "orchestrator_decision";
  return "worker_task";
}

function correctionAttemptsFor(missionId: string, role: Role, persistence: WorkflowPersistence): number {
  let attempts = 0;
  for (const task of persistence.listAllTaskExecutions()) {
    if (task.missionId === missionId && task.role === role) attempts += 1;
  }
  return attempts;
}

function gateFromState(state: MissionState): "plan" | "builder" | "review" | "test" | "final" {
  switch (state) {
    case "awaiting_plan_approval":
      return "plan";
    case "awaiting_builder_approval":
      return "builder";
    case "awaiting_review_approval":
      return "review";
    case "awaiting_test_approval":
      return "test";
    case "awaiting_final_approval":
      return "final";
    default:
      throw new Error(`state ${state} is not an approval gate`);
  }
}

function nextStateForApproval(state: MissionState): MissionState {
  switch (state) {
    case "awaiting_plan_approval":
      return "building";
    case "awaiting_builder_approval":
      return "reviewing";
    case "awaiting_review_approval":
      return "testing";
    case "awaiting_test_approval":
      return "awaiting_final_approval";
    case "awaiting_final_approval":
      return "completed";
    default:
      throw new Error(`unsupported approval state: ${state}`);
  }
}

function nextStateAfterCompletion(state: MissionState): MissionState | null {
  switch (state) {
    case "planning":
      return "awaiting_plan_approval";
    case "building":
      return "awaiting_builder_approval";
    case "reviewing":
      return "awaiting_review_approval";
    case "testing":
      return "awaiting_test_approval";
    default:
      return null;
  }
}

function gateFromNextState(state: MissionState): "plan" | "builder" | "review" | "test" | null {
  switch (state) {
    case "awaiting_plan_approval":
      return "plan";
    case "awaiting_builder_approval":
      return "builder";
    case "awaiting_review_approval":
      return "review";
    case "awaiting_test_approval":
      return "test";
    default:
      return null;
  }
}

export { ROLE_SEQUENCE, CORRECTION_ATTEMPT_CAP };
export type { RoleWorkerResult };

function buildTaskContextForRole(
  persistence: WorkflowPersistence,
  missionId: string,
  role: Exclude<Role, "orchestrator">,
  correction?: { rejectedTaskId: string | null; correctionInstructions: string[] }
): MissionTaskContext {
  const mission = persistence.getMission(missionId);
  const objective = (mission?.objective ?? "").trim();
  const sourceWorkspaceFingerprint = readSourceFingerprint(mission);
  const context: MissionTaskContext = { objective, sourceWorkspaceFingerprint };
  if (role === "builder" && correction) {
    const rejected = loadRejectedEvidence(persistence, missionId, correction.rejectedTaskId);
    context.correction = {
      rejectedRole: rejected.role,
      rejectedVerdict: rejected.verdict,
      rejectedFindings: rejected.findings,
      correctionInstructions: correction.correctionInstructions
    };
    if (rejected.workspaceFingerprint) {
      context.sourceWorkspaceFingerprint = rejected.workspaceFingerprint;
    }
    return context;
  }
  if (role === "builder") {
    const planner = loadPlannerEvidence(persistence, missionId);
    if (planner) context.plannerEvidence = planner;
  } else if (role === "reviewer") {
    const builder = loadBuilderEvidence(persistence, missionId);
    if (builder) {
      context.builderEvidence = builder;
      context.sourceWorkspaceFingerprint = builder.sourceWorkspaceFingerprint;
    }
  } else if (role === "tester") {
    const checks = loadControllerCheckEvidence(persistence, missionId, context.sourceWorkspaceFingerprint);
    if (checks) context.controllerChecks = checks;
  }
  return context;
}

function readSourceFingerprint(mission: ReturnType<WorkflowPersistence["getMission"]>): string {
  if (!mission) return "fingerprint";
  const payload = (mission.payload ?? {}) as { sourceWorkspaceFingerprint?: unknown; source_workspace_fingerprint?: unknown };
  const candidate = payload.sourceWorkspaceFingerprint ?? payload.source_workspace_fingerprint;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : "fingerprint";
}

function loadPlannerEvidence(persistence: WorkflowPersistence, missionId: string): PlannerEvidence | null {
  const tasks = persistence.listAllTaskExecutions().filter((task) => task.missionId === missionId && task.role === "planner" && task.result);
  const task = tasks.at(-1);
  if (!task || !task.result) return null;
  const result = task.result;
  if (!("planVerdict" in result) || !("implementationSteps" in result)) return null;
  const summary = result.summary ?? "";
  const sourceWorkspaceFingerprint = task.envelope.sourceWorkspaceFingerprint || readFingerprintFromResult(result);
  return {
    sourceTaskId: task.taskId,
    planVerdict: result.planVerdict,
    implementationSteps: [...result.implementationSteps],
    expectedFiles: [...(result.expectedFiles ?? [])],
    validationPlan: [...(result.validationPlan ?? [])],
    acceptanceCriteria: [...(task.envelope.acceptanceCriteria ?? [])],
    summary,
    sourceWorkspaceFingerprint,
    completedAt: result.completedAt
  };
}

function loadBuilderEvidence(persistence: WorkflowPersistence, missionId: string): BuilderEvidence | null {
  const tasks = persistence.listAllTaskExecutions().filter((task) => task.missionId === missionId && task.role === "builder" && task.result);
  const task = tasks.at(-1);
  if (!task || !task.result) return null;
  const result = task.result;
  if (!("implementationVerdict" in result) || !("changedFiles" in result)) return null;
  return {
    sourceTaskId: task.taskId,
    implementationVerdict: result.implementationVerdict,
    changedFiles: [...result.changedFiles],
    targetedTestsRun: [...(result.targetedTestsRun ?? [])],
    summary: result.summary ?? "",
    findings: [...(result.findings ?? [])].map(cloneFinding),
    sourceWorkspaceFingerprint: task.envelope.sourceWorkspaceFingerprint || readFingerprintFromResult(result),
    completedAt: result.completedAt
  };
}

function loadRejectedEvidence(
  persistence: WorkflowPersistence,
  missionId: string,
  rejectedTaskId: string | null
): { role: "reviewer" | "tester"; verdict: string; findings: BuilderCorrectionContext["rejectedFindings"]; workspaceFingerprint: string | null } {
  let target: ReturnType<typeof persistence.getTask> = null;
  if (rejectedTaskId) target = persistence.getTask(rejectedTaskId);
  if (!target) {
    const candidates = persistence.listAllTaskExecutions().filter((task) => task.missionId === missionId && (task.role === "reviewer" || task.role === "tester") && task.result);
    target = candidates.at(-1) ?? null;
  }
  if (!target || !target.result) {
    return { role: "reviewer", verdict: "unknown", findings: [], workspaceFingerprint: null };
  }
  const result = target.result;
  const findings = [...(result.findings ?? [])].map(cloneFinding);
  if (target.role === "reviewer" && "reviewVerdict" in result) {
    return {
      role: "reviewer",
      verdict: result.reviewVerdict,
      findings,
      workspaceFingerprint: result.reviewedWorkspaceFingerprint ?? null
    };
  }
  if (target.role === "tester" && "testVerdict" in result) {
    return {
      role: "tester",
      verdict: result.testVerdict,
      findings,
      workspaceFingerprint: result.testedWorkspaceFingerprint ?? null
    };
  }
  return { role: "reviewer", verdict: "unknown", findings, workspaceFingerprint: null };
}

function loadControllerCheckEvidence(persistence: WorkflowPersistence, missionId: string, testedWorkspaceFingerprint: string): ControllerCheckEvidence | null {
  const results = persistence.listCheckResults(missionId);
  if (results.length === 0) return null;
  const passedChecks = results.filter((result) => result.status === "passed").map((result) => result.checkName);
  const failedChecks = results.filter((result) => result.status === "failed" || result.status === "timed_out" || result.status === "spawn_error").map((result) => result.checkName);
  const requiredChecks = [...new Set([...passedChecks, ...failedChecks, ...results.map((result) => result.checkName)])];
  const configuration = persistence.getMissionConfiguration(missionId);
  return {
    configHash: configuration?.configHash ?? "unknown",
    testedWorkspaceFingerprint,
    requiredChecks,
    passedChecks,
    failedChecks,
    capturedAt: results.at(-1)?.capturedAt ?? new Date().toISOString()
  };
}

function cloneFinding(finding: RoleWorkerResult["findings"][number]): BuilderCorrectionContext["rejectedFindings"][number] {
  return {
    severity: finding.severity,
    title: finding.title,
    description: finding.description,
    file: finding.file,
    line: finding.line,
    blocking: finding.blocking
  };
}

function readFingerprintFromResult(result: RoleWorkerResult): string {
  return result.sourceWorkspaceFingerprint || "fingerprint";
}
