import Database from "better-sqlite3";

import type {
  MissionState,
  ModelRef,
  PairedRoster,
  Role,
  RoleWorkerResult,
  TaskEnvelope,
  TaskState
} from "../domain/types.js";

type JsonLike = unknown;
type WorkerRole = Exclude<Role, "orchestrator">;
type DispatchState = "pending" | "claimed" | "acknowledged";

const terminalMissionStates: readonly MissionState[] = ["completed", "failed", "cancelled", "blocked"];
// Active means every domain state other than the terminal states above. This mirrors isTerminalState.
const activeMissionStatesSql = terminalMissionStates.map((state) => `'${state}'`).join(", ");

export interface MissionDataRecord {
  missionId: string;
  state: MissionState;
  payload: Record<string, JsonLike>;
  createdAt: string;
  updatedAt: string;
  rosterId: string | null;
  objective: string | null;
  sourceSessionMessageId: string | null;
  failureReason: string | null;
  metadataState: MissionState | null;
}

export interface CreateMissionInput {
  missionId: string;
  rosterId: string;
  objective: string;
  sourceSessionMessageId: string;
  state: MissionState;
  failureReason?: string;
  payload?: Record<string, JsonLike>;
}

export interface PersistedTask {
  missionId: string;
  taskId: string;
  role: WorkerRole;
  state: TaskState;
  envelope: TaskEnvelope;
  result: RoleWorkerResult | null;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface TaskExecutionInput {
  envelope: TaskEnvelope;
  targetSessionId: string;
  controllerPromptMessageId: string;
  workerOutputMessageId?: string;
  state?: TaskState;
  result?: RoleWorkerResult | null;
}

export interface TaskExecutionRecord extends PersistedTask {
  targetSessionId: string;
  controllerPromptMessageId: string;
  workerOutputMessageId: string | null;
  timeoutMs: number;
}

export interface OutboxEvent {
  id: number;
  aggregateId: string;
  aggregateType: string;
  eventType: string;
  payload: Record<string, JsonLike>;
  createdAt: string;
  publishedAt: string | null;
}

export type DispatchPurpose = "worker_task" | "contract_repair" | "orchestrator_decision" | "final_completion" | "status_notice";

export type DispatchContract =
  | "worker_result"
  | "orchestrator_action";

export interface DispatchPromptPayload {
  kind: DispatchPurpose | string;
  [key: string]: JsonLike;
}

export interface DispatchInput {
  missionId: string;
  dispatchKey: string;
  targetRole: Role;
  targetSessionId: string;
  capturedModel: ModelRef;
  promptMessageId: string;
  taskId?: string | null;
  purpose?: DispatchPurpose;
  parentPromptMessageId?: string | null;
  promptPayload?: Record<string, JsonLike>;
}

export interface DispatchOutboxAction extends DispatchInput {
  id: number;
  state: DispatchState;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  acknowledgedAt: string | null;
  lastError: string | null;
  taskId: string | null;
  purpose: DispatchPurpose;
  parentPromptMessageId: string | null;
  promptPayload: Record<string, JsonLike>;
  promptPayloadError: string | null;
}

export interface TaskPromptAttemptRecord {
  taskId: string;
  promptMessageId: string;
  purpose: "worker_task" | "contract_repair";
  attempt: number;
  acknowledgedAt: string | null;
  createdAt: string;
}

export interface EnqueueDispatchWithPromptInput extends DispatchInput {
  taskId: string;
  purpose: DispatchPurpose;
  parentPromptMessageId?: string;
  promptPayload?: Record<string, JsonLike>;
}

export interface CreateMissionTaskAndDispatchInput {
  mission: CreateMissionInput;
  task: Omit<TaskExecutionInput, "state" | "result"> & { state?: TaskState };
  dispatch: Omit<DispatchInput, "missionId">;
  snapshot?: WorkspaceSnapshotInput;
  /** A narrow test/operation hook; errors here prove the enclosing write transaction rolls back. */
  beforeCommit?: () => void;
}

export interface ProcessedMessageInput {
  messageHash: string;
  messageId: string;
  eventType: string;
  sessionId: string;
  payload: Record<string, JsonLike>;
}

export interface ControllerCheckpointInput {
  cursorKey: string;
  rosterId: string | null;
  cursor: string;
  payload: Record<string, JsonLike>;
}

export interface ControllerCheckpoint extends ControllerCheckpointInput {
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalInput {
  approvalId: string;
  missionId: string;
  taskId?: string;
  decision: "approved" | "rejected";
  reason?: string;
  gate?: string;
}

export interface ApprovalRecord extends Omit<ApprovalInput, "taskId" | "reason"> {
  taskId: string | null;
  reason: string | null;
  createdAt: string;
}

export interface WorkspaceSnapshotInput {
  snapshotId: string;
  missionId?: string;
  projectRoot: string;
  fingerprint: string;
  payload: Record<string, JsonLike>;
}

export interface WorkspaceSnapshot extends Omit<WorkspaceSnapshotInput, "missionId"> {
  missionId: string | null;
  createdAt: string;
}

export interface SqlitePersistenceConfig {
  path: string;
}

function toJsonString(payload: JsonLike): string {
  return JSON.stringify(payload);
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeTimestamp(timestamp: string): string {
  const start = Date.parse(timestamp);
  if (Number.isNaN(start)) throw new Error("timestamp must be a valid ISO-8601 instant");
  return new Date(start).toISOString();
}

function plusMilliseconds(timestamp: string, durationMs: number): string {
  const start = Date.parse(normalizeTimestamp(timestamp));
  if (durationMs <= 0) throw new Error("lease duration must be positive");
  return new Date(start + durationMs).toISOString();
}

export class SqlitePersistence {
  private readonly database: Database;

  constructor(config: SqlitePersistenceConfig) {
    this.database = new Database(config.path);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.runMigrations();
  }

  public close(): void {
    this.database.close();
  }

  public runInTransaction<T>(operation: () => T): T {
    let result: T | undefined;
    const transaction = this.database.transaction(() => {
      result = operation();
    });
    transaction();
    return result as T;
  }

  /** Creates metadata for a mission while the partial index permits only one active mission per roster. */
  public createMission(input: CreateMissionInput): MissionDataRecord {
    return this.runInTransaction(() => {
      const timestamp = nowIso();
      this.database.prepare(`
        INSERT INTO missions (mission_id, state, payload, state_version, created_at, updated_at)
        VALUES (@missionId, @state, @payload, 0, @timestamp, @timestamp)
        ON CONFLICT (mission_id) DO UPDATE SET
          state = excluded.state,
          payload = excluded.payload,
          updated_at = excluded.updated_at
      `).run({ missionId: input.missionId, state: input.state, payload: toJsonString(input.payload ?? { objective: input.objective }), timestamp });
      this.database.prepare(`
        INSERT INTO mission_metadata (
          mission_id, roster_id, objective, source_session_message_id, state, failure_reason, state_version
        ) VALUES (
          @missionId, @rosterId, @objective, @sourceSessionMessageId, @state, @failureReason, 0
        )
      `).run({ ...input, failureReason: input.failureReason ?? null });
      const mission = this.getMission(input.missionId);
      if (!mission) throw new Error(`mission not found after creation: ${input.missionId}`);
      return mission;
    });
  }

  public saveMission(missionId: string, state: MissionState, payload: Record<string, JsonLike>, expectedVersion?: number): void {
    this.runInTransaction(() => {
      const timestamp = nowIso();
      const existing = this.database.prepare(`
        SELECT state_version, roster_id FROM mission_metadata WHERE mission_id = @missionId
      `).get({ missionId }) as { state_version: number; roster_id: string | null } | undefined;
      const currentVersion = existing?.state_version ?? 0;
      if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
        throw new Error(`mission state version mismatch: expected ${expectedVersion}, found ${currentVersion}`);
      }
      const nextVersion = currentVersion + 1;
      this.database.prepare(`
        INSERT INTO missions (mission_id, state, payload, state_version, created_at, updated_at)
        VALUES (@missionId, @state, @payload, @stateVersion, @timestamp, @timestamp)
        ON CONFLICT (mission_id) DO UPDATE SET
          state = excluded.state,
          payload = excluded.payload,
          state_version = excluded.state_version,
          updated_at = excluded.updated_at
      `).run({ missionId, state, payload: toJsonString(payload), stateVersion: nextVersion, timestamp });
      if (existing) {
        this.database.prepare(`
          UPDATE mission_metadata SET state = @state, state_version = @stateVersion WHERE mission_id = @missionId
        `).run({ missionId, state, stateVersion: nextVersion });
      } else {
        const objective = typeof payload.objective === "string" ? payload.objective : "";
        const sourceSessionMessageId = typeof payload.source_session_message_id === "string"
          ? payload.source_session_message_id
          : "";
        this.database.prepare(`
          INSERT INTO mission_metadata (mission_id, roster_id, objective, source_session_message_id, state, failure_reason, state_version)
          VALUES (@missionId, NULL, @objective, @sourceSessionMessageId, @state, NULL, @stateVersion)
        `).run({ missionId, objective, sourceSessionMessageId, state, stateVersion: nextVersion });
      }
    });
  }

  /**
   * Atomic mission transition with compare-and-set on the state version.
   * Returns the new version, or throws if the expected version does not match.
   */
  public casMission(missionId: string, expectedVersion: number, state: MissionState, payload: Record<string, JsonLike>): number {
    return this.runInTransaction(() => {
      const existing = this.database.prepare(`
        SELECT state_version FROM mission_metadata WHERE mission_id = @missionId
      `).get({ missionId }) as { state_version: number } | undefined;
      const currentVersion = existing?.state_version ?? 0;
      if (expectedVersion !== currentVersion) {
        throw new Error(`mission state version mismatch: expected ${expectedVersion}, found ${currentVersion}`);
      }
      const timestamp = nowIso();
      const nextVersion = currentVersion + 1;
      this.database.prepare(`
        INSERT INTO missions (mission_id, state, payload, state_version, created_at, updated_at)
        VALUES (@missionId, @state, @payload, @stateVersion, @timestamp, @timestamp)
        ON CONFLICT (mission_id) DO UPDATE SET
          state = excluded.state,
          payload = excluded.payload,
          state_version = excluded.state_version,
          updated_at = excluded.updated_at
      `).run({ missionId, state, payload: toJsonString(payload), stateVersion: nextVersion, timestamp });
      if (existing) {
        this.database.prepare(`
          UPDATE mission_metadata SET state = @state, state_version = @stateVersion WHERE mission_id = @missionId
        `).run({ missionId, state, stateVersion: nextVersion });
      } else {
        const objective = typeof payload.objective === "string" ? payload.objective : "";
        const sourceSessionMessageId = typeof payload.source_session_message_id === "string"
          ? payload.source_session_message_id
          : "";
        this.database.prepare(`
          INSERT INTO mission_metadata (mission_id, roster_id, objective, source_session_message_id, state, failure_reason, state_version)
          VALUES (@missionId, NULL, @objective, @sourceSessionMessageId, @state, NULL, @stateVersion)
        `).run({ missionId, objective, sourceSessionMessageId, state, stateVersion: nextVersion });
      }
      return nextVersion;
    });
  }

  public getMissionStateVersion(missionId: string): number {
    const row = this.database.prepare(`SELECT state_version FROM mission_metadata WHERE mission_id = @missionId`).get({ missionId }) as { state_version: number | null } | undefined;
    return row?.state_version ?? 0;
  }

  public getMission(missionId: string): MissionDataRecord | null {
    const row = this.database.prepare(`
      SELECT m.mission_id, m.state, m.payload, m.created_at, m.updated_at,
        metadata.roster_id, metadata.objective, metadata.source_session_message_id, metadata.failure_reason,
        metadata.state AS metadata_state
      FROM missions m
      LEFT JOIN mission_metadata metadata ON metadata.mission_id = m.mission_id
      WHERE m.mission_id = @missionId
    `).get({ missionId }) as {
      mission_id: string; state: MissionState; payload: string; created_at: string; updated_at: string;
      roster_id: string | null; objective: string | null; source_session_message_id: string | null; failure_reason: string | null; metadata_state: MissionState | null;
    } | undefined;
    if (!row) return null;
    return {
      missionId: row.mission_id,
      state: row.state,
      payload: parseJson<Record<string, JsonLike>>(row.payload),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      rosterId: row.roster_id,
      objective: row.objective,
      sourceSessionMessageId: row.source_session_message_id,
      failureReason: row.failure_reason,
      metadataState: row.metadata_state
    };
  }

  public getMissionCount(): number {
    const row = this.database.prepare("SELECT COUNT(*) as count FROM missions").get() as { count: number } | undefined;
    return row?.count ?? 0;
  }

  public saveTaskEnvelope(task: TaskEnvelope): void {
    const timestamp = nowIso();
    this.database.prepare(`
      INSERT INTO tasks (task_id, mission_id, role, state, envelope, result, attempt, created_at, updated_at, completed_at)
      VALUES (@taskId, @missionId, @role, @state, @envelope, NULL, @attempt, @timestamp, @timestamp, NULL)
      ON CONFLICT (task_id) DO UPDATE SET
        mission_id = excluded.mission_id, role = excluded.role, state = excluded.state,
        envelope = excluded.envelope, result = excluded.result, attempt = excluded.attempt,
        updated_at = excluded.updated_at
    `).run({
      taskId: task.taskId, missionId: task.missionId, role: task.role, state: "queued" as const,
      envelope: toJsonString(task), attempt: task.attempt, timestamp
    });
  }

  public saveTaskExecution(input: TaskExecutionInput): void {
    this.saveTaskEnvelope(input.envelope);
    const timestamp = nowIso();
    const state = input.state ?? "queued";
    this.database.prepare(`
      INSERT INTO task_execution_metadata (
        task_id, target_session_id, controller_prompt_message_id, worker_output_message_id, timeout_ms, state, result, updated_at
      ) VALUES (
        @taskId, @targetSessionId, @controllerPromptMessageId, @workerOutputMessageId, @timeoutMs, @state, @result, @timestamp
      )
      ON CONFLICT (task_id) DO UPDATE SET
        target_session_id = excluded.target_session_id,
        controller_prompt_message_id = excluded.controller_prompt_message_id,
        worker_output_message_id = excluded.worker_output_message_id,
        timeout_ms = excluded.timeout_ms,
        state = excluded.state,
        result = excluded.result,
        updated_at = excluded.updated_at
    `).run({
      taskId: input.envelope.taskId,
      targetSessionId: input.targetSessionId,
      controllerPromptMessageId: input.controllerPromptMessageId,
      workerOutputMessageId: input.workerOutputMessageId ?? null,
      timeoutMs: input.envelope.timeoutMs,
      state,
      result: input.result ? toJsonString(input.result) : null,
      timestamp
    });
    this.database.prepare(`UPDATE tasks SET state = @state, updated_at = @timestamp WHERE task_id = @taskId`)
      .run({ taskId: input.envelope.taskId, state, timestamp });
    this.recordTaskPromptAttempt(input.envelope.taskId, input.controllerPromptMessageId, "worker_task", input.envelope.attempt);
  }

  public saveTaskResult(taskId: string, state: TaskState, result: RoleWorkerResult): void {
    const timestamp = nowIso();
    const completedAt = state === "completed" || state === "approved" || state === "rejected" ? timestamp : null;
    const info = this.database.prepare(`
      UPDATE tasks SET state = @state, result = @result, updated_at = @timestamp, completed_at = @completedAt
      WHERE task_id = @taskId
    `).run({ taskId, state, result: toJsonString(result), timestamp, completedAt });
    if (info.changes === 0) throw new Error(`task not found: ${taskId}`);
    this.database.prepare(`UPDATE task_execution_metadata SET state = @state, result = @result, updated_at = @timestamp WHERE task_id = @taskId`)
      .run({ taskId, state, result: toJsonString(result), timestamp });
  }

  public getTask(taskId: string): PersistedTask | null {
    const row = this.database.prepare(`
      SELECT mission_id, task_id, role, state, envelope, result, attempt, created_at, updated_at, completed_at
      FROM tasks WHERE task_id = @taskId
    `).get({ taskId }) as {
      mission_id: string; task_id: string; role: WorkerRole; state: TaskState; envelope: string; result: string | null;
      attempt: number; created_at: string; updated_at: string; completed_at: string | null;
    } | undefined;
    if (!row) return null;
    return {
      missionId: row.mission_id, taskId: row.task_id, role: row.role, state: row.state,
      envelope: parseJson<TaskEnvelope>(row.envelope), result: row.result ? parseJson<RoleWorkerResult>(row.result) : null,
      attempt: row.attempt, createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at
    };
  }

  public getTaskExecution(taskId: string): TaskExecutionRecord | null {
    const task = this.getTask(taskId);
    if (!task) return null;
    const row = this.database.prepare(`
      SELECT target_session_id, controller_prompt_message_id, worker_output_message_id, timeout_ms, state, result
      FROM task_execution_metadata WHERE task_id = @taskId
    `).get({ taskId }) as {
      target_session_id: string; controller_prompt_message_id: string; worker_output_message_id: string | null;
      timeout_ms: number; state: TaskState; result: string | null;
    } | undefined;
    if (!row) return null;
    return {
      ...task, state: row.state, result: row.result ? parseJson<RoleWorkerResult>(row.result) : task.result,
      targetSessionId: row.target_session_id, controllerPromptMessageId: row.controller_prompt_message_id,
      workerOutputMessageId: row.worker_output_message_id, timeoutMs: row.timeout_ms
    };
  }

  public getTaskExecutionByPromptMessageId(promptMessageId: string): TaskExecutionRecord | null {
    const row = this.database.prepare(`SELECT task_id FROM task_execution_metadata WHERE controller_prompt_message_id = @promptMessageId`).get({ promptMessageId }) as { task_id: string } | undefined;
    return row ? this.getTaskExecution(row.task_id) : null;
  }

  /** Only these states may be observed after a controller restart. */
  public getTaskExecutionsForCompletion(): TaskExecutionRecord[] {
    const rows = this.database.prepare(`
      SELECT task_id FROM task_execution_metadata
      WHERE state IN ('dispatched', 'running', 'result_contract_violation')
      ORDER BY updated_at ASC
    `).all() as Array<{ task_id: string }>;
    return rows.map((row) => this.getTaskExecution(row.task_id)).filter((task): task is TaskExecutionRecord => Boolean(task));
  }

  public listAllTaskExecutions(): Array<TaskExecutionRecord & { consumedAt: string | null }> {
    const rows = this.database.prepare(`
      SELECT task_id FROM task_execution_metadata ORDER BY updated_at ASC
    `).all() as Array<{ task_id: string }>;
    return rows.map((row) => this.getTaskExecution(row.task_id)).filter((task): task is (TaskExecutionRecord & { consumedAt: string | null }) => Boolean(task)).map((task) => {
      const consumedAtRow = this.database.prepare(`SELECT consumed_at FROM tasks WHERE task_id = @taskId`).get({ taskId: task.taskId }) as { consumed_at: string | null } | undefined;
      return { ...task, consumedAt: consumedAtRow?.consumed_at ?? null };
    });
  }

  public saveTaskExecutionOutput(taskId: string, workerOutputMessageId: string): void {
    const info = this.database.prepare(`UPDATE task_execution_metadata
      SET worker_output_message_id = @workerOutputMessageId, updated_at = @timestamp WHERE task_id = @taskId`)
      .run({ taskId, workerOutputMessageId, timestamp: nowIso() });
    if (info.changes !== 1) throw new Error(`task execution not found: ${taskId}`);
  }

  public recordTaskPromptAttempt(taskId: string, promptMessageId: string, purpose: "worker_task" | "contract_repair", attempt: number, acknowledgedAt: string | null = null): TaskPromptAttemptRecord {
    const createdAt = nowIso();
    this.database.prepare(`
      INSERT INTO task_prompt_attempts (task_id, prompt_message_id, purpose, attempt, acknowledged_at, created_at)
      VALUES (@taskId, @promptMessageId, @purpose, @attempt, @acknowledgedAt, @createdAt)
      ON CONFLICT (task_id, prompt_message_id) DO UPDATE SET
        purpose = excluded.purpose,
        attempt = excluded.attempt,
        acknowledged_at = COALESCE(task_prompt_attempts.acknowledged_at, excluded.acknowledged_at)
    `).run({ taskId, promptMessageId, purpose, attempt, acknowledgedAt, createdAt });
    return { taskId, promptMessageId, purpose, attempt, acknowledgedAt, createdAt };
  }

  public getTaskPromptAttempts(taskId: string): TaskPromptAttemptRecord[] {
    const rows = this.database.prepare(`
      SELECT task_id, prompt_message_id, purpose, attempt, acknowledged_at, created_at
      FROM task_prompt_attempts WHERE task_id = @taskId ORDER BY created_at ASC
    `).all({ taskId }) as Array<{ task_id: string; prompt_message_id: string; purpose: "worker_task" | "contract_repair"; attempt: number; acknowledged_at: string | null; created_at: string }>;
    return rows.map((row) => ({ taskId: row.task_id, promptMessageId: row.prompt_message_id, purpose: row.purpose, attempt: row.attempt, acknowledgedAt: row.acknowledged_at, createdAt: row.created_at }));
  }

  public acknowledgeTaskPromptAttempt(taskId: string, promptMessageId: string, timestamp: string = nowIso()): void {
    const result = this.database.prepare(`
      UPDATE task_prompt_attempts SET acknowledged_at = @timestamp WHERE task_id = @taskId AND prompt_message_id = @promptMessageId
    `).run({ taskId, promptMessageId, timestamp });
    if (result.changes !== 1) throw new Error(`task prompt attempt not found: ${taskId}:${promptMessageId}`);
  }

  /**
   * Atomic completion: persists the task output, the parsed result, the durable
   * controller event, and the prompt attempt acknowledgement in one transaction
   * so a crash anywhere rolls the whole record back.
   */
  public completeTaskExecutionAtomically(taskId: string, outputMessageId: string, result: RoleWorkerResult, eventPayload: Record<string, JsonLike>): void {
    this.runInTransaction(() => {
      const timestamp = nowIso();
      const info = this.database.prepare(`
        UPDATE tasks SET state = 'completed', result = @result, updated_at = @timestamp, completed_at = @timestamp WHERE task_id = @taskId
      `).run({ taskId, result: toJsonString(result), timestamp });
      if (info.changes === 0) throw new Error(`task not found: ${taskId}`);
      this.database.prepare(`
        UPDATE task_execution_metadata
        SET worker_output_message_id = @outputMessageId, state = 'completed', result = @result, updated_at = @timestamp
        WHERE task_id = @taskId
      `).run({ taskId, outputMessageId, result: toJsonString(result), timestamp });
      this.database.prepare(`
        INSERT INTO controller_event_ledger (task_id, event_type, payload, created_at) VALUES (@taskId, 'worker.completed', @payload, @timestamp)
      `).run({ taskId, payload: toJsonString(eventPayload), timestamp });
      this.database.prepare(`
        UPDATE task_prompt_attempts SET acknowledged_at = @timestamp
        WHERE task_id = @taskId AND acknowledged_at IS NULL
      `).run({ taskId, timestamp });
    });
  }

  public recordOrchestratorActionMessage(input: { missionId: string; messageId: string; sessionId: string; parentMessageId: string | null; decisionPromptMessageId: string | null; rawPayload: string; parsedPayload: Record<string, JsonLike>; action: string; taskId: string | null }): { id: number; createdAt: string } {
    const createdAt = nowIso();
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO orchestrator_action_messages (mission_id, message_id, session_id, parent_message_id, decision_prompt_message_id, action, task_id, payload, parsed_payload, created_at)
      VALUES (@missionId, @messageId, @sessionId, @parentMessageId, @decisionPromptMessageId, @action, @taskId, @payload, @parsedPayload, @createdAt)
    `).run({ ...input, payload: input.rawPayload, parsedPayload: toJsonString(input.parsedPayload), createdAt });
    return { id: result.changes === 1 ? Number(result.lastInsertRowid) : 0, createdAt };
  }

  public markOrchestratorActionMessageAccepted(messageId: string): void {
    const result = this.database.prepare(`UPDATE orchestrator_action_messages SET accepted = 1 WHERE message_id = @messageId`).run({ messageId });
    if (result.changes === 0) throw new Error(`orchestrator action message not found: ${messageId}`);
  }

  public markOrchestratorActionMessageRejected(messageId: string, reason: string): void {
    const result = this.database.prepare(`UPDATE orchestrator_action_messages SET accepted = 0, reject_reason = @reason WHERE message_id = @messageId`).run({ messageId, reason });
    if (result.changes === 0) throw new Error(`orchestrator action message not found: ${messageId}`);
  }

  public getOrchestratorActionMessage(messageId: string): { missionId: string; sessionId: string; parentMessageId: string | null; decisionPromptMessageId: string | null; action: string; taskId: string | null; parsedPayload: Record<string, JsonLike>; accepted: boolean; rejectReason: string | null; createdAt: string } | null {
    const row = this.database.prepare(`SELECT mission_id, session_id, parent_message_id, decision_prompt_message_id, action, task_id, parsed_payload, accepted, reject_reason, created_at FROM orchestrator_action_messages WHERE message_id = @messageId`).get({ messageId }) as { mission_id: string; session_id: string; parent_message_id: string | null; decision_prompt_message_id: string | null; action: string; task_id: string | null; parsed_payload: string; accepted: number; reject_reason: string | null; created_at: string } | undefined;
    if (!row) return null;
    return {
      missionId: row.mission_id,
      sessionId: row.session_id,
      parentMessageId: row.parent_message_id,
      decisionPromptMessageId: row.decision_prompt_message_id,
      action: row.action,
      taskId: row.task_id,
      parsedPayload: parseJson<Record<string, JsonLike>>(row.parsed_payload),
      accepted: row.accepted === 1,
      rejectReason: row.reject_reason,
      createdAt: row.created_at
    };
  }

  public recordMissionEvent(missionId: string, taskId: string | null, eventType: string, payload: Record<string, JsonLike>): void {
    this.database.prepare(`INSERT INTO mission_event_ledger (mission_id, task_id, event_type, payload, created_at) VALUES (@missionId, @taskId, @eventType, @payload, @createdAt)`).run({ missionId, taskId, eventType, payload: toJsonString(payload), createdAt: nowIso() });
  }

  public getMissionEvents(missionId: string): Array<{ taskId: string | null; eventType: string; payload: Record<string, JsonLike>; createdAt: string }> {
    const rows = this.database.prepare(`SELECT task_id, event_type, payload, created_at FROM mission_event_ledger WHERE mission_id = @missionId ORDER BY id ASC`).all({ missionId }) as Array<{ task_id: string | null; event_type: string; payload: string; created_at: string }>;
    return rows.map((row) => ({ taskId: row.task_id, eventType: row.event_type, payload: parseJson<Record<string, JsonLike>>(row.payload), createdAt: row.created_at }));
  }

  public consumeTask(taskId: string, timestamp: string = nowIso()): void {
    const result = this.database.prepare(`UPDATE tasks SET consumed_at = @timestamp WHERE task_id = @taskId AND consumed_at IS NULL`).run({ taskId, timestamp });
    if (result.changes === 0) throw new Error(`task not consumed: ${taskId}`);
  }

  public supersedeApprovalsBefore(missionId: string, gate: string, timestamp: string = nowIso(), preserveApprovalId?: string): number {
    const result = this.database.prepare(`UPDATE orchestrator_approvals SET superseded_at = @timestamp WHERE mission_id = @missionId AND gate = @gate AND superseded_at IS NULL AND (@preserveApprovalId IS NULL OR approval_id != @preserveApprovalId)`).run({ missionId, gate, timestamp, preserveApprovalId: preserveApprovalId ?? null });
    return result.changes;
  }

  public recordGateAttempt(missionId: string, gate: string, role: WorkerRole, attempt: number, workspaceFingerprint: string | null, timestamp: string = nowIso()): void {
    this.database.prepare(`
      INSERT INTO gate_attempts (mission_id, gate, role, attempt, workspace_fingerprint, created_at)
      VALUES (@missionId, @gate, @role, @attempt, @workspaceFingerprint, @timestamp)
      ON CONFLICT (mission_id, gate, attempt) DO UPDATE SET
        workspace_fingerprint = excluded.workspace_fingerprint
    `).run({ missionId, gate, role, attempt, workspaceFingerprint, timestamp });
  }

  public getGateAttempts(missionId: string, gate: string): Array<{ attempt: number; role: WorkerRole; workspaceFingerprint: string | null; createdAt: string }> {
    const rows = this.database.prepare(`
      SELECT attempt, role, workspace_fingerprint, created_at FROM gate_attempts WHERE mission_id = @missionId AND gate = @gate ORDER BY attempt ASC
    `).all({ missionId, gate }) as Array<{ attempt: number; role: WorkerRole; workspace_fingerprint: string | null; created_at: string }>;
    return rows.map((row) => ({ attempt: row.attempt, role: row.role, workspaceFingerprint: row.workspace_fingerprint, createdAt: row.created_at }));
  }

  public getGateAttemptCount(missionId: string, gate: string): number {
    const row = this.database.prepare(`
      SELECT COUNT(*) as count FROM gate_attempts WHERE mission_id = @missionId AND gate = @gate
    `).get({ missionId, gate }) as { count: number };
    return row.count;
  }

  public getCurrentApproval(missionId: string, gate: string): ApprovalRecord | null {
    const row = this.database.prepare(`
      SELECT approval_id, mission_id, task_id, decision, reason, gate, created_at FROM orchestrator_approvals WHERE mission_id = @missionId AND gate = @gate AND superseded_at IS NULL ORDER BY created_at DESC LIMIT 1
    `).get({ missionId, gate }) as { approval_id: string; mission_id: string; task_id: string | null; decision: "approved" | "rejected"; reason: string | null; gate: string | null; created_at: string } | undefined;
    if (!row) return null;
    return { approvalId: row.approval_id, missionId: row.mission_id, taskId: row.task_id, decision: row.decision, reason: row.reason, gate: row.gate ?? undefined, createdAt: row.created_at };
  }

  public enqueueCheckIntent(input: {
    checkIntentId: string;
    missionId: string;
    checkName: string;
    executable: string;
    args: readonly string[];
    timeoutMs: number;
    workingDirectory: string | null;
    env: Readonly<Record<string, string>>;
    configHash: string;
  }): void {
    const timestamp = nowIso();
    this.database.prepare(`
      INSERT INTO controlled_check_intents (
        check_intent_id, mission_id, check_name, executable, args_json, timeout_ms, working_directory, env_json, config_hash,
        lease_owner, lease_expires_at, attempt, state, created_at, updated_at
      ) VALUES (
        @checkIntentId, @missionId, @checkName, @executable, @argsJson, @timeoutMs, @workingDirectory, @envJson, @configHash,
        NULL, NULL, 0, 'pending', @timestamp, @timestamp
      )
      ON CONFLICT (check_intent_id) DO NOTHING
    `).run({
      checkIntentId: input.checkIntentId,
      missionId: input.missionId,
      checkName: input.checkName,
      executable: input.executable,
      argsJson: toJsonString(input.args),
      timeoutMs: input.timeoutMs,
      workingDirectory: input.workingDirectory,
      envJson: toJsonString(input.env),
      configHash: input.configHash,
      timestamp
    });
  }

  public claimNextCheckIntent(leaseOwner: string, leaseDurationMs: number, timestamp = nowIso()): {
    checkIntentId: string;
    missionId: string;
    checkName: string;
    executable: string;
    args: string[];
    timeoutMs: number;
    workingDirectory: string | null;
    env: Record<string, string>;
    configHash: string;
  } | null {
    const claimTimestamp = normalizeTimestamp(timestamp);
    const candidate = this.database.prepare(`
      SELECT check_intent_id FROM controlled_check_intents
      WHERE state IN ('pending', 'running') AND (lease_expires_at IS NULL OR julianday(lease_expires_at) <= julianday(@timestamp))
      ORDER BY created_at ASC LIMIT 1
    `).get({ timestamp: claimTimestamp }) as { check_intent_id: string } | undefined;
    if (!candidate) return null;
    const leaseExpiresAt = plusMilliseconds(claimTimestamp, leaseDurationMs);
    const claim = this.database.prepare(`
      UPDATE controlled_check_intents
      SET state = 'running', lease_owner = @leaseOwner, lease_expires_at = @leaseExpiresAt, attempt = attempt + 1, updated_at = @timestamp
      WHERE check_intent_id = @checkIntentId
    `).run({ checkIntentId: candidate.check_intent_id, leaseOwner, leaseExpiresAt, timestamp: claimTimestamp });
    if (claim.changes === 0) return null;
    const row = this.database.prepare(`
      SELECT check_intent_id, mission_id, check_name, executable, args_json, timeout_ms, working_directory, env_json, config_hash FROM controlled_check_intents WHERE check_intent_id = @checkIntentId
    `).get({ checkIntentId: candidate.check_intent_id }) as { check_intent_id: string; mission_id: string; check_name: string; executable: string; args_json: string; timeout_ms: number; working_directory: string | null; env_json: string; config_hash: string };
    return {
      checkIntentId: row.check_intent_id,
      missionId: row.mission_id,
      checkName: row.check_name,
      executable: row.executable,
      args: parseJson<string[]>(row.args_json),
      timeoutMs: row.timeout_ms,
      workingDirectory: row.working_directory,
      env: parseJson<Record<string, string>>(row.env_json),
      configHash: row.config_hash
    };
  }

  public completeCheckIntent(checkIntentId: string, status: "passed" | "failed" | "timed_out" | "spawn_error", exitCode: number | null, stdout: string, stderr: string, truncated: boolean, durationMs: number, timestamp = nowIso()): void {
    this.runInTransaction(() => {
      this.database.prepare(`
        UPDATE controlled_check_intents
        SET state = @status, lease_owner = NULL, lease_expires_at = NULL, updated_at = @timestamp
        WHERE check_intent_id = @checkIntentId
      `).run({ checkIntentId, status, timestamp });
      const resultTs = nowIso();
      this.database.prepare(`
        INSERT OR REPLACE INTO controlled_check_results (check_intent_id, mission_id, exit_code, status, stdout, stderr, truncated, duration_ms, captured_at)
        VALUES (@checkIntentId, (SELECT mission_id FROM controlled_check_intents WHERE check_intent_id = @checkIntentId), @exitCode, @status, @stdout, @stderr, @truncated, @durationMs, @resultTs)
      `).run({ checkIntentId, exitCode, status, stdout, stderr, truncated: truncated ? 1 : 0, durationMs, resultTs });
    });
  }

  public listCheckResults(missionId: string): Array<{ checkName: string; status: "passed" | "failed" | "timed_out" | "spawn_error"; exitCode: number | null; stdout: string; stderr: string; truncated: boolean; durationMs: number; capturedAt: string }> {
    const rows = this.database.prepare(`
      SELECT ci.check_name, cr.status, cr.exit_code, cr.stdout, cr.stderr, cr.truncated, cr.duration_ms, cr.captured_at
      FROM controlled_check_results cr
      JOIN controlled_check_intents ci ON ci.check_intent_id = cr.check_intent_id
      WHERE cr.mission_id = @missionId
      ORDER BY cr.captured_at ASC
    `).all({ missionId }) as Array<{ check_name: string; status: "passed" | "failed" | "timed_out" | "spawn_error"; exit_code: number | null; stdout: string; stderr: string; truncated: number; duration_ms: number; captured_at: string }>;
    return rows.map((row) => ({
      checkName: row.check_name,
      status: row.status,
      exitCode: row.exit_code,
      stdout: row.stdout,
      stderr: row.stderr,
      truncated: row.truncated === 1,
      durationMs: row.duration_ms,
      capturedAt: row.captured_at
    }));
  }

  public recordMissionConfiguration(missionId: string, configHash: string, timestamp = nowIso()): void {
    this.database.prepare(`
      INSERT INTO mission_configurations (mission_id, config_hash, recorded_at) VALUES (@missionId, @configHash, @timestamp)
      ON CONFLICT (mission_id) DO UPDATE SET config_hash = excluded.config_hash, recorded_at = excluded.recorded_at
    `).run({ missionId, configHash, timestamp });
  }

  public getMissionConfiguration(missionId: string): { configHash: string; recordedAt: string } | null {
    const row = this.database.prepare(`SELECT config_hash, recorded_at FROM mission_configurations WHERE mission_id = @missionId`).get({ missionId }) as { config_hash: string; recorded_at: string } | undefined;
    if (!row) return null;
    return { configHash: row.config_hash, recordedAt: row.recorded_at };
  }

  public recordPermissionRequest(input: { missionId: string; sessionId: string; toolName: string; details: Record<string, JsonLike>; timestamp?: string }): void {
    const ts = input.timestamp ?? nowIso();
    this.database.prepare(`
      INSERT INTO permission_requests (mission_id, session_id, tool_name, details_json, state, captured_at)
      VALUES (@missionId, @sessionId, @toolName, @detailsJson, 'open', @capturedAt)
    `).run({ missionId: input.missionId, sessionId: input.sessionId, toolName: input.toolName, detailsJson: toJsonString(input.details), capturedAt: ts });
  }

  public resolvePermissionRequest(input: { missionId: string; sessionId: string; toolName: string; state: "granted" | "denied" | "expired"; timestamp?: string }): void {
    const ts = input.timestamp ?? nowIso();
    this.database.prepare(`
      UPDATE permission_requests SET state = @state, resolved_at = @timestamp WHERE mission_id = @missionId AND session_id = @sessionId AND tool_name = @toolName AND state = 'open'
    `).run({ missionId: input.missionId, sessionId: input.sessionId, toolName: input.toolName, state: input.state, timestamp: ts });
  }

  public getOpenPermissionRequests(missionId: string): Array<{ sessionId: string; toolName: string; capturedAt: string }> {
    const rows = this.database.prepare(`
      SELECT session_id, tool_name, captured_at FROM permission_requests WHERE mission_id = @missionId AND state = 'open' ORDER BY captured_at ASC
    `).all({ missionId }) as Array<{ session_id: string; tool_name: string; captured_at: string }>;
    return rows.map((row) => ({ sessionId: row.session_id, toolName: row.tool_name, capturedAt: row.captured_at }));
  }

  public blockTaskExecution(taskId: string, reason: string): void {
    this.runInTransaction(() => {
      const task = this.getTaskExecution(taskId);
      if (!task) throw new Error(`task execution not found: ${taskId}`);
      const timestamp = nowIso();
      this.database.prepare(`UPDATE tasks SET state = 'blocked', updated_at = @timestamp WHERE task_id = @taskId`).run({ taskId, timestamp });
      this.database.prepare(`UPDATE task_execution_metadata SET state = 'blocked', updated_at = @timestamp WHERE task_id = @taskId`).run({ taskId, timestamp });
      this.setMissionFailure(task.missionId, reason);
    });
  }

  public recordControllerEvent(taskId: string, eventType: string, payload: Record<string, JsonLike>): void {
    this.runInTransaction(() => {
      this.database.prepare(`INSERT INTO controller_event_ledger (task_id, event_type, payload, created_at)
        VALUES (@taskId, @eventType, @payload, @createdAt)`).run({ taskId, eventType, payload: toJsonString(payload), createdAt: nowIso() });
      this.database.prepare(`DELETE FROM controller_event_ledger WHERE id IN (
        SELECT id FROM controller_event_ledger WHERE task_id = @taskId ORDER BY id DESC LIMIT -1 OFFSET 100
      )`).run({ taskId });
    });
  }

  public setTaskExecutionState(taskId: string, state: TaskState): void {
    const timestamp = nowIso();
    const task = this.database.prepare(`UPDATE tasks SET state = @state, updated_at = @timestamp WHERE task_id = @taskId`).run({ taskId, state, timestamp });
    const execution = this.database.prepare(`UPDATE task_execution_metadata SET state = @state, updated_at = @timestamp WHERE task_id = @taskId`).run({ taskId, state, timestamp });
    if (task.changes !== 1 || execution.changes !== 1) throw new Error(`task execution not found: ${taskId}`);
  }

  public setMissionFailure(missionId: string, reason: string): void {
    this.runInTransaction(() => {
      const mission = this.getMission(missionId);
      if (!mission) throw new Error(`mission not found: ${missionId}`);
      this.saveMission(missionId, "blocked", { ...mission.payload, failureReason: reason });
      this.database.prepare(`UPDATE mission_metadata SET failure_reason = @reason WHERE mission_id = @missionId`).run({ missionId, reason });
    });
  }

  public getTaskCount(): number {
    const row = this.database.prepare("SELECT COUNT(*) as count FROM tasks").get() as { count: number } | undefined;
    return row?.count ?? 0;
  }

  public createMissionTaskAndDispatch(input: CreateMissionTaskAndDispatchInput): {
    mission: MissionDataRecord; task: TaskExecutionRecord; dispatch: DispatchOutboxAction;
  } {
    return this.runInTransaction(() => {
      const mission = this.createMission(input.mission);
      const taskInput: TaskExecutionInput = { ...input.task, state: input.task.state ?? "dispatched" };
      this.saveTaskExecution(taskInput);
      if (input.snapshot) this.saveWorkspaceSnapshot(input.snapshot);
      const dispatch = this.enqueueDispatch({ ...input.dispatch, missionId: input.mission.missionId });
      input.beforeCommit?.();
      const task = this.getTaskExecution(input.task.envelope.taskId);
      if (!task) throw new Error(`task execution not found: ${input.task.envelope.taskId}`);
      return { mission, task, dispatch };
    });
  }

  public saveRoster(roster: PairedRoster): void {
    this.runInTransaction(() => {
      this.assertNoActiveMissionForRosterHistory();
      this.database.prepare(`UPDATE rosters SET is_current = 0 WHERE is_current = 1`).run();
      this.database.prepare(`INSERT INTO rosters (roster_id, fingerprint, server_base_url, project_root, paired_at, is_current) VALUES (@rosterId, @fingerprint, @serverBaseUrl, @projectRoot, @pairedAt, 1)`).run({ rosterId: roster.rosterId, fingerprint: roster.fingerprint, serverBaseUrl: roster.serverBaseUrl, projectRoot: roster.projectRoot, pairedAt: roster.pairedAt });
      const statement = this.database.prepare(`INSERT INTO session_bindings (roster_id, position, role, session_id, model_provider_id, model_id, agent_name, project_root, project_fingerprint, server_base_url, session_created_at, paired_at, role_prompt_hash, expected_title) VALUES (@rosterId, @position, @role, @sessionId, @modelProviderId, @modelId, @agentName, @projectRoot, @projectFingerprint, @serverBaseUrl, @sessionCreatedAt, @pairedAt, @rolePromptHash, @expectedTitle)`);
      for (const binding of roster.bindings) statement.run({ rosterId: roster.rosterId, position: binding.position, role: binding.role, sessionId: binding.sessionId, modelProviderId: binding.model.providerId, modelId: binding.model.modelId, agentName: binding.agentName, projectRoot: binding.projectRoot, projectFingerprint: binding.projectFingerprint, serverBaseUrl: binding.serverBaseUrl, sessionCreatedAt: binding.sessionCreatedAt, pairedAt: binding.pairedAt, rolePromptHash: binding.rolePromptHash, expectedTitle: binding.expectedTitle });
    });
  }

  private assertNoActiveMissionForRosterHistory(): void {
    const active = this.database.prepare(`
      SELECT COUNT(*) as count FROM mission_metadata
      WHERE roster_id IS NOT NULL AND state NOT IN (${activeMissionStatesSql})
    `).get() as { count: number };
    if (active.count > 0) throw new Error("cannot re-pair while a mission is active");
  }

  public hasActiveMission(): boolean {
    const row = this.database.prepare(`
      SELECT COUNT(*) as count FROM mission_metadata
      WHERE state NOT IN (${activeMissionStatesSql})
    `).get() as { count: number };
    return row.count > 0;
  }

  public listHistoricalRosters(): Array<{ rosterId: string; fingerprint: string; pairedAt: string; isCurrent: boolean }> {
    const rows = this.database.prepare(`
      SELECT roster_id, fingerprint, paired_at, is_current FROM rosters ORDER BY paired_at DESC
    `).all() as Array<{ roster_id: string; fingerprint: string; paired_at: string; is_current: number }>;
    return rows.map((row) => ({ rosterId: row.roster_id, fingerprint: row.fingerprint, pairedAt: row.paired_at, isCurrent: row.is_current === 1 }));
  }

  public getCurrentRoster(): PairedRoster | null {
    const roster = this.database.prepare(`SELECT roster_id, fingerprint, server_base_url, project_root, paired_at FROM rosters WHERE is_current = 1 ORDER BY paired_at DESC LIMIT 1`).get() as { roster_id: string; fingerprint: string; server_base_url: string; project_root: string; paired_at: string } | undefined;
    if (!roster) return null;
    const bindings = this.database.prepare(`SELECT position, role, session_id, model_provider_id, model_id, agent_name, project_root, project_fingerprint, server_base_url, session_created_at, paired_at, role_prompt_hash, expected_title FROM session_bindings WHERE roster_id = @rosterId ORDER BY position ASC`).all({ rosterId: roster.roster_id }) as Array<{ position: 1 | 2 | 3 | 4 | 5; role: Role; session_id: string; model_provider_id: string; model_id: string; agent_name: string; project_root: string; project_fingerprint: string; server_base_url: string; session_created_at: string; paired_at: string; role_prompt_hash: string; expected_title: string }>;
    return { rosterId: roster.roster_id, fingerprint: roster.fingerprint, serverBaseUrl: roster.server_base_url, projectRoot: roster.project_root, pairedAt: roster.paired_at, bindings: bindings.map((binding) => ({ sessionId: binding.session_id, position: binding.position, role: binding.role, model: { providerId: binding.model_provider_id, modelId: binding.model_id }, agentName: binding.agent_name, projectRoot: binding.project_root, projectFingerprint: binding.project_fingerprint, serverBaseUrl: binding.server_base_url, sessionCreatedAt: binding.session_created_at, pairedAt: binding.paired_at, rolePromptHash: binding.role_prompt_hash, expectedTitle: binding.expected_title })) };
  }

  public enqueueOutboxEvent(aggregateId: string, aggregateType: string, eventType: string, payload: Record<string, JsonLike>): OutboxEvent {
    const createdAt = nowIso();
    const result = this.database.prepare(`INSERT INTO outbox_events (aggregate_id, aggregate_type, event_type, payload, created_at, published_at) VALUES (@aggregateId, @aggregateType, @eventType, @payload, @createdAt, NULL)`).run({ aggregateId, aggregateType, eventType, payload: toJsonString(payload), createdAt });
    return { id: Number(result.lastInsertRowid), aggregateId, aggregateType, eventType, payload, createdAt, publishedAt: null };
  }

  public getPendingOutboxEvents(limit = 100): OutboxEvent[] {
    const rows = this.database.prepare(`SELECT id, aggregate_id, aggregate_type, event_type, payload, created_at, published_at FROM outbox_events WHERE published_at IS NULL ORDER BY id ASC LIMIT @limit`).all({ limit }) as Array<{ id: number; aggregate_id: string; aggregate_type: string; event_type: string; payload: string; created_at: string; published_at: string | null }>;
    return rows.map((row) => ({ id: row.id, aggregateId: row.aggregate_id, aggregateType: row.aggregate_type, eventType: row.event_type, payload: parseJson<Record<string, JsonLike>>(row.payload), createdAt: row.created_at, publishedAt: row.published_at }));
  }

  public markOutboxEventsPublished(ids: number[]): void {
    const publishedAt = nowIso();
    const statement = this.database.prepare(`UPDATE outbox_events SET published_at = @publishedAt WHERE id = @id`);
    this.database.transaction((eventIds: number[]) => { for (const id of eventIds) statement.run({ id, publishedAt }); })(ids);
  }

  public enqueueDispatch(input: DispatchInput): DispatchOutboxAction {
    const timestamp = nowIso();
    const purpose = input.purpose ?? "worker_task";
    const inferredTask = purpose === "worker_task" && !input.taskId
      ? this.getTaskExecutionByPromptMessageId(input.promptMessageId)
      : null;
    const taskId = input.taskId ?? inferredTask?.taskId ?? null;
    const parentPromptMessageId = input.parentPromptMessageId ?? null;
    const promptPayloadValue = input.promptPayload ?? (purpose === "worker_task" && inferredTask
      ? { kind: "worker_task", objective: inferredTask.envelope.objective, envelope: inferredTask.envelope }
      : {});
    const promptPayload = toJsonString(promptPayloadValue);
    this.database.prepare(`
      INSERT INTO dispatch_outbox (
        mission_id, dispatch_key, target_role, target_session_id, model_provider_id, model_id, prompt_message_id,
        state, lease_owner, lease_expires_at, attempt, created_at, updated_at, acknowledged_at, last_error,
        task_id, purpose, parent_prompt_message_id, prompt_payload
      ) VALUES (
        @missionId, @dispatchKey, @targetRole, @targetSessionId, @modelProviderId, @modelId, @promptMessageId,
        'pending', NULL, NULL, 0, @timestamp, @timestamp, NULL, NULL,
        @taskId, @purpose, @parentPromptMessageId, @promptPayload
      ) ON CONFLICT (dispatch_key) DO NOTHING
    `).run({ ...input, modelProviderId: input.capturedModel.providerId, modelId: input.capturedModel.modelId, timestamp, taskId, purpose, parentPromptMessageId, promptPayload });
    const action = this.getDispatchByKey(input.dispatchKey);
    if (!action) throw new Error(`dispatch not found after enqueue: ${input.dispatchKey}`);
    return action;
  }

  public getDispatchByKey(dispatchKey: string): DispatchOutboxAction | null {
    const row = this.database.prepare(`SELECT * FROM dispatch_outbox WHERE dispatch_key = @dispatchKey`).get({ dispatchKey }) as DispatchOutboxRow | undefined;
    return row ? dispatchFromRow(row) : null;
  }

  public getDispatchByPromptMessageId(promptMessageId: string): DispatchOutboxAction | null {
    const row = this.database.prepare(`SELECT * FROM dispatch_outbox WHERE prompt_message_id = @promptMessageId`).get({ promptMessageId }) as DispatchOutboxRow | undefined;
    return row ? dispatchFromRow(row) : null;
  }

  public recordOrchestratorDecisionResponse(input: { missionId: string; decisionPromptMessageId: string; responseMessageId: string; responseHash: string; outcome: "accepted" | "rejected"; reasonCode: string | null; taskId: string | null; action: string | null }): { id: number } {
    const recordedAt = nowIso();
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO orchestrator_decision_responses (
        mission_id, decision_prompt_message_id, response_message_id, response_hash, outcome, reason_code, task_id, action, recorded_at
      ) VALUES (@missionId, @decisionPromptMessageId, @responseMessageId, @responseHash, @outcome, @reasonCode, @taskId, @action, @recordedAt)
    `).run({ ...input, recordedAt });
    return { id: Number(result.lastInsertRowid ?? 0) };
  }

  public getOrchestratorDecisionResponses(missionId: string): Array<{ decisionPromptMessageId: string; responseMessageId: string; outcome: "accepted" | "rejected"; reasonCode: string | null }> {
    const rows = this.database.prepare(`SELECT decision_prompt_message_id, response_message_id, outcome, reason_code FROM orchestrator_decision_responses WHERE mission_id = @missionId ORDER BY id ASC`).all({ missionId }) as Array<{ decision_prompt_message_id: string; response_message_id: string; outcome: "accepted" | "rejected"; reason_code: string | null }>;
    return rows.map((row) => ({ decisionPromptMessageId: row.decision_prompt_message_id, responseMessageId: row.response_message_id, outcome: row.outcome, reasonCode: row.reason_code }));
  }

  public getPendingDispatches(limit = 100): DispatchOutboxAction[] {
    const rows = this.database.prepare(`SELECT * FROM dispatch_outbox WHERE acknowledged_at IS NULL ORDER BY id ASC LIMIT @limit`).all({ limit }) as DispatchOutboxRow[];
    return rows.map(dispatchFromRow);
  }

  public claimNextDispatch(leaseOwner: string, leaseDurationMs: number, timestamp = nowIso()): DispatchOutboxAction | null {
    const claimTimestamp = normalizeTimestamp(timestamp);
    const candidate = this.database.prepare(`
      SELECT id FROM dispatch_outbox
      WHERE acknowledged_at IS NULL AND (lease_expires_at IS NULL OR julianday(lease_expires_at) <= julianday(@timestamp))
      ORDER BY id ASC LIMIT 1
    `).get({ timestamp: claimTimestamp }) as { id: number } | undefined;
    if (!candidate) return null;
    const leaseExpiresAt = plusMilliseconds(claimTimestamp, leaseDurationMs);
    const claimed = this.database.prepare(`
      UPDATE dispatch_outbox
      SET state = 'claimed', lease_owner = @leaseOwner, lease_expires_at = @leaseExpiresAt,
        attempt = attempt + 1, updated_at = @timestamp
      WHERE id = @id AND acknowledged_at IS NULL AND (lease_expires_at IS NULL OR julianday(lease_expires_at) <= julianday(@timestamp))
    `).run({ id: candidate.id, leaseOwner, leaseExpiresAt, timestamp: claimTimestamp });
    if (claimed.changes === 0) return null;
    const row = this.database.prepare(`SELECT * FROM dispatch_outbox WHERE id = @id`).get({ id: candidate.id }) as DispatchOutboxRow;
    return dispatchFromRow(row);
  }

  public releaseDispatch(id: number, leaseOwner: string, lastError: string | null = null, timestamp = nowIso()): void {
    const releaseTimestamp = normalizeTimestamp(timestamp);
    const result = this.database.prepare(`
      UPDATE dispatch_outbox
      SET state = 'pending', lease_owner = NULL, lease_expires_at = NULL, last_error = @lastError, updated_at = @timestamp
      WHERE id = @id AND lease_owner = @leaseOwner AND acknowledged_at IS NULL
    `).run({ id, leaseOwner, lastError, timestamp: releaseTimestamp });
    if (result.changes === 0) throw new Error(`dispatch is not claimed by ${leaseOwner}: ${id}`);
  }

  public acknowledgeDispatch(id: number, leaseOwner: string, timestamp = nowIso()): void {
    const acknowledgedAt = normalizeTimestamp(timestamp);
    const result = this.database.prepare(`
      UPDATE dispatch_outbox
      SET state = 'acknowledged', lease_owner = NULL, lease_expires_at = NULL, acknowledged_at = @timestamp, updated_at = @timestamp
      WHERE id = @id AND lease_owner = @leaseOwner AND acknowledged_at IS NULL
    `).run({ id, leaseOwner, timestamp: acknowledgedAt });
    if (result.changes === 0) throw new Error(`dispatch is not claimed by ${leaseOwner}: ${id}`);
  }

  public acknowledgeTaskDispatch(id: number, leaseOwner: string, taskId: string, promptMessageId: string, timestamp = nowIso()): void {
    this.runInTransaction(() => {
      const acknowledgedAt = normalizeTimestamp(timestamp);
      this.acknowledgeDispatch(id, leaseOwner, acknowledgedAt);
      this.acknowledgeTaskPromptAttempt(taskId, promptMessageId, acknowledgedAt);
    });
  }

  /** Returns false when the same idempotency hash has already been recorded. */
  public recordProcessedMessage(input: ProcessedMessageInput): boolean {
    const result = this.database.prepare(`
      INSERT INTO processed_messages (message_hash, message_id, event_type, session_id, payload, processed_at)
      VALUES (@messageHash, @messageId, @eventType, @sessionId, @payload, @processedAt)
      ON CONFLICT (message_hash) DO NOTHING
    `).run({ ...input, payload: toJsonString(input.payload), processedAt: nowIso() });
    return result.changes === 1;
  }

  public hasProcessedMessage(messageHash: string): boolean {
    return Boolean(this.database.prepare(`SELECT 1 as present FROM processed_messages WHERE message_hash = @messageHash`).get({ messageHash }));
  }

  public saveControllerCheckpoint(input: ControllerCheckpointInput): void {
    const timestamp = nowIso();
    this.database.prepare(`
      INSERT INTO controller_checkpoints (cursor_key, roster_id, cursor, payload, created_at, updated_at)
      VALUES (@cursorKey, @rosterId, @cursor, @payload, @timestamp, @timestamp)
      ON CONFLICT (cursor_key) DO UPDATE SET roster_id = excluded.roster_id, cursor = excluded.cursor,
        payload = excluded.payload, updated_at = excluded.updated_at
    `).run({ ...input, payload: toJsonString(input.payload), timestamp });
  }

  public getControllerCheckpoint(cursorKey: string): ControllerCheckpoint | null {
    const row = this.database.prepare(`SELECT cursor_key, roster_id, cursor, payload, created_at, updated_at FROM controller_checkpoints WHERE cursor_key = @cursorKey`).get({ cursorKey }) as { cursor_key: string; roster_id: string | null; cursor: string; payload: string; created_at: string; updated_at: string } | undefined;
    if (!row) return null;
    return { cursorKey: row.cursor_key, rosterId: row.roster_id, cursor: row.cursor, payload: parseJson<Record<string, JsonLike>>(row.payload), createdAt: row.created_at, updatedAt: row.updated_at };
  }

  public recordApproval(input: ApprovalInput): ApprovalRecord {
    const createdAt = nowIso();
    const gate = (input as { gate?: string }).gate ?? null;
    this.database.prepare(`INSERT INTO orchestrator_approvals (approval_id, mission_id, task_id, decision, reason, created_at, gate) VALUES (@approvalId, @missionId, @taskId, @decision, @reason, @createdAt, @gate)`).run({ ...input, taskId: input.taskId ?? null, reason: input.reason ?? null, createdAt, gate });
    return { ...input, taskId: input.taskId ?? null, reason: input.reason ?? null, createdAt };
  }

  public getApprovals(missionId: string): ApprovalRecord[] {
    const rows = this.database.prepare(`SELECT approval_id, mission_id, task_id, decision, reason, gate, created_at FROM orchestrator_approvals WHERE mission_id = @missionId ORDER BY created_at ASC`).all({ missionId }) as Array<{ approval_id: string; mission_id: string; task_id: string | null; decision: "approved" | "rejected"; reason: string | null; gate: string | null; created_at: string }>;
    return rows.map((row) => ({ approvalId: row.approval_id, missionId: row.mission_id, taskId: row.task_id, decision: row.decision, reason: row.reason, gate: row.gate ?? undefined, createdAt: row.created_at }));
  }

  public saveWorkspaceSnapshot(input: WorkspaceSnapshotInput): WorkspaceSnapshot {
    const createdAt = nowIso();
    this.database.prepare(`INSERT INTO workspace_snapshots (snapshot_id, mission_id, project_root, fingerprint, payload, created_at) VALUES (@snapshotId, @missionId, @projectRoot, @fingerprint, @payload, @createdAt) ON CONFLICT (snapshot_id) DO UPDATE SET mission_id = excluded.mission_id, project_root = excluded.project_root, fingerprint = excluded.fingerprint, payload = excluded.payload`).run({ ...input, missionId: input.missionId ?? null, payload: toJsonString(input.payload), createdAt });
    return { ...input, missionId: input.missionId ?? null, createdAt };
  }

  public getWorkspaceSnapshot(snapshotId: string): WorkspaceSnapshot | null {
    const row = this.database.prepare(`SELECT snapshot_id, mission_id, project_root, fingerprint, payload, created_at FROM workspace_snapshots WHERE snapshot_id = @snapshotId`).get({ snapshotId }) as { snapshot_id: string; mission_id: string | null; project_root: string; fingerprint: string; payload: string; created_at: string } | undefined;
    if (!row) return null;
    return { snapshotId: row.snapshot_id, missionId: row.mission_id, projectRoot: row.project_root, fingerprint: row.fingerprint, payload: parseJson<Record<string, JsonLike>>(row.payload), createdAt: row.created_at };
  }

  private runMigrations(): void {
    this.database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);`);
    const applied = new Set((this.database.prepare(`SELECT version FROM schema_migrations`).all() as Array<{ version: number }>).map((row) => row.version));
    const migrations = [
      { version: 1, sql: initialSchemaSql },
      { version: 2, sql: liveWorkflowSchemaSql },
      { version: 3, sql: completionRecoverySchemaSql },
      { version: 4, sql: rosterHistorySchemaSql },
      { version: 5, sql: completionHardeningSchemaSql },
      { version: 6, sql: orchestratorActionsSchemaSql },
      { version: 7, sql: dispatchContractSchemaSql },
      { version: 8, sql: gateQualitySchemaSql },
      { version: 9, sql: controlledChecksSchemaSql }
    ];
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      this.database.transaction(() => {
        this.database.exec(migration.sql);
        this.database.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (@version, @appliedAt)`).run({ version: migration.version, appliedAt: nowIso() });
      })();
    }
  }
}

interface DispatchOutboxRow {
  id: number;
  mission_id: string;
  dispatch_key: string;
  target_role: Role;
  target_session_id: string;
  model_provider_id: string;
  model_id: string;
  prompt_message_id: string;
  state: DispatchState;
  lease_owner: string | null;
  lease_expires_at: string | null;
  attempt: number;
  created_at: string;
  updated_at: string;
  acknowledged_at: string | null;
  last_error: string | null;
  task_id: string | null;
  purpose: DispatchPurpose;
  parent_prompt_message_id: string | null;
  prompt_payload: string;
}

function dispatchFromRow(row: DispatchOutboxRow): DispatchOutboxAction {
  const parsedPayload = parsePromptPayload(row.prompt_payload, row.purpose);
  return {
    id: row.id,
    missionId: row.mission_id,
    dispatchKey: row.dispatch_key,
    targetRole: row.target_role,
    targetSessionId: row.target_session_id,
    capturedModel: { providerId: row.model_provider_id, modelId: row.model_id },
    promptMessageId: row.prompt_message_id,
    state: row.state,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    attempt: row.attempt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    acknowledgedAt: row.acknowledged_at,
    lastError: row.last_error,
    taskId: row.task_id,
    purpose: row.purpose,
    parentPromptMessageId: row.parent_prompt_message_id,
    promptPayload: parsedPayload.payload,
    promptPayloadError: parsedPayload.error
  };
}

function parsePromptPayload(value: string, purpose: DispatchPurpose): { payload: Record<string, JsonLike>; error: string | null } {
  if (!value) return { payload: {}, error: "malformed prompt payload" };
  try {
    const payload = parseJson<unknown>(value);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { payload: {}, error: "malformed prompt payload" };
    const record = payload as Record<string, JsonLike>;
    if (record.kind !== purpose) return { payload: {}, error: "prompt payload purpose mismatch" };
    return { payload: record, error: null };
  } catch {
    return { payload: {}, error: "malformed prompt payload" };
  }
}

const initialSchemaSql = `
  CREATE TABLE IF NOT EXISTS missions (
    mission_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    role TEXT NOT NULL,
    state TEXT NOT NULL,
    envelope TEXT NOT NULL,
    result TEXT,
    attempt INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    FOREIGN KEY (mission_id) REFERENCES missions (mission_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS outbox_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    aggregate_id TEXT NOT NULL,
    aggregate_type TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    published_at TEXT
  );
  CREATE TABLE IF NOT EXISTS rosters (
    roster_id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL UNIQUE,
    server_base_url TEXT NOT NULL,
    project_root TEXT NOT NULL,
    paired_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS session_bindings (
    roster_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    role TEXT NOT NULL,
    session_id TEXT NOT NULL UNIQUE,
    model_provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    project_root TEXT NOT NULL,
    project_fingerprint TEXT NOT NULL,
    server_base_url TEXT NOT NULL,
    session_created_at TEXT NOT NULL,
    paired_at TEXT NOT NULL,
    role_prompt_hash TEXT NOT NULL,
    expected_title TEXT NOT NULL,
    PRIMARY KEY (roster_id, position),
    UNIQUE (roster_id, role),
    FOREIGN KEY (roster_id) REFERENCES rosters (roster_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_mission_id ON tasks (mission_id);
  CREATE INDEX IF NOT EXISTS idx_outbox_events_unpublished ON outbox_events (published_at, id);
`;

const liveWorkflowSchemaSql = `
  CREATE TABLE IF NOT EXISTS mission_metadata (
    mission_id TEXT PRIMARY KEY,
    roster_id TEXT REFERENCES rosters (roster_id) ON DELETE SET NULL,
    objective TEXT NOT NULL,
    source_session_message_id TEXT NOT NULL,
    state TEXT NOT NULL,
    failure_reason TEXT,
    state_version INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (mission_id) REFERENCES missions (mission_id) ON DELETE CASCADE
  );
  ALTER TABLE missions ADD COLUMN state_version INTEGER NOT NULL DEFAULT 0;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_metadata_active_roster
    ON mission_metadata (roster_id)
    WHERE roster_id IS NOT NULL AND state NOT IN (${activeMissionStatesSql});
  CREATE TABLE IF NOT EXISTS task_execution_metadata (
    task_id TEXT PRIMARY KEY,
    target_session_id TEXT NOT NULL,
    controller_prompt_message_id TEXT NOT NULL,
    worker_output_message_id TEXT,
    timeout_ms INTEGER NOT NULL,
    state TEXT NOT NULL,
    result TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks (task_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS processed_messages (
    message_hash TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    session_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    processed_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS orchestrator_approvals (
    approval_id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    task_id TEXT,
    decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
    reason TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (mission_id) REFERENCES missions (mission_id) ON DELETE CASCADE,
    FOREIGN KEY (task_id) REFERENCES tasks (task_id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS workspace_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    mission_id TEXT,
    project_root TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (mission_id) REFERENCES missions (mission_id) ON DELETE SET NULL,
    UNIQUE (mission_id, fingerprint)
  );
  CREATE TABLE IF NOT EXISTS dispatch_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id TEXT NOT NULL,
    dispatch_key TEXT NOT NULL UNIQUE,
    target_role TEXT NOT NULL,
    target_session_id TEXT NOT NULL,
    model_provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    prompt_message_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'acknowledged')),
    lease_owner TEXT,
    lease_expires_at TEXT,
    attempt INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    acknowledged_at TEXT,
    last_error TEXT,
    FOREIGN KEY (mission_id) REFERENCES missions (mission_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_dispatch_outbox_claimable
    ON dispatch_outbox (acknowledged_at, lease_expires_at, id);
  CREATE TABLE IF NOT EXISTS controller_checkpoints (
    cursor_key TEXT PRIMARY KEY,
    roster_id TEXT REFERENCES rosters (roster_id) ON DELETE SET NULL,
    cursor TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

const completionRecoverySchemaSql = `
  CREATE TABLE IF NOT EXISTS controller_event_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks (task_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_controller_event_ledger_task ON controller_event_ledger (task_id, id);
`;

const rosterHistorySchemaSql = `
  ALTER TABLE rosters ADD COLUMN is_current INTEGER NOT NULL DEFAULT 0;
  UPDATE rosters SET is_current = 1 WHERE is_current = 0
    AND roster_id = (SELECT roster_id FROM rosters ORDER BY paired_at DESC LIMIT 1);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_rosters_is_current
    ON rosters (is_current) WHERE is_current = 1;
`;

const completionHardeningSchemaSql = `
  ALTER TABLE dispatch_outbox ADD COLUMN task_id TEXT REFERENCES tasks (task_id) ON DELETE SET NULL;
  ALTER TABLE dispatch_outbox ADD COLUMN purpose TEXT NOT NULL DEFAULT 'worker_task';
  ALTER TABLE dispatch_outbox ADD COLUMN parent_prompt_message_id TEXT;
  ALTER TABLE dispatch_outbox ADD COLUMN prompt_payload TEXT NOT NULL DEFAULT '{}';
  CREATE TABLE IF NOT EXISTS task_prompt_attempts (
    task_id TEXT NOT NULL,
    prompt_message_id TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ('worker_task', 'contract_repair')),
    attempt INTEGER NOT NULL,
    acknowledged_at TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (task_id, prompt_message_id),
    FOREIGN KEY (task_id) REFERENCES tasks (task_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_task_prompt_attempts_task ON task_prompt_attempts (task_id);
`;

const orchestratorActionsSchemaSql = `
  CREATE TABLE IF NOT EXISTS orchestrator_action_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id TEXT NOT NULL,
    message_id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    parent_message_id TEXT,
    decision_prompt_message_id TEXT,
    action TEXT NOT NULL CHECK (action IN ('approve', 'reject', 'request_completion')),
    task_id TEXT,
    payload TEXT NOT NULL,
    parsed_payload TEXT NOT NULL,
    accepted INTEGER NOT NULL DEFAULT 0,
    reject_reason TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (mission_id) REFERENCES missions (mission_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_orchestrator_action_messages_mission ON orchestrator_action_messages (mission_id);
  CREATE TABLE IF NOT EXISTS mission_event_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id TEXT NOT NULL,
    task_id TEXT,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (mission_id) REFERENCES missions (mission_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_mission_event_ledger_mission ON mission_event_ledger (mission_id, id);
  ALTER TABLE tasks ADD COLUMN consumed_at TEXT;
  ALTER TABLE orchestrator_approvals ADD COLUMN gate TEXT;
  ALTER TABLE orchestrator_approvals ADD COLUMN workspace_fingerprint TEXT;
  ALTER TABLE orchestrator_approvals ADD COLUMN superseded_at TEXT;
`;

const dispatchContractSchemaSql = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_outbox_prompt_message_id
    ON dispatch_outbox (prompt_message_id);
  UPDATE dispatch_outbox SET task_id = (
    SELECT tem.task_id FROM task_execution_metadata tem WHERE tem.controller_prompt_message_id = dispatch_outbox.prompt_message_id
  ) WHERE task_id IS NULL;
  CREATE TABLE IF NOT EXISTS orchestrator_decision_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id TEXT NOT NULL,
    decision_prompt_message_id TEXT NOT NULL,
    response_message_id TEXT NOT NULL,
    response_hash TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'rejected')),
    reason_code TEXT,
    task_id TEXT,
    action TEXT,
    recorded_at TEXT NOT NULL,
    UNIQUE (mission_id, decision_prompt_message_id, response_message_id),
    FOREIGN KEY (mission_id) REFERENCES missions (mission_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_orchestrator_decision_responses_mission ON orchestrator_decision_responses (mission_id);
`;

const gateQualitySchemaSql = `
  CREATE TABLE IF NOT EXISTS gate_attempts (
    mission_id TEXT NOT NULL,
    gate TEXT NOT NULL,
    role TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    workspace_fingerprint TEXT,
    approved_at TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (mission_id, gate, attempt),
    FOREIGN KEY (mission_id) REFERENCES missions (mission_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_gate_attempts_mission ON gate_attempts (mission_id, gate);
  CREATE INDEX IF NOT EXISTS idx_orchestrator_approvals_current
    ON orchestrator_approvals (mission_id, gate) WHERE superseded_at IS NULL;
  ALTER TABLE tasks ADD COLUMN workspace_fingerprint_at_dispatch TEXT;
  ALTER TABLE tasks ADD COLUMN source_workspace_fingerprint TEXT;
`;

const controlledChecksSchemaSql = `
  CREATE TABLE IF NOT EXISTS controlled_check_intents (
    check_intent_id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    check_name TEXT NOT NULL,
    executable TEXT NOT NULL,
    args_json TEXT NOT NULL,
    timeout_ms INTEGER NOT NULL,
    working_directory TEXT,
    env_json TEXT NOT NULL DEFAULT '{}',
    config_hash TEXT NOT NULL,
    lease_owner TEXT,
    lease_expires_at TEXT,
    attempt INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'passed', 'failed', 'timed_out', 'spawn_error')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (mission_id) REFERENCES missions (mission_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_controlled_check_intents_mission ON controlled_check_intents (mission_id);
  CREATE INDEX IF NOT EXISTS idx_controlled_check_intents_claimable
    ON controlled_check_intents (state, lease_expires_at);
  CREATE TABLE IF NOT EXISTS controlled_check_results (
    check_intent_id TEXT PRIMARY KEY,
    mission_id TEXT NOT NULL,
    exit_code INTEGER,
    status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'timed_out', 'spawn_error')),
    stdout TEXT NOT NULL,
    stderr TEXT NOT NULL,
    truncated INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL,
    captured_at TEXT NOT NULL,
    FOREIGN KEY (check_intent_id) REFERENCES controlled_check_intents (check_intent_id) ON DELETE CASCADE,
    FOREIGN KEY (mission_id) REFERENCES missions (mission_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS mission_configurations (
    mission_id TEXT NOT NULL,
    config_hash TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (mission_id),
    FOREIGN KEY (mission_id) REFERENCES missions (mission_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS permission_requests (
    mission_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL CHECK (state IN ('open', 'granted', 'denied', 'expired')),
    captured_at TEXT NOT NULL,
    resolved_at TEXT,
    PRIMARY KEY (mission_id, session_id, tool_name, captured_at),
    FOREIGN KEY (mission_id) REFERENCES missions (mission_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_permission_requests_mission_state ON permission_requests (mission_id, state);
`;
