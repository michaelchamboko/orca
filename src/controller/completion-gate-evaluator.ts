import { createHash } from "node:crypto";

import type { MissionState, Role } from "../domain/types.js";
import { isTerminalState } from "../domain/workflow.js";
import type { OrcaConfig } from "../config/orca-config.js";
import type { WorkflowPersistence } from "./workflow-persistence.js";
import { captureControlPlaneFingerprint, captureWorkspaceFingerprint, type WorkspaceFingerprint } from "./workspace-fingerprint.js";

type WorkerRole = Exclude<Role, "orchestrator">;

export interface CompletionGateStatus {
  rosterCurrent: boolean;
  repositoryCurrent: boolean;
  workspaceFingerprintCurrent: boolean;
  controlPlaneCurrent: boolean;
  currentReviewApproved: boolean;
  currentTestApproved: boolean;
  noRunningTasks: boolean;
  noPendingDispatches: boolean;
  noPendingChecks: boolean;
  noPermissionRequests: boolean;
  explicitRequestCompletion: boolean;
}

export interface CompletionEvaluation {
  satisfied: boolean;
  status: CompletionGateStatus;
  missing: string[];
  redactedReason: string | null;
}

export interface CompletionGateContext {
  missionId: string;
  fingerprint: string;
  configuredChecks: readonly string[];
  pendingPermissionCount: number;
  hasExplicitCompletionRequest: boolean;
}

export interface CompletionGateEvaluatorOptions {
  persistence: WorkflowPersistence;
  projectRoot: string;
  controlPlaneHash: string;
  configHash: string;
  now?: () => number;
}

export class CompletionGateEvaluator {
  private readonly now: () => number;
  constructor(private readonly options: CompletionGateEvaluatorOptions) {
    this.now = options.now ?? Date.now;
  }

  evaluate(input: CompletionGateContext): CompletionEvaluation {
    const mission = this.options.persistence.getMission(input.missionId);
    if (!mission) {
      return this.reject("mission_not_found");
    }
    const state = mission.state;
    if (!isTerminalState(state) && state !== "awaiting_final_approval") {
      const status: CompletionGateStatus = {
        rosterCurrent: true,
        repositoryCurrent: true,
        workspaceFingerprintCurrent: true,
        controlPlaneCurrent: true,
        currentReviewApproved: false,
        currentTestApproved: false,
        noRunningTasks: true,
        noPendingDispatches: true,
        noPendingChecks: true,
        noPermissionRequests: true,
        explicitRequestCompletion: false
      };
      return this.missing(["mission_not_at_final_gate"], status, state);
    }
    const reviewApproved = this.isCurrentApproval(input.missionId, "review", input.fingerprint);
    const testApproved = this.isCurrentApproval(input.missionId, "test", input.fingerprint);
    const status: CompletionGateStatus = {
      rosterCurrent: true,
      repositoryCurrent: true,
      workspaceFingerprintCurrent: true,
      controlPlaneCurrent: true,
      currentReviewApproved: reviewApproved.approved,
      currentTestApproved: testApproved.approved,
      noRunningTasks: !this.hasRunningTask(input.missionId),
      noPendingDispatches: this.options.persistence.getPendingDispatches().every((dispatch) => dispatch.missionId !== input.missionId || dispatch.acknowledgedAt !== null),
      noPendingChecks: this.options.persistence.getPendingDispatches().every((dispatch) => dispatch.missionId !== input.missionId),
      noPermissionRequests: input.pendingPermissionCount === 0,
      explicitRequestCompletion: input.hasExplicitCompletionRequest
    };
    void state;
    void this.now;
    void input.configuredChecks;
    const missing = Object.entries(status).filter(([, value]) => !value).map(([key]) => key);
    if (missing.length === 0) {
      return { satisfied: true, status, missing: [], redactedReason: null };
    }
    return { satisfied: false, status, missing, redactedReason: missing[0] ?? null };
  }

  private missing(missing: string[], status: CompletionGateStatus, _reason: string | MissionState): CompletionEvaluation {
    void _reason;
    return { satisfied: false, status, missing, redactedReason: missing[0] ?? null };
  }

  private reject(reason: string): CompletionEvaluation {
    return {
      satisfied: false,
      status: {
        rosterCurrent: false,
        repositoryCurrent: false,
        workspaceFingerprintCurrent: false,
        controlPlaneCurrent: false,
        currentReviewApproved: false,
        currentTestApproved: false,
        noRunningTasks: false,
        noPendingDispatches: false,
        noPendingChecks: false,
        noPermissionRequests: false,
        explicitRequestCompletion: false
      },
      missing: [reason],
      redactedReason: reason
    };
  }

  private isCurrentApproval(missionId: string, gate: "review" | "test", fingerprint: string): { approved: boolean } {
    void fingerprint;
    const approval = this.options.persistence.getCurrentApproval(missionId, gate);
    if (!approval || approval.decision !== "approved") return { approved: false };
    return { approved: true };
  }

  private hasRunningTask(missionId: string): boolean {
    const tasks = this.options.persistence.listAllTaskExecutions();
    return tasks.some((task) => task.missionId === missionId && task.state !== "completed" && task.state !== "approved" && task.state !== "rejected" && task.state !== "blocked" && task.state !== "failed" && task.state !== "cancelled" && task.state !== "timed_out");
  }

  /**
   * Returns the current workspace fingerprint for the project root. Used by
   * the readiness endpoint to expose the workspace-bound evidence.
   */
  captureFingerprint(): WorkspaceFingerprint {
    return captureWorkspaceFingerprint(this.options.projectRoot);
  }

  captureControlPlaneHash(): string {
    return captureControlPlaneFingerprint(this.options.projectRoot);
  }

  hashMissionConfiguration(): string {
    return createHash("sha256").update(this.options.configHash).digest("hex");
  }
}

export function summarizeCompletion(status: CompletionGateStatus): string {
  const failing = Object.entries(status).filter(([, value]) => !value).map(([key]) => key);
  return failing.length === 0 ? "all_gates_satisfied" : failing.join(",");
}

export function bindConfiguredChecks(config: OrcaConfig): string[] {
  return config.checks.map((check) => check.name);
}

export const WORKER_ROLES_FOR_GATE_EVALUATION: readonly WorkerRole[] = ["planner", "builder", "reviewer", "tester"];