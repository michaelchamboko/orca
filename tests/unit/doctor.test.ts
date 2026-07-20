import { describe, expect, it } from "vitest";

import { runDoctor } from "../../src/cli/doctor.js";

describe("runDoctor", () => {
  it("reports safe connection diagnostics without credential or session-content leakage", async () => {
    const lines: string[] = [];

    await runDoctor({
      adapter: {
        health: async () => ({ healthy: true, version: "1.18.3" }),
        listSessions: async () => [{ id: "session-1", position: 1, serverBaseUrl: "http://127.0.0.1:4096", projectRoot: "C:/workspace", model: { providerId: "openai", modelId: "gpt-5" }, title: "contains-secret-session-content", status: "idle", inFlightToolCalls: 0 }]
      },
      cliVersion: "0.1.0",
      repositoryPath: "C:/workspace",
      sqliteAvailable: true,
      roleProfilesAvailable: true,
      write: (line) => lines.push(line)
    });

    expect(lines.join("\n")).toContain("CLI version: 0.1.0");
    expect(lines.join("\n")).toContain("OpenCode version: 1.18.3");
    expect(lines.join("\n")).toContain("Repository path: C:/workspace");
    expect(lines.join("\n")).toContain("Session count: 1");
    expect(lines.join("\n")).toContain("SQLite native binding: available");
    expect(lines.join("\n")).toContain("Role profiles: available");
    expect(lines.join("\n")).not.toContain("contains-secret-session-content");
  });

  it("turns a 401 into an actionable authentication message", async () => {
    await expect(
      runDoctor({
        adapter: {
          health: async () => { throw Object.assign(new Error("OpenCode authentication failed"), { status: 401 }); },
          listSessions: async () => []
        },
        cliVersion: "0.1.0",
        repositoryPath: "C:/workspace",
        sqliteAvailable: true,
        roleProfilesAvailable: true,
        write: () => undefined
      })
    ).rejects.toThrow(/OPENCODE_SERVER_PASSWORD/i);
  });
});
