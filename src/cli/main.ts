import { Command } from "commander";
import packageJson from "../../package.json" with { type: "json" };
import { fileURLToPath } from "node:url";
import { runConfiguredDoctor } from "./doctor.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { resolveOpenCodeConnectionConfig } from "../config/opencode-auth.js";
import { RealOpenCodeAdapter } from "../integrations/opencode/real.js";
import { selectFiveSessions } from "../pairing/interactive.js";
import { RosterService } from "../pairing/roster-service.js";
import { formatRosterStatus, readRosterStatus } from "../pairing/status.js";
import { SqlitePersistence } from "../persistence/sqlite.js";
import { installRoleProfiles } from "../roles/installer.js";
import { requireVerifiedRoleProfileActivation } from "../roles/activation.js";
import { roleProfiles } from "../roles/profiles.js";
import { readControllerRuntime } from "../controller/runtime.js";

export interface ServerCommandOptions {
  server?: string;
}

export interface CliHandlers {
  doctor(options: ServerCommandOptions): void | Promise<void>;
  pair(options: ServerCommandOptions): void | Promise<void>;
  status(): void | Promise<void>;
  controllerStart(): void | Promise<void>;
}

export class OrcaNotConfiguredError extends Error {
  public readonly code = "ORCA_NOT_CONFIGURED";

  constructor(command: string) {
    super(`${command} is not configured in this ORCA build`);
    this.name = "OrcaNotConfiguredError";
  }
}

export function getVersion(): string {
  return packageJson.version;
}

function unconfigured(command: string): () => never {
  return () => {
    throw new OrcaNotConfiguredError(command);
  };
}

export function buildCliProgram(handlers: Partial<CliHandlers> = {}): Command {
  const program = new Command();

  program
    .name("swarmctl")
    .description("OpenCode five-session orchestration controller CLI")
    .version(getVersion());

  program
    .command("doctor")
    .description("check ORCA's OpenCode server connection")
    .option("--server <url>", "OpenCode server URL")
    .action((options: ServerCommandOptions) => (handlers.doctor ?? ((doctorOptions: ServerCommandOptions) => runConfiguredDoctor(doctorOptions, getVersion())))(options));

  program
    .command("pair")
    .description("pair five OpenCode sessions")
    .option("--server <url>", "OpenCode server URL")
    .action((options: ServerCommandOptions) => (handlers.pair ?? runConfiguredPair)(options));

  program
    .command("status")
    .description("show the current ORCA pairing and controller status")
    .action(() => (handlers.status ?? runConfiguredStatus)());

  program
    .command("controller")
    .description("manage the ORCA controller")
    .command("start")
    .description("start the ORCA controller")
    .action(() => (handlers.controllerStart ?? unconfigured("controller start"))());

  return program;
}

async function runConfiguredPair(options: ServerCommandOptions): Promise<void> {
  const projectRoot = process.cwd();
  const connection = await resolveOpenCodeConnectionConfig({ baseUrl: options.server });
  const adapter = new RealOpenCodeAdapter(connection);
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    requireVerifiedRoleProfileActivation(installRoleProfiles(projectRoot));
    const selected = await selectFiveSessions(await adapter.listSessions(), projectRoot, (question) => readline.question(question), (line) => process.stdout.write(`${line}\n`));
    process.stdout.write(`${formatPairConfirmation(selected)}\n`);
    if ((await readline.question("Confirm this exact roster before saving? [y/N] ")).trim().toLowerCase() !== "y") throw new Error("pairing cancelled");
    const persistence = openPersistence(projectRoot);
    try {
      const roster = await new RosterService(adapter, persistence).pairSelected(selected);
      process.stdout.write(`Paired roster ${roster.rosterId}\n`);
    } finally {
      persistence.close();
    }
  } finally {
    readline.close();
  }
}

async function runConfiguredStatus(): Promise<void> {
  const projectRoot = process.cwd();
  const persistence = openPersistence(projectRoot);
  try {
    const roster = persistence.getCurrentRoster();
    let adapter: RealOpenCodeAdapter | undefined;
    if (roster) {
      try {
        const connection = await resolveOpenCodeConnectionConfig({ baseUrl: roster.serverBaseUrl, interactive: false });
        adapter = new RealOpenCodeAdapter(connection);
      } catch {
        adapter = undefined;
      }
    }
    process.stdout.write(`${formatRosterStatus(await readRosterStatus(persistence, adapter, readControllerRuntime(projectRoot).running))}\n`);
  } finally {
    persistence.close();
  }
}

function openPersistence(projectRoot: string): SqlitePersistence {
  const directory = join(projectRoot, ".orca");
  mkdirSync(directory, { recursive: true });
  return new SqlitePersistence({ path: join(directory, "orca.db") });
}

export function formatPairConfirmation(sessions: readonly { id: string; title: string; model: { providerId: string; modelId: string } }[]): string {
  return ["Position | Role | Title | Session ID | Model", ...sessions.map((session, index) => `${index + 1} | ${roleProfiles[index]?.role ?? "unknown"} | ${session.title} | ${session.id.slice(0, 8)} | ${session.model.providerId}/${session.model.modelId}`)].join("\n");
}


async function main(): Promise<void> {
  const program = buildCliProgram();

  await program.parseAsync(process.argv);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    if (error instanceof OrcaNotConfiguredError) {
      process.stderr.write(`${error.code}: ${error.message}\n`);
      process.exitCode = 1;
      return;
    }

    process.stderr.write(`${error instanceof Error ? error.message : "Unexpected CLI error"}\n`);
    process.exitCode = 1;
  });
}
