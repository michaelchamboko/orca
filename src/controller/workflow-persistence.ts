import type { RosterPersistence } from "../pairing/roster-service.js";
import type {
  CreateMissionTaskAndDispatchInput,
  DispatchOutboxAction,
  ProcessedMessageInput,
  TaskExecutionRecord,
  TaskPromptAttemptRecord,
  WorkspaceSnapshot
} from "../persistence/sqlite.js";
import type { Role, TaskState } from "../domain/types.js";

/** The controller's deliberately small durable-workflow contract. */
export interface WorkflowPersistence extends RosterPersistence {
  createMissionTaskAndDispatch(input: CreateMissionTaskAndDispatchInput): {
    task: TaskExecutionRecord;
    dispatch: DispatchOutboxAction;
  };
  saveTaskExecution(input: import("../persistence/sqlite.js").TaskExecutionInput): void;
  getTask(taskId: string): import("../persistence/sqlite.js").PersistedTask | null;
  saveMission(missionId: string, state: import("../domain/types.js").MissionState, payload: Record<string, unknown>, expectedVersion?: number): void;
  casMission(missionId: string, expectedVersion: number, state: import("../domain/types.js").MissionState, payload: Record<string, unknown>): number;
  getMissionStateVersion(missionId: string): number;
  recordApproval(input: import("../persistence/sqlite.js").ApprovalInput): import("../persistence/sqlite.js").ApprovalRecord;
  recordProcessedMessage(input: ProcessedMessageInput): boolean;
  claimNextDispatch(leaseOwner: string, leaseDurationMs: number, timestamp?: string): DispatchOutboxAction | null;
  acknowledgeDispatch(id: number, leaseOwner: string, timestamp?: string): void;
  acknowledgeTaskDispatch(id: number, leaseOwner: string, taskId: string, promptMessageId: string, timestamp?: string): void;
  releaseDispatch(id: number, leaseOwner: string, lastError?: string | null, timestamp?: string): void;
  getDispatchByPromptMessageId(promptMessageId: string): DispatchOutboxAction | null;
  enqueueDispatch(input: import("../persistence/sqlite.js").DispatchInput): DispatchOutboxAction;
  recordOrchestratorDecisionResponse(input: { missionId: string; decisionPromptMessageId: string; responseMessageId: string; responseHash: string; outcome: "accepted" | "rejected"; reasonCode: string | null; taskId: string | null; action: string | null }): { id: number };
  getOrchestratorDecisionResponses(missionId: string): Array<{ decisionPromptMessageId: string; responseMessageId: string; outcome: "accepted" | "rejected"; reasonCode: string | null }>;
  getPendingDispatches(limit?: number): DispatchOutboxAction[];
  getTaskExecutionByPromptMessageId(promptMessageId: string): TaskExecutionRecord | null;
  getTaskExecutionsForCompletion(): TaskExecutionRecord[];
  listAllTaskExecutions(): Array<TaskExecutionRecord & { consumedAt: string | null }>;
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
  recordGateAttempt(missionId: string, gate: string, role: Exclude<Role, "orchestrator">, attempt: number, workspaceFingerprint: string | null, timestamp?: string): void;
  getGateAttempts(missionId: string, gate: string): Array<{ attempt: number; role: Exclude<Role, "orchestrator">; workspaceFingerprint: string | null; createdAt: string }>;
  getGateAttemptCount(missionId: string, gate: string): number;
  getCurrentApproval(missionId: string, gate: string): import("../persistence/sqlite.js").ApprovalRecord | null;
  enqueueCheckIntent(input: { checkIntentId: string; missionId: string; checkName: string; executable: string; args: readonly string[]; timeoutMs: number; workingDirectory: string | null; env: Readonly<Record<string, string>>; configHash: string }): void;
  claimNextCheckIntent(leaseOwner: string, leaseDurationMs: number, timestamp?: string): { checkIntentId: string; missionId: string; checkName: string; executable: string; args: string[]; timeoutMs: number; workingDirectory: string | null; env: Record<string, string>; configHash: string } | null;
  completeCheckIntent(checkIntentId: string, status: "passed" | "failed" | "timed_out" | "spawn_error", exitCode: number | null, stdout: string, stderr: string, truncated: boolean, durationMs: number, timestamp?: string): void;
  listCheckResults(missionId: string): Array<{ checkName: string; status: "passed" | "failed" | "timed_out" | "spawn_error"; exitCode: number | null; stdout: string; stderr: string; truncated: boolean; durationMs: number; capturedAt: string }>;
  recordMissionConfiguration(missionId: string, configHash: string, timestamp?: string): void;
  getMissionConfiguration(missionId: string): { configHash: string; recordedAt: string } | null;
  recordPermissionRequest(input: { missionId: string; sessionId: string; toolName: string; details: Record<string, unknown>; timestamp?: string }): void;
  resolvePermissionRequest(input: { missionId: string; sessionId: string; toolName: string; state: "granted" | "denied" | "expired"; timestamp?: string }): void;
  getOpenPermissionRequests(missionId: string): Array<{ sessionId: string; toolName: string; capturedAt: string }>;
}
