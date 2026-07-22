import { describe, expect, test } from "vitest";

import { buildCliProgram, formatPairConfirmation } from "../../src/cli/main.js";

const CREDENTIAL_ENV_VARS = ["OPENCODE_SERVER_PASSWORD", "OPENCODE_SERVER_USERNAME", "OPENCODE_SERVER_URL"] as const;

function withoutCredentials<T>(fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const key of CREDENTIAL_ENV_VARS) {
    previous.set(key, process.env[key]);
    Reflect.deleteProperty(process.env, key);
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }
}

async function expectCredentialGate(argv: string[]): Promise<void> {
  await withoutCredentials(async () => {
    const program = buildCliProgram();
    program.exitOverride();

    await expect(
      program.parseAsync(["node", "swarmctl", ...argv], { from: "node" })
    ).rejects.toThrow("credentials are unavailable");
  });
}

describe("buildCliProgram", () => {
  test("registers every public command path and gates live pairing on credentials", async () => {
    const program = buildCliProgram();

    expect(program.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(["doctor", "pair", "status", "controller"])
    );
    expect(program.commands.find((command) => command.name() === "controller")?.commands.map((command) => command.name())).toEqual(expect.arrayContaining(["start", "stop", "status"]));

    await expectCredentialGate(["pair", "--server", "http://127.0.0.1:4096"]);
    await expectCredentialGate(["controller", "start"]);
  });

  test("rejects unknown commands with a nonzero Commander error", async () => {
    const program = buildCliProgram();
    program.exitOverride();

    await expect(
      program.parseAsync(["node", "swarmctl", "missing-command"], { from: "node" })
    ).rejects.toMatchObject({ code: "commander.unknownCommand", exitCode: 1 });
  });

  test("prints the user-selected paired models before confirmation", () => {
    const confirmation = formatPairConfirmation([
      { id: "abcdefghijk", title: "Orchestrator tab", model: { providerId: "openai", modelId: "gpt-5" } },
      { id: "plannersess", title: "Planner tab", model: { providerId: "opencode", modelId: "north-mini-code-free" } }
    ]);

    expect(confirmation).toContain("1 | orchestrator | Orchestrator tab | abcdefgh | openai/gpt-5");
    expect(confirmation).toContain("2 | planner | Planner tab | planners | opencode/north-mini-code-free");
  });

  test("routes all controller lifecycle commands to configured handlers", async () => {
    const calls: string[] = [];
    const program = buildCliProgram({
      controllerStart: async () => { calls.push("start"); },
      controllerStop: async () => { calls.push("stop"); },
      controllerStatus: async () => { calls.push("status"); }
    });

    await program.parseAsync(["node", "swarmctl", "controller", "start"], { from: "node" });
    await program.parseAsync(["node", "swarmctl", "controller", "stop"], { from: "node" });
    await program.parseAsync(["node", "swarmctl", "controller", "status"], { from: "node" });

    expect(calls).toEqual(["start", "stop", "status"]);
  });
});
