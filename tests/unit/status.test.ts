import { describe, expect, it } from "vitest";

import type { PairedRoster } from "../../src/domain/types.js";
import { FakeOpenCodeAdapter } from "../../src/integrations/opencode/fake.js";
import type { OpenCodeSession } from "../../src/integrations/opencode/types.js";
import { RosterService } from "../../src/pairing/roster-service.js";
import { readRosterStatus } from "../../src/pairing/status.js";

describe("readRosterStatus", () => {
  it("loads the saved roster and reports no drift after live verification", async () => {
    const persistence = new MemoryPersistence();
    const adapter = new FakeOpenCodeAdapter(sessions());
    await new RosterService(adapter, persistence).pair();

    await expect(readRosterStatus(persistence, adapter, true)).resolves.toMatchObject({ drift: "none", controllerRunning: true, roster: expect.objectContaining({ bindings: expect.any(Array) }) });
  });

  it("reports drift when a saved session is no longer active", async () => {
    const persistence = new MemoryPersistence();
    const live = sessions();
    const adapter = new FakeOpenCodeAdapter(live);
    await new RosterService(adapter, persistence).pair();
    const changed = live.map((entry) => entry.id === "s-3" ? { ...entry, status: "closed" } : entry);

    await expect(readRosterStatus(persistence, new FakeOpenCodeAdapter(changed), false)).resolves.toMatchObject({ drift: "detected", controllerRunning: false });
  });

  it("reports unknown only when live verification cannot connect", async () => {
    const persistence = new MemoryPersistence();
    await new RosterService(new FakeOpenCodeAdapter(sessions()), persistence).pair();
    const unavailable = { listSessions: async (): Promise<OpenCodeSession[]> => { throw new Error("network unavailable"); } };

    await expect(readRosterStatus(persistence, unavailable, false)).resolves.toMatchObject({ drift: "unknown" });
  });
});

class MemoryPersistence {
  private roster: PairedRoster | null = null;
  saveRoster(roster: PairedRoster): void { this.roster = roster; }
  getCurrentRoster(): PairedRoster | null { return this.roster; }
}

function sessions(): OpenCodeSession[] {
  return [1, 2, 3, 4, 5].map((position) => ({ id: `s-${position}`, position, serverBaseUrl: "http://example.test", projectRoot: "C:/repo", model: { providerId: "openai", modelId: "gpt-5" }, title: `Session ${position}`, status: "idle", inFlightToolCalls: 0 }));
}
