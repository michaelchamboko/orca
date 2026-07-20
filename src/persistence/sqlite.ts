import Database from "better-sqlite3";

import {
  MissionState,
  PairedRoster,
  TaskEnvelope,
  TaskState
} from "../domain/types.js";
import { RoleWorkerResult } from "../domain/types.js";

type JsonLike = unknown;

export interface MissionDataRecord {
  missionId: string;
  state: MissionState;
  payload: Record<string, JsonLike>;
  createdAt: string;
  updatedAt: string;
}

export interface PersistedTask {
  missionId: string;
  taskId: string;
  role: Exclude<Role, "orchestrator">;
  state: TaskState;
  envelope: TaskEnvelope;
  result: RoleWorkerResult | null;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
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

export interface SqlitePersistenceConfig {
  path: string;
}

type Role = "orchestrator" | "planner" | "builder" | "reviewer" | "tester";

function toJsonString(payload: JsonLike): string {
  return JSON.stringify(payload);
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function nowIso(): string {
  return new Date().toISOString();
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

  public saveMission(missionId: string, state: MissionState, payload: Record<string, JsonLike>): void {
    const timestamp = nowIso();
    this.database
      .prepare(
        `
        INSERT INTO missions (mission_id, state, payload, created_at, updated_at)
        VALUES (@missionId, @state, @payload, @timestamp, @timestamp)
        ON CONFLICT (mission_id) DO UPDATE SET
          state = excluded.state,
          payload = excluded.payload,
          updated_at = excluded.updated_at
      `
      )
      .run({
        missionId,
        state,
        payload: toJsonString(payload),
        timestamp
      });
  }

  public getMission(missionId: string): MissionDataRecord | null {
    const row = this.database
      .prepare(`SELECT mission_id, state, payload, created_at, updated_at FROM missions WHERE mission_id = @missionId`)
      .get({ missionId }) as
      | {
          mission_id: string;
          state: MissionState;
          payload: string;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      missionId: row.mission_id,
      state: row.state,
      payload: parseJson<Record<string, JsonLike>>(row.payload),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  public getMissionCount(): number {
    const row = this.database
      .prepare("SELECT COUNT(*) as count FROM missions")
      .get() as { count: number } | undefined;

    return row?.count ?? 0;
  }

  public saveTaskEnvelope(task: TaskEnvelope): void {
    const timestamp = nowIso();
    const attempt = task.attempt;

    this.database
      .prepare(
        `
        INSERT INTO tasks (
          task_id,
          mission_id,
          role,
          state,
          envelope,
          result,
          attempt,
          created_at,
          updated_at,
          completed_at
        )
        VALUES (
          @taskId,
          @missionId,
          @role,
          @state,
          @envelope,
          NULL,
          @attempt,
          @timestamp,
          @timestamp,
          NULL
        )
        ON CONFLICT (task_id) DO UPDATE SET
          mission_id = excluded.mission_id,
          role = excluded.role,
          state = excluded.state,
          envelope = excluded.envelope,
          result = excluded.result,
          attempt = excluded.attempt,
          updated_at = excluded.updated_at
      `
      )
      .run({
        taskId: task.taskId,
        missionId: task.missionId,
        role: task.role,
        state: "queued" as const,
        envelope: toJsonString(task),
        attempt,
        timestamp
      });
  }

  public saveTaskResult(taskId: string, state: TaskState, result: RoleWorkerResult): void {
    const timestamp = nowIso();
    const completedAt = state === "completed" || state === "approved" || state === "rejected" ? timestamp : null;

    const info = this.database
      .prepare(
        `
        UPDATE tasks
        SET state = @state,
            result = @result,
            updated_at = @timestamp,
            completed_at = @completedAt
        WHERE task_id = @taskId
      `
      )
      .run({
        taskId,
        state,
        result: toJsonString(result),
        timestamp,
        completedAt
      });

    if (info.changes === 0) {
      throw new Error(`task not found: ${taskId}`);
    }
  }

  public getTask(taskId: string): PersistedTask | null {
    const row = this.database
      .prepare(
        `
        SELECT
          mission_id,
          task_id,
          role,
          state,
          envelope,
          result,
          attempt,
          created_at,
          updated_at,
          completed_at
        FROM tasks
        WHERE task_id = @taskId
      `
      )
      .get({ taskId }) as
      | {
          mission_id: string;
          task_id: string;
          role: Exclude<Role, "orchestrator">;
          state: TaskState;
          envelope: string;
          result: string | null;
          attempt: number;
          created_at: string;
          updated_at: string;
          completed_at: string | null;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      missionId: row.mission_id,
      taskId: row.task_id,
      role: row.role,
      state: row.state,
      envelope: parseJson<TaskEnvelope>(row.envelope),
      result: row.result ? parseJson<RoleWorkerResult>(row.result) : null,
      attempt: row.attempt,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at
    };
  }

  public getTaskCount(): number {
    const row = this.database
      .prepare("SELECT COUNT(*) as count FROM tasks")
      .get() as { count: number } | undefined;

    return row?.count ?? 0;
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

  public enqueueOutboxEvent(
    aggregateId: string,
    aggregateType: string,
    eventType: string,
    payload: Record<string, JsonLike>
  ): OutboxEvent {
    const timestamp = nowIso();
    const result = this.database
      .prepare(
        `INSERT INTO outbox_events (
          aggregate_id,
          aggregate_type,
          event_type,
          payload,
          created_at,
          published_at
        )
         VALUES (
          @aggregateId,
          @aggregateType,
          @eventType,
          @payload,
          @createdAt,
          NULL
         )`
      )
      .run({
        aggregateId,
        aggregateType,
        eventType,
        payload: toJsonString(payload),
        createdAt: timestamp
      });

    return {
      id: Number(result.lastInsertRowid),
      aggregateId,
      aggregateType,
      eventType,
      payload,
      createdAt: timestamp,
      publishedAt: null
    };
  }

  public getPendingOutboxEvents(limit = 100): OutboxEvent[] {
    const rows = this.database
      .prepare(
        `
        SELECT
          id,
          aggregate_id,
          aggregate_type,
          event_type,
          payload,
          created_at,
          published_at
        FROM outbox_events
        WHERE published_at IS NULL
        ORDER BY id ASC
        LIMIT @limit
      `
      )
      .all({ limit }) as {
      id: number;
      aggregate_id: string;
      aggregate_type: string;
      event_type: string;
      payload: string;
      created_at: string;
      published_at: string | null;
    }[];

    return rows.map((row: {
      id: number;
      aggregate_id: string;
      aggregate_type: string;
      event_type: string;
      payload: string;
      created_at: string;
      published_at: string | null;
    }) => ({
      id: row.id,
      aggregateId: row.aggregate_id,
      aggregateType: row.aggregate_type,
      eventType: row.event_type,
      payload: parseJson<Record<string, JsonLike>>(row.payload),
      createdAt: row.created_at,
      publishedAt: row.published_at
    }));
  }

  public markOutboxEventsPublished(ids: number[]): void {
    const timestamp = nowIso();
    const statement = this.database.prepare(
      `UPDATE outbox_events
       SET published_at = @publishedAt
       WHERE id = @id`
    );

    this.database.transaction((eventIds: number[]) => {
      for (const id of eventIds) {
        statement.run({ id, publishedAt: timestamp });
      }
    })(ids);
  }

  private runMigrations(): void {
    this.database.exec(`
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
        FOREIGN KEY (mission_id) REFERENCES missions (mission_id)
          ON DELETE CASCADE
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

      CREATE INDEX IF NOT EXISTS idx_tasks_mission_id
        ON tasks (mission_id);

      CREATE INDEX IF NOT EXISTS idx_outbox_events_unpublished
        ON outbox_events (published_at, id);
    `);
  }
}
