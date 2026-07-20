import Database from "better-sqlite3";

import { resolveOpenCodeConnectionConfig } from "../config/opencode-auth.js";
import { roleProfiles } from "../roles/profiles.js";
import { RealOpenCodeAdapter } from "../integrations/opencode/real.js";
import type { ServerCommandOptions } from "./main.js";

export interface DoctorAdapter {
  health(): Promise<{ healthy: boolean; version?: string }>;
  listSessions(projectRoot: string): Promise<unknown[]>;
}

export interface RunDoctorOptions {
  adapter: DoctorAdapter;
  cliVersion: string;
  repositoryPath: string;
  sqliteAvailable: boolean;
  roleProfilesAvailable: boolean;
  write: (line: string) => void;
}

export class OpenCodeDoctorAuthenticationError extends Error {
  constructor() {
    super("OpenCode authentication failed. Set OPENCODE_SERVER_PASSWORD (and OPENCODE_SERVER_USERNAME if needed), then run doctor again.");
    this.name = "OpenCodeDoctorAuthenticationError";
  }
}

export async function runDoctor(options: RunDoctorOptions): Promise<void> {
  let health: { healthy: boolean; version?: string };
  try {
    health = await options.adapter.health();
  } catch (error) {
    if (statusOf(error) === 401) throw new OpenCodeDoctorAuthenticationError();
    throw error;
  }
  const sessions = await options.adapter.listSessions(options.repositoryPath);
  options.write(`CLI version: ${options.cliVersion}`);
  options.write(`OpenCode server: ${health.healthy ? "reachable and authenticated" : "unhealthy"}`);
  if (health.version) options.write(`OpenCode version: ${health.version}`);
  options.write(`Repository path: ${options.repositoryPath}`);
  options.write(`Session count: ${sessions.length}`);
  options.write(`SQLite native binding: ${options.sqliteAvailable ? "available" : "unavailable"}`);
  options.write(`Role profiles: ${options.roleProfilesAvailable ? "available" : "unavailable"}`);
}

export async function runConfiguredDoctor(options: ServerCommandOptions, cliVersion: string): Promise<void> {
  const connection = await resolveOpenCodeConnectionConfig({ baseUrl: options.server });
  const adapter = new RealOpenCodeAdapter(connection);
  await runDoctor({
    adapter,
    cliVersion,
    repositoryPath: process.cwd(),
    sqliteAvailable: sqliteBindingAvailable(),
    roleProfilesAvailable: roleProfiles.length === 5,
    write: (line) => process.stdout.write(`${line}\n`)
  });
}

function sqliteBindingAvailable(): boolean {
  try {
    const database = new Database(":memory:");
    database.close();
    return true;
  } catch {
    return false;
  }
}

function statusOf(error: unknown): number | undefined {
  return error && typeof error === "object" && "status" in error && typeof error.status === "number"
    ? error.status
    : undefined;
}
