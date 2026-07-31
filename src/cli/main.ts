import { Command } from "commander";
import packageJson from "../../package.json" with { type: "json" };
import { fileURLToPath } from "node:url";
import { runConfiguredDoctor } from "./doctor.js";
import { createInterface } from "node:readline/promises";
import { resolveOpenCodeConnectionConfig } from "../config/opencode-auth.js";
import { RealOpenCodeAdapter } from "../integrations/opencode/real.js";
import { openBrowser } from "../launcher/browser.js";
import { resolveCanonicalProjectRoot, validateLoopbackOpenCodeOrigin } from "../launcher/project.js";
import { startLauncherUi } from "../launcher/server.js";
import { selectFiveSessions } from "../pairing/interactive.js";
import { RosterService } from "../pairing/roster-service.js";
import { formatRosterStatus, readRosterStatus } from "../pairing/status.js";
import { openProjectPersistence } from "../persistence/project.js";
import { installRoleProfiles } from "../roles/installer.js";
import { requireVerifiedRoleProfileActivation } from "../roles/activation.js";
import { roleProfiles } from "../roles/profiles.js";
import { readControllerRuntime } from "../controller/runtime.js";
import { controllerStatus, startController, stopController } from "../controller/main.js";

export interface ServerCommandOptions {
  server?: string;
}

export interface UiCommandOptions extends ServerCommandOptions {
  open?: boolean;
}

export interface CliHandlers {
  doctor(options: ServerCommandOptions): void | Promise<void>;
  pair(options: ServerCommandOptions): void | Promise<void>;
  ui(options: UiCommandOptions): void | Promise<void>;
  status(): void | Promise<void>;
  controllerStart(options: { daemon?: boolean }): void | Promise<void>;
  controllerStop(): void | Promise<void>;
  controllerStatus(): void | Promise<void>;
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
    .command("ui")
    .description("start the localhost ORCA launcher dashboard")
    .option("--server <url>", "OpenCode server URL")
    .option("--no-open", "print the launcher URL without opening a browser")
    .action((options: UiCommandOptions) => (handlers.ui ?? runConfiguredUi)(options));

  program
    .command("status")
    .description("show the current ORCA pairing and controller status")
    .action(() => (handlers.status ?? runConfiguredStatus)());

  program
    .command("controller")
    .description("manage the ORCA controller")
    .command("start")
    .description("start the ORCA controller")
    .option("--daemon", "run as a background daemon (not implemented)")
    .action((options: { daemon?: boolean }) => (handlers.controllerStart ?? runConfiguredControllerStart)(options));

  program
    .commands.find((command) => command.name() === "controller")
    ?.command("stop")
    .description("stop the ORCA controller")
    .action(() => (handlers.controllerStop ?? runConfiguredControllerStop)());

  program
    .commands.find((command) => command.name() === "controller")
    ?.command("status")
    .description("show authenticated controller status")
    .action(() => (handlers.controllerStatus ?? runConfiguredControllerStatus)());

  return program;
}

async function runConfiguredControllerStart(options: { daemon?: boolean }): Promise<void> {
  if (options.daemon) throw new Error("controller daemon mode is not implemented; run foreground mode without --daemon");
  const projectRoot = process.cwd();
  const connection = await resolveOpenCodeConnectionConfig();
  const persistence = openProjectPersistence(projectRoot);
  try {
    const roster = persistence.getCurrentRoster();
    const controllerConnection = { ...connection, baseUrl: roster?.serverBaseUrl ?? connection.baseUrl };
    const controller = await startController({ projectRoot, adapter: new RealOpenCodeAdapter(controllerConnection), persistence, version: getVersion() });
    const shutdown = async (): Promise<void> => {
      await controller.stop();
      persistence.close();
    };
    process.once("SIGINT", () => { void shutdown(); });
    process.once("SIGTERM", () => { void shutdown(); });
    process.stdout.write(`Controller started at http://${controller.address.host}:${controller.address.port}\n`);
  } catch (error) {
    persistence.close();
    throw error;
  }
}

async function runConfiguredControllerStop(): Promise<void> {
  const stopped = await stopController(process.cwd());
  process.stdout.write(`${stopped ? "Controller stopping" : "No running controller; stale runtime state cleared"}\n`);
}

async function runConfiguredControllerStatus(): Promise<void> {
  const status = await controllerStatus(process.cwd());
  const details = status.running ? `\nOpenCode: ${status.opencodeHealthy ? "healthy" : "unhealthy"}\nBindings: ${status.bindingsCurrent ? `${status.bindingCount ?? 0} current` : "drift detected"}` : "";
  process.stdout.write(`Controller: ${status.running ? "running" : "not running"}${details}\n`);
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
    const persistence = openProjectPersistence(projectRoot);
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
  const persistence = openProjectPersistence(projectRoot);
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

export function formatPairConfirmation(sessions: readonly { id: string; title: string; model: { providerId: string; modelId: string } }[]): string {
  return ["Position | Role | Title | Session ID | Model", ...sessions.map((session, index) => `${index + 1} | ${roleProfiles[index]?.role ?? "unknown"} | ${session.title} | ${session.id.slice(0, 8)} | ${session.model.providerId}/${session.model.modelId}`)].join("\n");
}

export function ensureLoopbackBypassesProxy(loopbackOrigin: string): void {
  const hostname = new URL(loopbackOrigin).hostname;
  if (hostname !== "127.0.0.1" && hostname !== "::1" && hostname !== "localhost") return;
  const existing = (process.env.NO_PROXY ?? process.env.no_proxy ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  const targets = ["127.0.0.1", "localhost", "::1"];
  const merged = Array.from(new Set([...existing, ...targets]));
  const value = merged.join(",");
  process.env.NO_PROXY = value;
  process.env.no_proxy = value;
}

async function runConfiguredUi(options: UiCommandOptions): Promise<void> {
  const projectRoot = await resolveCanonicalProjectRoot(process.cwd());
  const requestedOrigin = validateLoopbackOpenCodeOrigin(options.server ?? process.env.OPENCODE_SERVER_URL ?? "http://127.0.0.1:4096");
  const connection = await resolveOpenCodeConnectionConfig({ baseUrl: requestedOrigin });
  const opencodeOrigin = validateLoopbackOpenCodeOrigin(connection.baseUrl);
  ensureLoopbackBypassesProxy(opencodeOrigin);
  const launcher = await startLauncherUi({
    projectRoot,
    opencodeOrigin,
    adapter: new RealOpenCodeAdapter({ ...connection, baseUrl: opencodeOrigin }),
    version: getVersion()
  });
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await launcher.stop();
  };
  process.once("SIGINT", () => { void shutdown().then(() => { process.exitCode = 0; }); });
  process.once("SIGTERM", () => { void shutdown().then(() => { process.exitCode = 0; }); });
  process.stdout.write(`ORCA launcher: ${launcher.url}\n`);
  if (options.open !== false && !openBrowser(launcher.url)) {
    process.stdout.write("Browser launch failed; open the printed URL manually.\n");
  }
  await new Promise<void>(() => {});
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
