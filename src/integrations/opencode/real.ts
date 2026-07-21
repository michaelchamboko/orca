import type { ModelRef } from "../../domain/types.js";
import type { OpenCodeLiveAdapter } from "./adapter.js";
import type { DeliveredTask, OpenCodeEvent, OpenCodeSession, SessionPrompt, SessionStatus } from "./types.js";

export interface RealOpenCodeAdapterConfig {
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs?: number;
}

export class OpenCodeHttpError extends Error {
  constructor(public readonly status: number, path: string) {
    super(status === 401 ? "OpenCode authentication failed (401). Check OPENCODE_SERVER_USERNAME and OPENCODE_SERVER_PASSWORD." : `OpenCode request to ${path} failed with HTTP ${status}.`);
    this.name = "OpenCodeHttpError";
  }
}

export class OpenCodeTimeoutError extends Error {
  constructor() {
    super("OpenCode request timed out. Verify that the server is reachable and responsive.");
    this.name = "OpenCodeTimeoutError";
  }
}

export class RealOpenCodeAdapter implements OpenCodeLiveAdapter {
  private readonly baseUrl: string;
  private readonly authorization: string;
  private readonly timeoutMs: number;

  constructor(config: RealOpenCodeAdapterConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;
    this.timeoutMs = config.timeoutMs ?? 5_000;
  }

  async health(): Promise<{ healthy: boolean; version?: string }> {
    return this.json("/global/health") as Promise<{ healthy: boolean; version?: string }>;
  }

  async listSessions(projectRoot?: string): Promise<OpenCodeSession[]> {
    const sessions = await this.json<unknown[]>(pathWithDirectory("/session", projectRoot));
    return sessions.map((session, index) => toSession(session, index, this.baseUrl, projectRoot));
  }

  async getSessionModel(sessionId: string): Promise<ModelRef> {
    return toModel(await this.json<unknown>(`/session/${encodeURIComponent(sessionId)}`));
  }

  async sendPrompt(input: SessionPrompt): Promise<void> {
    const body: Record<string, unknown> = { parts: [{ type: "text", text: input.content }] };
    if (input.agent) body.agent = input.agent;
    if (input.model) body.model = { providerID: input.model.providerId, modelID: input.model.modelId };
    await this.request(`/session/${encodeURIComponent(input.sessionId)}/prompt_async`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  async deliverTask(sessionId: string, task: DeliveredTask): Promise<void> {
    await this.sendPrompt({ sessionId, content: task.content });
  }

  async getSessionStatus(sessionId: string): Promise<SessionStatus> {
    return toStatus((await this.json<Record<string, unknown>>("/session/status"))[sessionId]);
  }

  async *subscribeEvents(signal: AbortSignal): AsyncIterable<OpenCodeEvent> {
    const response = await this.connectEventStream(signal);
    if (!response.body) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventType = "message";
    try {
      while (!signal.aborted) {
        const next = await reader.read();
        if (next.done) return;
        buffer += decoder.decode(next.value, { stream: true });
        let boundary = buffer.indexOf("\n");
        while (boundary >= 0) {
          const line = buffer.slice(0, boundary).replace(/\r$/, "");
          buffer = buffer.slice(boundary + 1);
          boundary = buffer.indexOf("\n");
          if (!line) continue;
          if (line.startsWith("event:")) eventType = line.slice(6).trim();
          if (!line.startsWith("data:")) continue;
          const parsed = JSON.parse(line.slice(5).trim()) as unknown;
          yield toEvent(eventType, parsed);
          eventType = "message";
        }
      }
    } finally {
      await reader.cancel();
    }
  }

  subscribe(listener: (event: OpenCodeEvent) => void): () => void {
    void listener;
    throw new Error("RealOpenCodeAdapter.subscribe is unsupported; use subscribeEvents with an AbortSignal.");
  }

  private async json<T>(path: string): Promise<T> {
    return (await this.request(path)).json() as Promise<T>;
  }

  private async request(path: string, init: RequestInit = {}, externalSignal?: AbortSignal, timeout = true): Promise<Response> {
    const timeoutSignal = timeout ? AbortSignal.timeout(this.timeoutMs) : undefined;
    const signal = externalSignal && timeoutSignal ? AbortSignal.any([externalSignal, timeoutSignal]) : externalSignal ?? timeoutSignal;
    try {
      const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers: { authorization: this.authorization, ...init.headers }, signal });
      if (!response.ok) throw new OpenCodeHttpError(response.status, path);
      return response;
    } catch (error) {
      if (timeoutSignal?.aborted && !externalSignal?.aborted) throw new OpenCodeTimeoutError();
      throw error;
    }
  }

  private async connectEventStream(externalSignal: AbortSignal): Promise<Response> {
    const handshake = new AbortController();
    const timer = globalThis.setTimeout(() => handshake.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/global/event`, {
        headers: { authorization: this.authorization },
        signal: AbortSignal.any([externalSignal, handshake.signal])
      });
      if (!response.ok) throw new OpenCodeHttpError(response.status, "/global/event");
      return response;
    } catch (error) {
      if (handshake.signal.aborted && !externalSignal.aborted) throw new OpenCodeTimeoutError();
      throw error;
    } finally {
      globalThis.clearTimeout(timer);
    }
  }
}

function pathWithDirectory(path: string, directory: string | undefined): string {
  return directory ? `${path}?directory=${encodeURIComponent(directory)}` : path;
}

function toSession(value: unknown, index: number, baseUrl: string, projectRoot?: string): OpenCodeSession {
  const session = object(value);
  return { id: string(session.id), position: (index + 1) as 1 | 2 | 3 | 4 | 5, serverBaseUrl: baseUrl, projectRoot: string(session.directory, projectRoot ?? ""), model: toModel(session), title: string(session.title), status: string(session.status, "idle"), inFlightToolCalls: number(session.inFlightToolCalls), lastActivity: sessionActivity(session) };
}

function sessionActivity(session: Record<string, unknown>): string | undefined {
  const time = object(session.time);
  const value = time.updated ?? time.created;
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return undefined;
}

function toModel(value: unknown): ModelRef {
  const model = object(object(value).model);
  return { providerId: string(model.providerID, string(model.providerId, "unknown")), modelId: string(model.modelID, string(model.modelId, string(model.id, "unknown"))) };
}

function toStatus(value: unknown): SessionStatus {
  const status = object(value);
  const state = string(status.type, string(status.status, "idle"));
  return { idle: state === "idle", inFlightToolCalls: number(status.inFlightToolCalls) };
}

function toEvent(type: string, value: unknown): OpenCodeEvent {
  const event = object(value);
  const properties = object(event.properties);
  const payload = event.value ?? event.properties ?? value;
  return { sessionId: string(event.sessionID, string(event.sessionId, string(properties.sessionID, string(properties.sessionId)))), type: string(event.type, type), payload };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function number(value: unknown): number {
  return typeof value === "number" ? value : 0;
}
