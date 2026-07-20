import { describe, expect, test } from "vitest";

import { buildCliProgram } from "../../src/cli/main.js";

async function expectNotConfigured(argv: string[]): Promise<void> {
  const program = buildCliProgram();
  program.exitOverride();

  await expect(
    program.parseAsync(["node", "swarmctl", ...argv], { from: "node" })
  ).rejects.toMatchObject({ code: "ORCA_NOT_CONFIGURED" });
}

describe("buildCliProgram", () => {
  test("registers every public command path with an honest unconfigured failure", async () => {
    const program = buildCliProgram();

    expect(program.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(["doctor", "pair", "status", "controller"])
    );
    expect(program.commands.find((command) => command.name() === "controller")?.commands.map((command) => command.name())).toContain("start");

    await expectNotConfigured(["pair", "--server", "http://127.0.0.1:4096"]);
    await expectNotConfigured(["status"]);
    await expectNotConfigured(["controller", "start"]);
  });

  test("rejects unknown commands with a nonzero Commander error", async () => {
    const program = buildCliProgram();
    program.exitOverride();

    await expect(
      program.parseAsync(["node", "swarmctl", "missing-command"], { from: "node" })
    ).rejects.toMatchObject({ code: "commander.unknownCommand", exitCode: 1 });
  });
});
