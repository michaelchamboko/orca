import { beforeEach, describe, expect, it } from "vitest";

import type { ModelRef, PairedRoster } from "../../src/domain/types.js";
import type { OpenCodeAdapter } from "../../src/integrations/opencode/adapter.js";
import type { DeliveredTask, OpenCodeEvent, OpenCodeSession, SessionStatus } from "../../src/integrations/opencode/types.js";

describe("RosterService", () => {
  let persistence: RecordingPersistence;
  let adapter: RecordingAdapter;
  let service: { pair(): Promise<unknown>; assertCurrent(): Promise<unknown> };

  beforeEach(async () => {
    const { RosterService } = await import("../../src/pairing/roster-service.js");
    persistence = new RecordingPersistence();
    adapter = new RecordingAdapter([1, 2, 3, 4, 5].map((position) => session(`s-${position}`, position)));
    service = new RosterService(adapter, persistence);
  });

  it("pairs exactly five ordered same-repository sessions without changing models", async () => {
    const roster = await service.pair() as { bindings: Array<{ position: number; role: string; model: ModelRef }> };

    expect(roster.bindings.map((binding) => [binding.position, binding.role])).toEqual([
      [1, "orchestrator"],
      [2, "planner"],
      [3, "builder"],
      [4, "reviewer"],
      [5, "tester"]
    ]);
    expect(adapter.modelMutations()).toEqual([]);
  });

  it.each([
    ["duplicate", [session("s-1", 1), session("s-1", 2), session("s-3", 3), session("s-4", 4), session("s-5", 5)]],
    ["missing", [session("s-1", 1), session("s-2", 2), session("s-3", 3), session("s-4", 4)]],
    ["changed", [session("s-1", 1), session("s-2", 2), session("s-3", 6), session("s-4", 4), session("s-5", 5)]],
    ["cross-repository", [session("s-1", 1), session("s-2", 2), { ...session("s-3", 3), projectRoot: "C:/other" }, session("s-4", 4), session("s-5", 5)]]
  ])("rejects %s sessions", async (_caseName, sessions) => {
    adapter.replaceSessions(sessions);

    await expect(service.pair()).rejects.toThrow("exactly five unique sessions");
  });

  it("rejects roster drift when a paired model changes", async () => {
    await service.pair();
    adapter.replaceSession({ ...session("s-3", 3), model: { providerId: "x", modelId: "changed" } });

    await expect(service.assertCurrent()).rejects.toThrow("roster drift");
  });

  it("rejects closed sessions while pairing", async () => {
    adapter.replaceSession({ ...session("s-4", 4), status: "closed" });

    await expect(service.pair()).rejects.toThrow("active sessions");
  });

  it("reports roster drift when a paired session closes", async () => {
    await service.pair();
    adapter.replaceSession({ ...session("s-4", 4), status: "closed" });

    await expect(service.assertCurrent()).rejects.toThrow("roster drift");
  });
});

function session(id: string, position: number): OpenCodeSession {
  return {
    id,
    position,
    serverBaseUrl: "http://127.0.0.1:4096",
    projectRoot: "C:/workspace",
    model: { providerId: "openai", modelId: "gpt-5" },
    title: `Session ${position}`,
    status: "idle",
    inFlightToolCalls: 0
  };
}

class RecordingAdapter implements OpenCodeAdapter {
  private sessions: OpenCodeSession[];
  private readonly mutations: ModelRef[] = [];

  constructor(sessions: OpenCodeSession[]) {
    this.sessions = sessions.map(copySession);
  }

  async listSessions(): Promise<OpenCodeSession[]> {
    return this.sessions.map(copySession);
  }

  async deliverTask(sessionId: string, task: DeliveredTask): Promise<void> {
    void sessionId;
    void task;
  }

  async getSessionStatus(sessionId: string): Promise<SessionStatus> {
    void sessionId;
    return { idle: true, inFlightToolCalls: 0 };
  }

  subscribe(listener: (event: OpenCodeEvent) => void): () => void {
    void listener;
    return () => {};
  }

  modelMutations(): readonly ModelRef[] {
    return this.mutations.map((model) => ({ ...model }));
  }

  replaceSession(nextSession: OpenCodeSession): void {
    this.sessions = this.sessions.map((current) => current.id === nextSession.id ? copySession(nextSession) : current);
  }

  replaceSessions(sessions: OpenCodeSession[]): void {
    this.sessions = sessions.map(copySession);
  }
}

class RecordingPersistence {
  private roster: PairedRoster | null = null;

  saveRoster(roster: PairedRoster): void {
    this.roster = roster;
  }

  getCurrentRoster(): PairedRoster | null {
    return this.roster;
  }
}

function copySession(sessionToCopy: OpenCodeSession): OpenCodeSession {
  return { ...sessionToCopy, model: { ...sessionToCopy.model } };
}
