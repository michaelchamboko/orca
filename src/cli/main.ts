import { Command } from "commander";
import packageJson from "../../package.json" with { type: "json" };
import { fileURLToPath } from "node:url";

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
    .action((options: ServerCommandOptions) => (handlers.doctor ?? unconfigured("doctor"))(options));

  program
    .command("pair")
    .description("pair five OpenCode sessions")
    .option("--server <url>", "OpenCode server URL")
    .action((options: ServerCommandOptions) => (handlers.pair ?? unconfigured("pair"))(options));

  program
    .command("status")
    .description("show the current ORCA pairing and controller status")
    .action(() => (handlers.status ?? unconfigured("status"))());

  program
    .command("controller")
    .description("manage the ORCA controller")
    .command("start")
    .description("start the ORCA controller")
    .action(() => (handlers.controllerStart ?? unconfigured("controller start"))());

  return program;
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

    throw error;
  });
}
