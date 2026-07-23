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

const ROLE_SEQUENCE = ["planner", "builder", "reviewer", "tester"] as const;
const CORRECTION_ATTEMPT_CAP = 2;

export type CorrectionGate = "plan" | "builder" | "review" | "test";

export interface MissionTransitionInput {
  missionId: string;
  nextState: MissionState;
  failureReason?: string;
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
}

export interface MissionActionContext {
  getRoster(): Promise<PairedRoster>;
  bind(role: Role): { sessionId: string; agentName: string; model: ModelRef };
  nextTaskForRole(role: Role, attempt: number): { envelope: TaskEnvelope; targetSessionId: string; capturedModel: ModelRef; promptMessageId: string; dispatchKey: string };
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
          this.persistence.recordMissionEvent(task.missionId, task.taskId, "task.dispatched", { role: "orchestrator", dispatchKey: decision.dispatchKey });
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
      const appliedAt = new Date().toISOString();
      this.persistence.saveMission(input.missionId, input.nextState, { ...(mission.payload ?? {}), failureReason: input.failureReason ?? null });
      this.persistence.recordMissionEvent(input.missionId, null, "mission.transition", { from: previousState, to: input.nextState, reason: input.failureReason ?? null });

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
        const next = this.context.nextTaskForRole(nextRole, attempt);
        this.persistence.saveTaskExecution({ envelope: next.envelope, targetSessionId: next.targetSessionId, controllerPromptMessageId: next.promptMessageId, state: "dispatched" });
        this.persistence.recordTaskPromptAttempt(next.envelope.taskId, next.promptMessageId, "worker_task", attempt);
        this.persistence.enqueueDispatch({
          missionId: input.missionId,
          dispatchKey: next.dispatchKey,
          targetRole: nextRole,
          targetSessionId: next.targetSessionId,
          capturedModel: next.capturedModel,
          promptMessageId: next.promptMessageId
        });
        pendingDispatchKey = next.dispatchKey;
        taskCreated = { taskId: next.envelope.taskId, role: nextRole, envelope: next.envelope, targetSessionId: next.targetSessionId, capturedModel: next.capturedModel, promptMessageId: next.promptMessageId, dispatchKey: next.dispatchKey };
        this.persistence.recordMissionEvent(input.missionId, next.envelope.taskId, "task.dispatched", { role: nextRole, dispatchKey: next.dispatchKey });
      }

      if (isTerminalState(input.nextState) && previousState !== input.nextState) {
        this.persistence.runInTransaction(() => {
          this.persistence.recordMissionEvent(input.missionId, null, "mission.terminal", { state: input.nextState, reason: input.failureReason ?? null });
        });
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
        taskCreated
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
      this.persistence.runInTransaction(() => {
        this.persistence.recordApproval({ approvalId: randomUUID(), missionId: action.missionId, taskId: taskIdForApproval, decision: "approved", reason: action.rationale });
        this.persistence.recordMissionEvent(action.missionId, taskIdForApproval ?? null, "approval.recorded", { decision: "approved", sourceMessageId });
      });
      const nextState = nextStateForApproval(currentState);
      this.transitionMission({ missionId: action.missionId, nextState });
      return { applied: true, superseded: false, missionBlocked: false };
    }

    if (action.action === "reject") {
      const gate = gateFromState(currentState);
      const priorAttempts = correctionAttemptsFor(action.missionId, roleForGate(gate), this.persistence);
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
      const role = roleForGate(gate);
      const next = this.context.nextTaskForRole(role, priorAttempts + 1);
      this.persistence.runInTransaction(() => {
        this.persistence.saveTaskExecution({ envelope: next.envelope, targetSessionId: next.targetSessionId, controllerPromptMessageId: next.promptMessageId, state: "dispatched" });
        this.persistence.recordTaskPromptAttempt(next.envelope.taskId, next.promptMessageId, "worker_task", priorAttempts + 1);
        this.persistence.enqueueDispatch({
          missionId: action.missionId,
          dispatchKey: next.dispatchKey,
          targetRole: role,
          targetSessionId: next.targetSessionId,
          capturedModel: next.capturedModel,
          promptMessageId: next.promptMessageId
        });
        this.persistence.recordMissionEvent(action.missionId, next.envelope.taskId, "task.correction", { role, dispatchKey: next.dispatchKey, attempt: priorAttempts + 1 });
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
  for (const task of persistence.getTaskExecutionsForCompletion()) {
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

function roleForGate(gate: "plan" | "builder" | "review" | "test" | "final"): Exclude<Role, "orchestrator"> {
  switch (gate) {
    case "plan":
      return "planner";
    case "builder":
      return "builder";
    case "review":
      return "reviewer";
    case "test":
      return "tester";
    case "final":
      throw new Error("final gate has no worker role");
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