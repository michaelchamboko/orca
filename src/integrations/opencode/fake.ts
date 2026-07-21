import type { OpenCodeLiveAdapter } from "./adapter.js";
import type { ModelRef } from "../../domain/types.js";
import type {
  DeliveredTask,
  OpenCodeEvent,
  OpenCodeMessage,
  OpenCodeSession,
  SessionPrompt,
  SessionStatus
} from "./types.js";

export interface Delivery extends DeliveredTask {
  sessionId: string;
}

export class FakeOpenCodeAdapter implements OpenCodeLiveAdapter {
  private readonly sessions = new Map<string, OpenCodeSession>();
  private readonly messages = new Map<string, OpenCodeMessage>();
  private readonly deliveryLog: Delivery[] = [];
  private readonly promptLog: SessionPrompt[] = [];
  private readonly listeners = new Set<(event: OpenCodeEvent) => void>();

  constructor(sessions: readonly OpenCodeSession[], messages: readonly OpenCodeMessage[] = []) {
    for (const session of sessions) {
      this.sessions.set(session.id, copySession(session));
    }
    for (const message of messages) this.messages.set(message.id, copyMessage(message));
  }

  async health(): Promise<{ healthy: boolean }> {
    return { healthy: true };
  }

  async listSessions(projectRoot?: string): Promise<OpenCodeSession[]> {
    void projectRoot;
    return [...this.sessions.values()].map(copySession);
  }

  async getSessionModel(sessionId: string): Promise<ModelRef> {
    return { ...this.requireSession(sessionId).model };
  }

  async listMessages(sessionId: string, limit?: number): Promise<OpenCodeMessage[]> {
    this.requireSession(sessionId);
    const messages = [...this.messages.values()].filter((message) => message.sessionId === sessionId);
    return (limit === undefined ? messages : messages.slice(0, limit)).map(copyMessage);
  }

  async getMessage(sessionId: string, messageId: string): Promise<OpenCodeMessage> {
    this.requireSession(sessionId);
    const message = this.messages.get(messageId);
    if (!message || message.sessionId !== sessionId) throw new Error(`unknown OpenCode message: ${messageId}`);
    return copyMessage(message);
  }

  async sendPrompt(input: SessionPrompt): Promise<void> {
    this.requireSession(input.sessionId);
    this.promptLog.push({ ...input, model: { ...input.model } });
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

  async *subscribeEvents(signal: AbortSignal): AsyncIterable<OpenCodeEvent> {
    const events: OpenCodeEvent[] = [];
    const stop = this.subscribe((event) => events.push(event));
    try {
      while (!signal.aborted) {
        const event = events.shift();
        if (event) {
          yield event;
          continue;
        }
        await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 1));
      }
    } finally {
      stop();
    }
  }

  emit(event: OpenCodeEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  deliveries(): readonly Delivery[] {
    return this.deliveryLog.map((delivery) => ({ ...delivery }));
  }

  prompts(): readonly SessionPrompt[] {
    return this.promptLog.map((prompt) => ({ ...prompt, model: { ...prompt.model } }));
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

function copyMessage(message: OpenCodeMessage): OpenCodeMessage {
  return { ...message, parts: message.parts.map((part) => ({ ...part })) };
}
