import type { RosterPersistence } from "../pairing/roster-service.js";
import type {
  CreateMissionTaskAndDispatchInput,
  DispatchOutboxAction,
  ProcessedMessageInput,
  TaskExecutionRecord,
  TaskPromptAttemptRecord,
  WorkspaceSnapshot
} from "../persistence/sqlite.js";
import type { TaskState } from "../domain/types.js";

/** The controller's deliberately small durable-workflow contract. */
export interface WorkflowPersistence extends RosterPersistence {
  createMissionTaskAndDispatch(input: CreateMissionTaskAndDispatchInput): {
    task: TaskExecutionRecord;
    dispatch: DispatchOutboxAction;
  };
  recordProcessedMessage(input: ProcessedMessageInput): boolean;
  claimNextDispatch(leaseOwner: string, leaseDurationMs: number, timestamp?: string): DispatchOutboxAction | null;
  acknowledgeDispatch(id: number, leaseOwner: string, timestamp?: string): void;
  releaseDispatch(id: number, leaseOwner: string, lastError?: string | null, timestamp?: string): void;
  getPendingDispatches(limit?: number): DispatchOutboxAction[];
  getTaskExecutionByPromptMessageId(promptMessageId: string): TaskExecutionRecord | null;
  getTaskExecutionsForCompletion(): TaskExecutionRecord[];
  saveTaskExecutionOutput(taskId: string, workerOutputMessageId: string): void;
  saveTaskResult(taskId: string, state: TaskState, result: import("../domain/types.js").RoleWorkerResult): void;
  blockTaskExecution(taskId: string, reason: string): void;
  recordControllerEvent(taskId: string, eventType: string, payload: Record<string, unknown>): void;
  saveWorkspaceSnapshot(input: { snapshotId: string; missionId?: string; projectRoot: string; fingerprint: string; payload: Record<string, unknown> }): WorkspaceSnapshot;
  setTaskExecutionState(taskId: string, state: TaskState): void;
  setMissionFailure(missionId: string, reason: string): void;
  getMission(missionId: string): import("../persistence/sqlite.js").MissionDataRecord | null;
  saveControllerCheckpoint(input: import("../persistence/sqlite.js").ControllerCheckpointInput): void;
  getControllerCheckpoint(cursorKey: string): import("../persistence/sqlite.js").ControllerCheckpoint | null;
  recordTaskPromptAttempt(taskId: string, promptMessageId: string, purpose: "worker_task" | "contract_repair", attempt: number, acknowledgedAt?: string | null): TaskPromptAttemptRecord;
  getTaskPromptAttempts(taskId: string): TaskPromptAttemptRecord[];
  acknowledgeTaskPromptAttempt(taskId: string, promptMessageId: string, timestamp?: string): void;
  completeTaskExecutionAtomically(taskId: string, outputMessageId: string, result: import("../domain/types.js").RoleWorkerResult, eventPayload: Record<string, unknown>): void;
  runInTransaction<T>(operation: () => T): T;
  hasActiveMission(): boolean;
  recordOrchestratorActionMessage(input: { missionId: string; messageId: string; sessionId: string; parentMessageId: string | null; decisionPromptMessageId: string | null; rawPayload: string; parsedPayload: Record<string, unknown>; action: string; taskId: string | null }): { id: number; createdAt: string };
  markOrchestratorActionMessageAccepted(messageId: string): void;
  markOrchestratorActionMessageRejected(messageId: string, reason: string): void;
  getOrchestratorActionMessage(messageId: string): { missionId: string; sessionId: string; parentMessageId: string | null; decisionPromptMessageId: string | null; action: string; taskId: string | null; parsedPayload: Record<string, unknown>; accepted: boolean; rejectReason: string | null; createdAt: string } | null;
  recordMissionEvent(missionId: string, taskId: string | null, eventType: string, payload: Record<string, unknown>): void;
  getMissionEvents(missionId: string): Array<{ taskId: string | null; eventType: string; payload: Record<string, unknown>; createdAt: string }>;
  consumeTask(taskId: string, timestamp?: string): void;
  supersedeApprovalsBefore(missionId: string, gate: string, timestamp?: string): number;
}
