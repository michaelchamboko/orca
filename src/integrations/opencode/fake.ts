import type { OpenCodeAdapter } from "./adapter.js";
import type {
  DeliveredTask,
  OpenCodeEvent,
  OpenCodeSession,
  SessionStatus
} from "./types.js";

export interface Delivery extends DeliveredTask {
  sessionId: string;
}

export class FakeOpenCodeAdapter implements OpenCodeAdapter {
  private readonly sessions = new Map<string, OpenCodeSession>();
  private readonly deliveryLog: Delivery[] = [];
  private readonly listeners = new Set<(event: OpenCodeEvent) => void>();

  constructor(sessions: readonly OpenCodeSession[]) {
    for (const session of sessions) {
      this.sessions.set(session.id, copySession(session));
    }
  }

  async listSessions(): Promise<OpenCodeSession[]> {
    return [...this.sessions.values()].map(copySession);
  }

  async deliverTask(sessionId: string, task: DeliveredTask): Promise<void> {
    this.requireSession(sessionId);
    this.deliveryLog.push({ sessionId, ...task });
  }

  async getSessionStatus(sessionId: string): Promise<SessionStatus> {
    const session = this.requireSession(sessionId);

    return {
      idle: session.status === "idle",
      inFlightToolCalls: session.inFlightToolCalls
    };
  }

  subscribe(listener: (event: OpenCodeEvent) => void): () => void {
    this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  emit(event: OpenCodeEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  deliveries(): readonly Delivery[] {
    return this.deliveryLog.map((delivery) => ({ ...delivery }));
  }

  private requireSession(sessionId: string): OpenCodeSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`unknown OpenCode session: ${sessionId}`);
    }

    return session;
  }
}

function copySession(session: OpenCodeSession): OpenCodeSession {
  return {
    ...session,
    model: { ...session.model }
  };
}
