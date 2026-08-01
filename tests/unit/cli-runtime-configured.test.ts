import { beforeEach, describe, expect, test, vi } from "vitest";

import { OpenCodeHttpError } from "../../src/integrations/opencode/real.js";

const resolveOpenCodeConnectionConfig = vi.fn();
const startController = vi.fn();
const stopController = vi.fn();
const controllerStatus = vi.fn();
const readControllerRuntime = vi.fn();
const selectFiveSessions = vi.fn();
const installRoleProfiles = vi.fn();
const requireVerifiedRoleProfileActivation = vi.fn();
const rosterServicePairSelected = vi.fn();
const readRosterStatus = vi.fn();
const formatRosterStatus = vi.fn();
const adapterHealth = vi.fn();
const adapterListSessions = vi.fn();
const sqliteCurrentRoster = vi.fn();

const sqliteInstances: Array<{ close: ReturnType<typeof vi.fn>; getCurrentRoster: ReturnType<typeof vi.fn> }> = [];
let nextReadlineAnswer = "y";
let capturedPromptLines: string[] = [];

vi.mock("../../src/config/opencode-auth.js", () => ({
  resolveOpenCodeConnectionConfig: (...args: unknown[]) => resolveOpenCodeConnectionConfig(...args)
}));

vi.mock("../../src/integrations/opencode/real.js", () => ({
  OpenCodeHttpError: class OpenCodeHttpError extends Error {
    public readonly status: number;
    public constructor(status: number, path: string) {
      super(status === 401 ? "OpenCode authentication failed (401). Check OPENCODE_SERVER_USERNAME and OPENCODE_SERVER_PASSWORD." : `OpenCode request to ${path} failed with HTTP ${status}.`);
      this.name = "OpenCodeHttpError";
      this.status = status;
    }
  },
  OpenCodeTimeoutError: class OpenCodeTimeoutError extends Error {
    public constructor() {
      super("OpenCode request timed out. Verify that the server is reachable and responsive.");
      this.name = "OpenCodeTimeoutError";
    }
  },
  RealOpenCodeAdapter: class {
    public readonly connection: { baseUrl: string; username: string; password: string };

    public constructor(connection: { baseUrl: string; username: string; password: string }) {
      this.connection = connection;
    }

    public async health(): Promise<Awaited<ReturnType<typeof adapterHealth>>> {
      return adapterHealth();
    }

    public async listSessions(): Promise<Awaited<ReturnType<typeof adapterListSessions>>> {
      return adapterListSessions();
    }
  }
}));

vi.mock("../../src/persistence/sqlite.js", () => ({
  SqlitePersistence: class {
    public close = vi.fn();
    public getCurrentRoster = sqliteCurrentRoster;

    public constructor() {
      sqliteInstances.push({ close: this.close, getCurrentRoster: this.getCurrentRoster });
    }
  }
}));

vi.mock("../../src/persistence/project.js", () => ({
  openProjectPersistence: () => new (class {
    public close = vi.fn();
    public getCurrentRoster = sqliteCurrentRoster;

    public constructor() {
      sqliteInstances.push({ close: this.close, getCurrentRoster: this.getCurrentRoster });
    }
  })()
}));

vi.mock("../../src/launcher/browser.js", () => ({
  openBrowser: vi.fn(() => true)
}));

vi.mock("../../src/launcher/project.js", () => ({
  resolveCanonicalProjectRoot: async () => process.cwd(),
  validateLoopbackOpenCodeOrigin: (value: string) => value.replace(/\/+$/, "")
}));

vi.mock("../../src/launcher/server.js", () => ({
  startLauncherUi: vi.fn(async () => ({
    url: "http://127.0.0.1:4500/#nonce=test",
    origin: "http://127.0.0.1:4500",
    stop: vi.fn()
  }))
}));

vi.mock("../../src/roles/installer.js", () => ({
  installRoleProfiles: (...args: unknown[]) => installRoleProfiles(...args)
}));

vi.mock("../../src/roles/activation.js", () => ({
  requireVerifiedRoleProfileActivation: (...args: unknown[]) => requireVerifiedRoleProfileActivation(...args)
}));

vi.mock("../../src/pairing/roster-service.js", () => ({
  RosterService: class {
    public async pairSelected(selected: unknown) {
      return rosterServicePairSelected(selected);
    }
  }
}));

vi.mock("../../src/pairing/interactive.js", () => ({
  selectFiveSessions: (...args: unknown[]) => selectFiveSessions(...args)
}));

vi.mock("../../src/pairing/status.js", () => ({
  readRosterStatus: (...args: unknown[]) => readRosterStatus(...args),
  formatRosterStatus: (...args: unknown[]) => formatRosterStatus(...args)
}));

vi.mock("../../src/controller/main.js", () => ({
  startController: (...args: unknown[]) => startController(...args),
  stopController: (...args: unknown[]) => stopController(...args),
  controllerStatus: (...args: unknown[]) => controllerStatus(...args)
}));

vi.mock("../../src/controller/runtime.js", () => ({
  readControllerRuntime: (...args: unknown[]) => readControllerRuntime(...args)
}));

vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question: async (question: string): Promise<string> => {
      capturedPromptLines.push(question);
      return nextReadlineAnswer;
    },
    close: vi.fn()
  })
}));

import { buildCliProgram } from "../../src/cli/main.js";

const selectedSessions = [
  { id: "abcdefghijk", title: "Orchestrator tab", model: { providerId: "openai", modelId: "gpt-5" } },
  { id: "plannersess", title: "Planner tab", model: { providerId: "openai", modelId: "gpt-5-mini" } },
  { id: "buildersession", title: "Builder tab", model: { providerId: "openai", modelId: "gpt-5-mini" } },
  { id: "reviewersession", title: "Reviewer tab", model: { providerId: "openai", modelId: "gpt-5-mini" } },
  { id: "testersession", title: "Tester tab", model: { providerId: "openai", modelId: "gpt-5-mini" } }
];

function captureStdoutWrites(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  return {
    writes,
    restore: () => spy.mockRestore()
  };
}

function parseCommand(argv: string[]): Promise<void> {
  const program = buildCliProgram();
  return program.parseAsync(["node", "swarmctl", ...argv], { from: "node" }).then(() => undefined);
}

function resetMocks(): void {
  sqliteInstances.length = 0;
  capturedPromptLines = [];
  nextReadlineAnswer = "y";
  vi.clearAllMocks();

  resolveOpenCodeConnectionConfig.mockImplementation(async (options: { baseUrl?: string } | undefined) => ({
    baseUrl: options?.baseUrl ?? "http://127.0.0.1:4096",
    username: "operator",
    password: "secret-password"
  }));
  startController.mockResolvedValue({
    address: { host: "127.0.0.1", port: 4321 },
    stop: vi.fn()
  });
  stopController.mockResolvedValue(true);
  controllerStatus.mockResolvedValue({ running: false, opencodeHealthy: false, bindingCount: 0, bindingsCurrent: false });
  readControllerRuntime.mockReturnValue({ running: false });
  selectFiveSessions.mockResolvedValue(selectedSessions);
  installRoleProfiles.mockReturnValue({ roles: "ok" });
  requireVerifiedRoleProfileActivation.mockImplementation(() => undefined);
  rosterServicePairSelected.mockResolvedValue({ rosterId: "roster-1" });
  readRosterStatus.mockResolvedValue({ text: "no roster" });
  formatRosterStatus.mockImplementation((status: unknown) => `ROSTER:${JSON.stringify(status)}`);
  adapterHealth.mockResolvedValue({});
  adapterListSessions.mockResolvedValue(selectedSessions);
  sqliteCurrentRoster.mockReturnValue(null);
}

describe("configured command runtime", () => {
  beforeEach(() => {
    resetMocks();
  });

  test("starts controller in foreground and prints local endpoint", async () => {
    const { writes, restore } = captureStdoutWrites();
    sqliteCurrentRoster.mockReturnValue({ rosterId: "current", serverBaseUrl: "http://10.0.0.1:7000", projectRoot: "/project" });

    await parseCommand(["controller", "start"]);

    expect(startController).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: expect.any(String),
        version: expect.any(String),
        adapter: expect.objectContaining({
          connection: expect.objectContaining({
            baseUrl: "http://10.0.0.1:7000",
            username: "operator",
            password: "secret-password"
          })
        })
      })
    );
    expect(writes.join("" )).toContain("Controller started at");
    expect(sqliteInstances).toHaveLength(1);
    expect(sqliteInstances[0]?.close).not.toHaveBeenCalled();
    restore();
  });

  test("closes persistence when controller start fails", async () => {
    startController.mockRejectedValue(new Error("failed to bind port"));
    const { writes, restore } = captureStdoutWrites();

    await expect(parseCommand(["controller", "start"])).rejects.toThrow("failed to bind port");

    expect(sqliteInstances).toHaveLength(1);
    expect(sqliteInstances[0]?.close).toHaveBeenCalledOnce();
    expect(writes.join("" )).not.toContain("Controller started at");
    restore();
  });

  test("reports controller stop state", async () => {
    stopController.mockResolvedValue(false);
    const { writes, restore } = captureStdoutWrites();

    await parseCommand(["controller", "stop"]);

    expect(stopController).toHaveBeenCalledWith(process.cwd());
    expect(writes.join("" )).toContain("No running controller; stale runtime state cleared");
    restore();
  });

  test("writes detailed running controller status", async () => {
    controllerStatus.mockResolvedValue({
      running: true,
      opencodeHealthy: false,
      bindingCount: 4,
      bindingsCurrent: false
    });
    const { writes, restore } = captureStdoutWrites();

    await parseCommand(["controller", "status"]);

    expect(controllerStatus).toHaveBeenCalledWith(process.cwd());
    expect(writes.join("" )).toContain("Controller: running");
    expect(writes.join("" )).toContain("OpenCode: unhealthy");
    expect(writes.join("" )).toContain("Bindings: drift detected");
    restore();
  });

  test("pairs five sessions when confirmation is accepted", async () => {
    const { writes, restore } = captureStdoutWrites();

    await parseCommand(["pair", "--server", "http://127.0.0.1:4096"]);

    expect(selectFiveSessions).toHaveBeenCalledWith(
      selectedSessions,
      process.cwd(),
      expect.any(Function),
      expect.any(Function)
    );
    expect(rosterServicePairSelected).toHaveBeenCalledWith(selectedSessions);
    expect(writes.join("" )).toContain("Paired roster roster-1");
    expect(capturedPromptLines.some((question) => question.includes("Confirm this exact roster"))).toBe(true);
    restore();
  });

  test("does not persist pairing when confirmation is rejected", async () => {
    nextReadlineAnswer = "n";
    const { writes, restore } = captureStdoutWrites();

    await expect(
      parseCommand(["pair", "--server", "http://127.0.0.1:4096"])
    ).rejects.toThrow("pairing cancelled");

    expect(rosterServicePairSelected).not.toHaveBeenCalled();
    expect(capturedPromptLines.some((line) => line.includes("Confirm this exact roster"))).toBe(true);
    expect(writes.join("" )).not.toContain("Paired roster");
    restore();
  });

  test("reports current status using roster/controller runtime inputs", async () => {
    sqliteCurrentRoster.mockReturnValue({
      rosterId: "roster-1",
      serverBaseUrl: "http://10.0.0.1:7000",
      projectRoot: "/project"
    });
    readControllerRuntime.mockReturnValue({ running: true });
    readRosterStatus.mockResolvedValue({ rosterId: "roster-1", bindings: 5 });
    formatRosterStatus.mockImplementation((status: unknown) => `FORMATTED:${JSON.stringify(status)}`);
    const { writes, restore } = captureStdoutWrites();

    await parseCommand(["status"]);

    expect(readControllerRuntime).toHaveBeenCalledWith(process.cwd());
    expect(readRosterStatus).toHaveBeenCalled();
    expect(writes.join("" )).toContain("FORMATTED:");
    restore();
  });

  test("ui command rejects when preflight fetch fails and does not start the launcher", async () => {
    const { startLauncherUi: startLauncherUiMock } = await import("../../src/launcher/server.js");
    const { openBrowser: openBrowserMock } = await import("../../src/launcher/browser.js");
    adapterHealth.mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:59711"));
    const { writes, restore } = captureStdoutWrites();

    await expect(parseCommand(["ui", "--server", "http://127.0.0.1:59711"])).rejects.toThrow("OPENCODE_UNAVAILABLE");

    expect(writes.join("" )).not.toContain("ORCA launcher:");
    expect(startLauncherUiMock).not.toHaveBeenCalled();
    expect(openBrowserMock).not.toHaveBeenCalled();
    restore();
  });

  test("ui command rejects on healthy=false without starting the launcher", async () => {
    const { startLauncherUi: startLauncherUiMock } = await import("../../src/launcher/server.js");
    adapterHealth.mockResolvedValue({ healthy: false, version: "1.18.3" });

    await expect(parseCommand(["ui", "--server", "http://127.0.0.1:59711"])).rejects.toThrow("OPENCODE_UNAVAILABLE");

    expect(startLauncherUiMock).not.toHaveBeenCalled();
  });

  test("ui command rejects on timeout without starting the launcher", async () => {
    const { startLauncherUi: startLauncherUiMock } = await import("../../src/launcher/server.js");
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    adapterHealth.mockRejectedValue(abortError);

    await expect(parseCommand(["ui", "--server", "http://127.0.0.1:59711"])).rejects.toThrow("OPENCODE_UNAVAILABLE");

    expect(startLauncherUiMock).not.toHaveBeenCalled();
  });

  test("ui command preserves the HTTP 401 authentication diagnostic", async () => {
    const { startLauncherUi: startLauncherUiMock } = await import("../../src/launcher/server.js");
    adapterHealth.mockRejectedValue(new OpenCodeHttpError(401, "/global/health"));

    await expect(parseCommand(["ui", "--server", "http://127.0.0.1:59711"])).rejects.toThrow(/authentication failed/i);

    expect(startLauncherUiMock).not.toHaveBeenCalled();
  });

  test("ui command starts the launcher only after a healthy preflight", async () => {
    const launcherModule = await import("../../src/launcher/server.js");
    const startLauncherUiMock = vi.mocked(launcherModule.startLauncherUi);
    let resolveStart: ((value: unknown) => void) | undefined;
    startLauncherUiMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStart = () => resolve({ app: {} as never, url: "http://127.0.0.1:4500/#nonce=test", origin: "http://127.0.0.1:4500", stop: vi.fn() });
        })
    );
    adapterHealth.mockResolvedValue({ healthy: true, version: "1.18.3" });
    const { restore } = captureStdoutWrites();

    const pending = parseCommand(["ui", "--server", "http://127.0.0.1:59711", "--no-open"]);
    for (let i = 0; i < 10 && !startLauncherUiMock.mock.calls.length; i += 1) {
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
    }
    expect(adapterHealth).toHaveBeenCalled();
    expect(startLauncherUiMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: expect.any(String),
        opencodeOrigin: "http://127.0.0.1:59711",
        adapter: expect.objectContaining({
          connection: expect.objectContaining({ baseUrl: "http://127.0.0.1:59711" })
        })
      })
    );
    resolveStart?.(undefined);
    pending.catch(() => undefined);
    restore();
  });
});
