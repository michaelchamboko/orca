import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeOpenCodeAdapter } from "../../src/integrations/opencode/fake.js";
import type { OpenCodeSession } from "../../src/integrations/opencode/types.js";
import { RosterService } from "../../src/pairing/roster-service.js";
import { selectFiveSessions } from "../../src/pairing/interactive.js";
import { installRoleProfiles, roleProfiles } from "../../src/roles/installer.js";
import type { PairedRoster } from "../../src/domain/types.js";

const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

describe("interactive live-session pairing", () => {
  it("installs model-free role profiles with the exact per-role tool grants", () => {
    const workspace = workspacePath();
    const written = installRoleProfiles(workspace);

    expect(written.map((file) => file.content)).toMatchSnapshot();
    for (const file of written) expect(file.content).not.toMatch(/model:/);
    expect(roleProfiles.find((profile) => profile.role === "builder")?.tools).toContain("edit");
    expect(roleProfiles.filter((profile) => profile.role !== "builder").flatMap((profile) => profile.tools)).not.toEqual(expect.arrayContaining(["edit", "bash"]));
    expect(written.every((file) => file.content.includes("structured controller result"))).toBe(true);
  });

  it("lists candidates and pairs explicit sequential selections without changing models", async () => {
    const workspace = workspacePath();
    const sessions = [5, 2, 4, 1, 3, 6].map((number) => session(`session-${number}`, number, workspace));
    const lines: string[] = [];
    const selected = await selectFiveSessions(sessions, workspace, async (prompt) => {
      lines.push(prompt);
      return ["4", "2", "5", "3", "1"][lines.filter((line) => line.startsWith("Session")).length - 1];
    }, (line) => lines.push(line));
    const adapter = new FakeOpenCodeAdapter(sessions);
    const persistence = new MemoryPersistence();
    const service = new RosterService(adapter, persistence);

    const roster = await service.pairSelected(selected);

    expect(lines.some((line) => line.includes("1.") && line.includes("gpt-5"))).toBe(true);
    expect(roster.bindings.map((binding) => [binding.position, binding.role, binding.sessionId, binding.model])).toEqual([
      [1, "orchestrator", "session-1", { providerId: "openai", modelId: "gpt-5" }],
      [2, "planner", "session-2", { providerId: "openai", modelId: "gpt-5" }],
      [3, "builder", "session-3", { providerId: "openai", modelId: "gpt-5" }],
      [4, "reviewer", "session-4", { providerId: "openai", modelId: "gpt-5" }],
      [5, "tester", "session-5", { providerId: "openai", modelId: "gpt-5" }]
    ]);
    expect(persistence.getCurrentRoster()).toEqual(roster);
    expect(adapter.deliveries()).toEqual([]);
  });

  it.each([
    ["duplicate choice", ["1", "1"]],
    ["cancellation", ["cancel"]],
    ["closed session", ["1"]],
    ["missing model", ["1"]],
    ["another repository", ["1"]]
  ])("rejects %s", async (caseName, answers) => {
    const workspace = workspacePath();
    const sessions = [1, 2, 3, 4, 5].map((number) => session(`session-${number}`, number, workspace));
    if (caseName === "closed session") sessions[0] = { ...sessions[0], status: "closed" };
    if (caseName === "missing model") sessions[0] = { ...sessions[0], model: { providerId: "unknown", modelId: "unknown" } };
    if (caseName === "another repository") sessions[0] = { ...sessions[0], projectRoot: "C:/other" };
    let next = 0;

    await expect(selectFiveSessions(sessions, workspace, async () => answers[next++], () => undefined)).rejects.toThrow();
  });

  it("requires at least five candidates but accepts more", async () => {
    const workspace = workspacePath();
    await expect(selectFiveSessions([1, 2, 3, 4].map((number) => session(`session-${number}`, number, workspace)), workspace, async () => "1", () => undefined)).rejects.toThrow("at least five");
  });
});

class MemoryPersistence {
  private roster: PairedRoster | null = null;

  saveRoster(roster: PairedRoster): void { this.roster = roster; }
  getCurrentRoster(): PairedRoster | null { return this.roster; }
}

function workspacePath(): string {
  const value = mkdtempSync(join(tmpdir(), "orca-pair-"));
  workspaces.push(value);
  return value;
}

function session(id: string, number: number, projectRoot: string): OpenCodeSession {
  return { id, position: number, serverBaseUrl: "http://127.0.0.1:4096", projectRoot, model: { providerId: "openai", modelId: "gpt-5" }, title: `Session ${number}`, status: "idle", inFlightToolCalls: 0 };
}
