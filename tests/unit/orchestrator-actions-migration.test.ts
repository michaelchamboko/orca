import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqlitePersistence } from "../../src/persistence/sqlite.js";

const roots: string[] = [];
const stores: SqlitePersistence[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("orchestrator actions migration", () => {
  it("accepts the current schema version", () => {
    const root = mkdtempSync(join(tmpdir(), "orca-migration-"));
    roots.push(root);
    const path = join(root, "state.sqlite");
    const persistence = new SqlitePersistence({ path });
    stores.push(persistence);
    persistence.saveMission("mission-1", "planning", { objective: "objective" });
    expect(persistence.getMissionCount()).toBe(1);
  });

  it("records an orchestrator action message and dedupes on duplicate", () => {
    const root = mkdtempSync(join(tmpdir(), "orca-migration-"));
    roots.push(root);
    const path = join(root, "state.sqlite");
    const persistence = new SqlitePersistence({ path });
    stores.push(persistence);
    persistence.saveMission("mission-1", "planning", { objective: "objective" });
    const first = persistence.recordOrchestratorActionMessage({
      missionId: "mission-1",
      messageId: "approval-1",
      sessionId: "session-1",
      parentMessageId: "decision-prompt",
      decisionPromptMessageId: "decision-prompt",
      rawPayload: "{}",
      parsedPayload: { action: "approve" },
      action: "approve",
      taskId: "task-1"
    });
    expect(first.id).toBeGreaterThan(0);
    const second = persistence.recordOrchestratorActionMessage({
      missionId: "mission-1",
      messageId: "approval-1",
      sessionId: "session-1",
      parentMessageId: "decision-prompt",
      decisionPromptMessageId: "decision-prompt",
      rawPayload: "{}",
      parsedPayload: { action: "approve" },
      action: "approve",
      taskId: "task-1"
    });
    expect(second.id).toBe(0);
  });
});
