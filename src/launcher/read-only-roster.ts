import { existsSync } from "node:fs";

import Database from "better-sqlite3";

import type { PairedRoster, Role } from "../domain/types.js";
import { projectPersistencePaths } from "../persistence/project.js";

const terminalMissionStates = ["completed", "failed", "cancelled", "blocked"] as const;

export function readCurrentRosterReadonly(projectRoot: string): PairedRoster | null {
  const { databasePath } = projectPersistencePaths(projectRoot);
  if (!existsSync(databasePath)) return null;
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const roster = database.prepare("SELECT roster_id, fingerprint, server_base_url, project_root, paired_at FROM rosters WHERE is_current = 1 ORDER BY paired_at DESC LIMIT 1").get() as { roster_id: string; fingerprint: string; server_base_url: string; project_root: string; paired_at: string } | undefined;
    if (!roster) return null;
    const bindings = database.prepare("SELECT position, role, session_id, model_provider_id, model_id, agent_name, project_root, project_fingerprint, server_base_url, session_created_at, paired_at, role_prompt_hash, expected_title FROM session_bindings WHERE roster_id = @rosterId ORDER BY position ASC").all({ rosterId: roster.roster_id }) as Array<{ position: 1 | 2 | 3 | 4 | 5; role: Role; session_id: string; model_provider_id: string; model_id: string; agent_name: string; project_root: string; project_fingerprint: string; server_base_url: string; session_created_at: string; paired_at: string; role_prompt_hash: string; expected_title: string }>;
    return {
      rosterId: roster.roster_id,
      fingerprint: roster.fingerprint,
      serverBaseUrl: roster.server_base_url,
      projectRoot: roster.project_root,
      pairedAt: roster.paired_at,
      bindings: bindings.map((binding) => ({
        sessionId: binding.session_id,
        position: binding.position,
        role: binding.role,
        model: { providerId: binding.model_provider_id, modelId: binding.model_id },
        agentName: binding.agent_name,
        projectRoot: binding.project_root,
        projectFingerprint: binding.project_fingerprint,
        serverBaseUrl: binding.server_base_url,
        sessionCreatedAt: binding.session_created_at,
        pairedAt: binding.paired_at,
        rolePromptHash: binding.role_prompt_hash,
        expectedTitle: binding.expected_title
      }))
    };
  } catch {
    return null;
  } finally {
    database.close();
  }
}

export function readActiveMissionReadonly(projectRoot: string): { missionId: string; state: string } | null {
  const { databasePath } = projectPersistencePaths(projectRoot);
  if (!existsSync(databasePath)) return null;
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const placeholders = terminalMissionStates.map((state) => `'${state}'`).join(", ");
    const row = database.prepare(`SELECT mission_id, state FROM mission_metadata WHERE state NOT IN (${placeholders}) ORDER BY rowid DESC LIMIT 1`).get() as { mission_id: string; state: string } | undefined;
    return row ? { missionId: row.mission_id, state: row.state } : null;
  } catch {
    return null;
  } finally {
    database.close();
  }
}
