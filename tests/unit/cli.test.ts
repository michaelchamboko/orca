import { describe, expect, test } from "vitest";

import { buildCliProgram, formatPairConfirmation } from "../../src/cli/main.js";

async function expectCredentialGate(argv: string[]): Promise<void> {
  const program = buildCliProgram();
  program.exitOverride();

  await expect(
    program.parseAsync(["node", "swarmctl", ...argv], { from: "node" })
  ).rejects.toThrow("credentials are unavailable");
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

  test("prints role, title, short session ID, and model before confirmation", () => {
    expect(formatPairConfirmation([
      { id: "abcdefghijk", title: "Orchestrator tab", model: { providerId: "openai", modelId: "gpt-5" } },
      { id: "plannersess", title: "Planner tab", model: { providerId: "anthropic", modelId: "claude" } }
    ])).toContain("1 | orchestrator | Orchestrator tab | abcdefgh | openai/gpt-5");
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
