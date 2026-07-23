import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqlitePersistence } from "../../src/persistence/sqlite.js";
import { createControlledCheckExecutor, enqueueCheckIntents } from "../../src/controller/test-runner.js";
import type { OrcaConfig } from "../../src/config/orca-config.js";
import type { PairedRoster } from "../../src/domain/types.js";

const roots: string[] = [];
const stores: SqlitePersistence[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "orca-runner-"));
  roots.push(root);
  const persistence = new SqlitePersistence({ path: join(root, "state.sqlite") });
  stores.push(persistence);
  const roster: PairedRoster = {
    rosterId: "roster-1",
    fingerprint: "fp",
    serverBaseUrl: "http://127.0.0.1:4096",
    projectRoot: root,
    pairedAt: "2025-01-01T00:00:00.000Z",
    bindings: []
  };
  persistence.saveRoster(roster);
  persistence.createMission({ missionId: "mission-1", rosterId: roster.rosterId, objective: "test", sourceSessionMessageId: "src", state: "awaiting_test_approval" });
  return { root, persistence };
}

describe("createControlledCheckExecutor", () => {
  it("executes configured checks sequentially and persists results", async () => {
    const { root, persistence } = setup();
    const config: OrcaConfig = {
      schemaVersion: "1.0",
      checks: [
        { name: "node-pass", executable: "node", args: ["-e", "process.exit(0)"], timeoutMs: 5_000 },
        { name: "node-fail", executable: "node", args: ["-e", "process.exit(1)"], timeoutMs: 5_000 }
      ]
    };
    enqueueCheckIntents(persistence, "mission-1", config, "config-hash");
    const executor = createControlledCheckExecutor({ persistence, config, cwd: root });

    let processed = 0;
    while (processed < config.checks.length) {
      const count = await executor.execute("runner");
      if (count === 0) break;
      processed += count;
    }

    const results = persistence.listCheckResults("mission-1");
    expect(results.map((r) => r.checkName)).toEqual(["node-pass", "node-fail"]);
    expect(results.find((r) => r.checkName === "node-pass")?.status).toBe("passed");
    expect(results.find((r) => r.checkName === "node-fail")?.status).toBe("failed");
  });

  it("enforces a 64 KiB output cap and marks truncated", async () => {
    const { root, persistence } = setup();
    const config: OrcaConfig = {
      schemaVersion: "1.0",
      checks: [
        { name: "noise", executable: "node", args: ["-e", "process.stdout.write('x'.repeat(200_000))"], timeoutMs: 5_000 }
      ]
    };
    enqueueCheckIntents(persistence, "mission-1", config, "config-hash");
    const executor = createControlledCheckExecutor({ persistence, config, cwd: root });
    await executor.execute("runner");
    const [result] = persistence.listCheckResults("mission-1");
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(64 * 1024);
  });
});