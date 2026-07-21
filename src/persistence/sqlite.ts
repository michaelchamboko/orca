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

export interface DispatchInput {
  missionId: string;
  dispatchKey: string;
  targetRole: WorkerRole;
  targetSessionId: string;
  capturedModel: ModelRef;
  promptMessageId: string;
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
}

export interface CreateMissionTaskAndDispatchInput {
  mission: CreateMissionInput;
  task: Omit<TaskExecutionInput, "state" | "result">;
  dispatch: Omit<DispatchInput, "missionId">;
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

function plusMilliseconds(timestamp: string, durationMs: number): string {
  const start = Date.parse(timestamp);
  if (Number.isNaN(start) || durationMs <= 0) throw new Error("lease duration and timestamp must be valid");
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
      this.saveMission(input.missionId, input.state, input.payload ?? { objective: input.objective });
      this.database.prepare(`
        INSERT INTO mission_metadata (
          mission_id, roster_id, objective, source_session_message_id, state, failure_reason
        ) VALUES (
          @missionId, @rosterId, @objective, @sourceSessionMessageId, @state, @failureReason
        )
      `).run({ ...input, failureReason: input.failureReason ?? null });
      const mission = this.getMission(input.missionId);
      if (!mission) throw new Error(`mission not found after creation: ${input.missionId}`);
      return mission;
    });
  }

  public saveMission(missionId: string, state: MissionState, payload: Record<string, JsonLike>): void {
    const timestamp = nowIso();
    this.database.prepare(`
      INSERT INTO missions (mission_id, state, payload, created_at, updated_at)
      VALUES (@missionId, @state, @payload, @timestamp, @timestamp)
      ON CONFLICT (mission_id) DO UPDATE SET
        state = excluded.state,
        payload = excluded.payload,
        updated_at = excluded.updated_at
    `).run({ missionId, state, payload: toJsonString(payload), timestamp });
    this.database.prepare(`UPDATE mission_metadata SET state = @state WHERE mission_id = @missionId`)
      .run({ missionId, state });
  }

  public getMission(missionId: string): MissionDataRecord | null {
    const row = this.database.prepare(`
      SELECT m.mission_id, m.state, m.payload, m.created_at, m.updated_at,
        metadata.roster_id, metadata.objective, metadata.source_session_message_id, metadata.failure_reason
      FROM missions m
      LEFT JOIN mission_metadata metadata ON metadata.mission_id = m.mission_id
      WHERE m.mission_id = @missionId
    `).get({ missionId }) as {
      mission_id: string; state: MissionState; payload: string; created_at: string; updated_at: string;
      roster_id: string | null; objective: string | null; source_session_message_id: string | null; failure_reason: string | null;
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
      failureReason: row.failure_reason
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

  public getTaskCount(): number {
    const row = this.database.prepare("SELECT COUNT(*) as count FROM tasks").get() as { count: number } | undefined;
    return row?.count ?? 0;
  }

  public createMissionTaskAndDispatch(input: CreateMissionTaskAndDispatchInput): {
    mission: MissionDataRecord; task: TaskExecutionRecord; dispatch: DispatchOutboxAction;
  } {
    return this.runInTransaction(() => {
      const mission = this.createMission(input.mission);
      this.saveTaskExecution(input.task);
      const dispatch = this.enqueueDispatch({ ...input.dispatch, missionId: input.mission.missionId });
      input.beforeCommit?.();
      const task = this.getTaskExecution(input.task.envelope.taskId);
      if (!task) throw new Error(`task execution not found: ${input.task.envelope.taskId}`);
      return { mission, task, dispatch };
    });
  }

  public saveRoster(roster: PairedRoster): void {
    this.runInTransaction(() => {
      this.database.exec("DELETE FROM session_bindings; DELETE FROM rosters;");
      this.database.prepare(`INSERT INTO rosters (roster_id, fingerprint, server_base_url, project_root, paired_at) VALUES (@rosterId, @fingerprint, @serverBaseUrl, @projectRoot, @pairedAt)`).run({ rosterId: roster.rosterId, fingerprint: roster.fingerprint, serverBaseUrl: roster.serverBaseUrl, projectRoot: roster.projectRoot, pairedAt: roster.pairedAt });
      const statement = this.database.prepare(`INSERT INTO session_bindings (roster_id, position, role, session_id, model_provider_id, model_id, agent_name, project_root, project_fingerprint, server_base_url, session_created_at, paired_at, role_prompt_hash, expected_title) VALUES (@rosterId, @position, @role, @sessionId, @modelProviderId, @modelId, @agentName, @projectRoot, @projectFingerprint, @serverBaseUrl, @sessionCreatedAt, @pairedAt, @rolePromptHash, @expectedTitle)`);
      for (const binding of roster.bindings) statement.run({ rosterId: roster.rosterId, position: binding.position, role: binding.role, sessionId: binding.sessionId, modelProviderId: binding.model.providerId, modelId: binding.model.modelId, agentName: binding.agentName, projectRoot: binding.projectRoot, projectFingerprint: binding.projectFingerprint, serverBaseUrl: binding.serverBaseUrl, sessionCreatedAt: binding.sessionCreatedAt, pairedAt: binding.pairedAt, rolePromptHash: binding.rolePromptHash, expectedTitle: binding.expectedTitle });
    });
  }

  public getCurrentRoster(): PairedRoster | null {
    const roster = this.database.prepare(`SELECT roster_id, fingerprint, server_base_url, project_root, paired_at FROM rosters ORDER BY paired_at DESC LIMIT 1`).get() as { roster_id: string; fingerprint: string; server_base_url: string; project_root: string; paired_at: string } | undefined;
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
    this.database.prepare(`
      INSERT INTO dispatch_outbox (
        mission_id, dispatch_key, target_role, target_session_id, model_provider_id, model_id, prompt_message_id,
        state, lease_owner, lease_expires_at, attempt, created_at, updated_at, acknowledged_at, last_error
      ) VALUES (
        @missionId, @dispatchKey, @targetRole, @targetSessionId, @modelProviderId, @modelId, @promptMessageId,
        'pending', NULL, NULL, 0, @timestamp, @timestamp, NULL, NULL
      ) ON CONFLICT (dispatch_key) DO NOTHING
    `).run({ ...input, modelProviderId: input.capturedModel.providerId, modelId: input.capturedModel.modelId, timestamp });
    const action = this.getDispatchByKey(input.dispatchKey);
    if (!action) throw new Error(`dispatch not found after enqueue: ${input.dispatchKey}`);
    return action;
  }

  public getDispatchByKey(dispatchKey: string): DispatchOutboxAction | null {
    const row = this.database.prepare(`SELECT * FROM dispatch_outbox WHERE dispatch_key = @dispatchKey`).get({ dispatchKey }) as DispatchOutboxRow | undefined;
    return row ? dispatchFromRow(row) : null;
  }

  public getPendingDispatches(limit = 100): DispatchOutboxAction[] {
    const rows = this.database.prepare(`SELECT * FROM dispatch_outbox WHERE acknowledged_at IS NULL ORDER BY id ASC LIMIT @limit`).all({ limit }) as DispatchOutboxRow[];
    return rows.map(dispatchFromRow);
  }

  public claimNextDispatch(leaseOwner: string, leaseDurationMs: number, timestamp = nowIso()): DispatchOutboxAction | null {
    const candidate = this.database.prepare(`
      SELECT id FROM dispatch_outbox
      WHERE acknowledged_at IS NULL AND (lease_expires_at IS NULL OR lease_expires_at <= @timestamp)
      ORDER BY id ASC LIMIT 1
    `).get({ timestamp }) as { id: number } | undefined;
    if (!candidate) return null;
    const leaseExpiresAt = plusMilliseconds(timestamp, leaseDurationMs);
    const claimed = this.database.prepare(`
      UPDATE dispatch_outbox
      SET state = 'claimed', lease_owner = @leaseOwner, lease_expires_at = @leaseExpiresAt,
        attempt = attempt + 1, updated_at = @timestamp
      WHERE id = @id AND acknowledged_at IS NULL AND (lease_expires_at IS NULL OR lease_expires_at <= @timestamp)
    `).run({ id: candidate.id, leaseOwner, leaseExpiresAt, timestamp });
    if (claimed.changes === 0) return null;
    const row = this.database.prepare(`SELECT * FROM dispatch_outbox WHERE id = @id`).get({ id: candidate.id }) as DispatchOutboxRow;
    return dispatchFromRow(row);
  }

  public releaseDispatch(id: number, leaseOwner: string, lastError: string | null = null, timestamp = nowIso()): void {
    const result = this.database.prepare(`
      UPDATE dispatch_outbox
      SET state = 'pending', lease_owner = NULL, lease_expires_at = NULL, last_error = @lastError, updated_at = @timestamp
      WHERE id = @id AND lease_owner = @leaseOwner AND acknowledged_at IS NULL
    `).run({ id, leaseOwner, lastError, timestamp });
    if (result.changes === 0) throw new Error(`dispatch is not claimed by ${leaseOwner}: ${id}`);
  }

  public acknowledgeDispatch(id: number, leaseOwner: string, timestamp = nowIso()): void {
    const result = this.database.prepare(`
      UPDATE dispatch_outbox
      SET state = 'acknowledged', lease_owner = NULL, lease_expires_at = NULL, acknowledged_at = @timestamp, updated_at = @timestamp
      WHERE id = @id AND lease_owner = @leaseOwner AND acknowledged_at IS NULL
    `).run({ id, leaseOwner, timestamp });
    if (result.changes === 0) throw new Error(`dispatch is not claimed by ${leaseOwner}: ${id}`);
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
    this.database.prepare(`INSERT INTO orchestrator_approvals (approval_id, mission_id, task_id, decision, reason, created_at) VALUES (@approvalId, @missionId, @taskId, @decision, @reason, @createdAt)`).run({ ...input, taskId: input.taskId ?? null, reason: input.reason ?? null, createdAt });
    return { ...input, taskId: input.taskId ?? null, reason: input.reason ?? null, createdAt };
  }

  public getApprovals(missionId: string): ApprovalRecord[] {
    const rows = this.database.prepare(`SELECT approval_id, mission_id, task_id, decision, reason, created_at FROM orchestrator_approvals WHERE mission_id = @missionId ORDER BY created_at ASC`).all({ missionId }) as Array<{ approval_id: string; mission_id: string; task_id: string | null; decision: "approved" | "rejected"; reason: string | null; created_at: string }>;
    return rows.map((row) => ({ approvalId: row.approval_id, missionId: row.mission_id, taskId: row.task_id, decision: row.decision, reason: row.reason, createdAt: row.created_at }));
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
      { version: 2, sql: liveWorkflowSchemaSql }
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
  target_role: WorkerRole;
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
}

function dispatchFromRow(row: DispatchOutboxRow): DispatchOutboxAction {
  return {
    id: row.id, missionId: row.mission_id, dispatchKey: row.dispatch_key, targetRole: row.target_role,
    targetSessionId: row.target_session_id, capturedModel: { providerId: row.model_provider_id, modelId: row.model_id },
    promptMessageId: row.prompt_message_id, state: row.state, leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at, attempt: row.attempt, createdAt: row.created_at,
    updatedAt: row.updated_at, acknowledgedAt: row.acknowledged_at, lastError: row.last_error
  };
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
    FOREIGN KEY (mission_id) REFERENCES missions (mission_id) ON DELETE CASCADE
  );
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
