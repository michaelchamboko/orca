import type { RosterPersistence } from "../pairing/roster-service.js";
import type {
  CreateMissionTaskAndDispatchInput,
  DispatchOutboxAction,
  ProcessedMessageInput,
  TaskExecutionRecord,
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
  saveWorkspaceSnapshot(input: { snapshotId: string; missionId?: string; projectRoot: string; fingerprint: string; payload: Record<string, unknown> }): WorkspaceSnapshot;
  setTaskExecutionState(taskId: string, state: TaskState): void;
  setMissionFailure(missionId: string, reason: string): void;
}
