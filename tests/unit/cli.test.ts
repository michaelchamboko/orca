import { describe, expect, test } from "vitest";

import { buildCliProgram } from "../../src/cli/main.js";

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
    expect(program.commands.find((command) => command.name() === "controller")?.commands.map((command) => command.name())).toContain("start");

    await expectCredentialGate(["pair", "--server", "http://127.0.0.1:4096"]);
    const controller = buildCliProgram();
    controller.exitOverride();
    await expect(controller.parseAsync(["node", "swarmctl", "controller", "start"], { from: "node" })).rejects.toMatchObject({ code: "ORCA_NOT_CONFIGURED" });
  });

  test("rejects unknown commands with a nonzero Commander error", async () => {
    const program = buildCliProgram();
    program.exitOverride();

    await expect(
      program.parseAsync(["node", "swarmctl", "missing-command"], { from: "node" })
    ).rejects.toMatchObject({ code: "commander.unknownCommand", exitCode: 1 });
  });
});
