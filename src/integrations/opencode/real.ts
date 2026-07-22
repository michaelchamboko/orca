import type { ModelRef } from "../../domain/types.js";
import type { OpenCodeLiveAdapter } from "./adapter.js";
import type { DeliveredTask, OpenCodeEvent, OpenCodeMessage, OpenCodeMessagePart, OpenCodeSession, SessionPrompt, SessionStatus } from "./types.js";

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

  async listMessages(sessionId: string, limit?: number): Promise<OpenCodeMessage[]> {
    const path = `/session/${encodeURIComponent(sessionId)}/message${limit === undefined ? "" : `?limit=${encodeURIComponent(limit)}`}`;
    const messages = await this.json<unknown>(path);
    if (!Array.isArray(messages)) throw new OpenCodeEventError("Malformed OpenCode message list response.");
    return messages.map((message) => requireMessageSession(sessionId, toMessage(message)));
  }

  async getMessage(sessionId: string, messageId: string): Promise<OpenCodeMessage> {
    return requireMessageId(messageId, requireMessageSession(sessionId, toMessage(await this.json<unknown>(`/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`))));
  }

  async sendPrompt(input: SessionPrompt): Promise<void> {
    await this.postPrompt(input.sessionId, {
      messageID: input.messageId,
      agent: input.agent,
      model: { providerID: input.model.providerId, modelID: input.model.modelId },
      parts: [{ type: "text", text: input.content }]
    });
  }

  async deliverTask(sessionId: string, task: DeliveredTask): Promise<void> {
    await this.postPrompt(sessionId, { parts: [{ type: "text", text: task.content }] });
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
          let parsed: unknown;
          try {
            parsed = JSON.parse(line.slice(5).trim()) as unknown;
          } catch {
            throw new OpenCodeEventError("Malformed OpenCode global event JSON.");
          }
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

  private async postPrompt(sessionId: string, body: Record<string, unknown>): Promise<void> {
    await this.request(`/session/${encodeURIComponent(sessionId)}/prompt_async`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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

export class OpenCodeEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenCodeEventError";
  }
}

function toStatus(value: unknown): SessionStatus {
  const status = object(value);
  const state = string(status.type, string(status.status, "idle"));
  return { idle: state === "idle", inFlightToolCalls: number(status.inFlightToolCalls) };
}

function toMessage(value: unknown): OpenCodeMessage {
  const message = requireObject(value, "message");
  const info = requireObject(message.info, "message info");
  const role = requireString(info.role, "message role");
  if (role !== "user" && role !== "assistant") throw new OpenCodeEventError("Malformed OpenCode message response: unsupported role.");
  const time = requireObject(info.time, "message time");
  const normalized: OpenCodeMessage = {
    id: requireString(info.id, "message id"),
    sessionId: requireString(info.sessionID, "message sessionID"),
    role,
    createdAt: toTimestamp(time.created, "message created time"),
    parts: requireArray(message.parts, "message parts").map(toMessagePart)
  };
  const parentId = optionalString(info.parentID);
  const completedAt = optionalTimestamp(time.completed, "message completed time");
  if (parentId !== undefined) normalized.parentId = parentId;
  if (completedAt !== undefined) normalized.completedAt = completedAt;
  return normalized;
}

function requireMessageSession(requestedSessionId: string, message: OpenCodeMessage): OpenCodeMessage {
  if (message.sessionId !== requestedSessionId) throw new OpenCodeEventError("Malformed OpenCode message response: sessionID does not match the requested session.");
  return message;
}

function requireMessageId(requestedMessageId: string, message: OpenCodeMessage): OpenCodeMessage {
  if (message.id !== requestedMessageId) throw new OpenCodeEventError("Malformed OpenCode message response: message ID does not match the requested message.");
  return message;
}

function toMessagePart(value: unknown): OpenCodeMessagePart {
  const part = requireObject(value, "message part");
  const normalized: OpenCodeMessagePart = {
    id: requireString(part.id, "message part id"),
    type: requireString(part.type, "message part type")
  };
  const text = optionalString(part.text);
  const toolStatus = optionalToolStatus(object(part.state).status);
  if (text !== undefined) normalized.text = text;
  if (toolStatus !== undefined) normalized.toolStatus = toolStatus;
  return normalized;
}

function toEvent(_eventType: string, value: unknown): OpenCodeEvent {
  const envelope = requireObject(value, "global event envelope");
  const payload = requireObject(envelope.payload, "global event payload");
  const type = requireString(payload.type, "global event type");
  const properties = requireObject(payload.properties, "global event properties");
  const event: OpenCodeEvent = { directory: requireString(envelope.directory, "global event directory"), type, payload: properties };

  switch (type) {
    case "message.updated": {
      const info = requireObject(properties.info, "message.updated info");
      event.sessionId = requireString(info.sessionID, "message.updated sessionID");
      event.messageId = requireString(info.id, "message.updated message id");
      break;
    }
    case "message.part.updated": {
      const part = requireObject(properties.part, "message.part.updated part");
      event.sessionId = requireString(part.sessionID, "message.part.updated sessionID");
      event.messageId = requireString(part.messageID, "message.part.updated messageID");
      break;
    }
    case "session.status":
    case "session.idle":
      event.sessionId = requireString(properties.sessionID, `${type} sessionID`);
      break;
    case "permission.updated":
      event.sessionId = requireString(properties.sessionID, "permission.updated sessionID");
      event.messageId = requireString(properties.messageID, "permission.updated messageID");
      break;
    case "session.error": {
      event.sessionId = requireString(properties.sessionID, "session.error sessionID");
      break;
    }
    case "session.deleted": {
      const info = requireObject(properties.info, "session.deleted info");
      event.sessionId = requireString(info.id, "session.deleted session id");
      break;
    }
  }

  return event;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  const result = object(value);
  if (Object.keys(result).length === 0) throw new OpenCodeEventError(`Malformed OpenCode ${label}.`);
  return result;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new OpenCodeEventError(`Malformed OpenCode ${label}.`);
  return value;
}

function requireString(value: unknown, label: string): string {
  const result = optionalString(value);
  if (result === undefined) throw new OpenCodeEventError(`Malformed OpenCode ${label}.`);
  return result;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toTimestamp(value: unknown, label: string): string {
  const result = optionalTimestamp(value, label);
  if (result === undefined) throw new OpenCodeEventError(`Malformed OpenCode ${label}.`);
  return result;
}

function optionalTimestamp(value: unknown, label: string): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (value === undefined) return undefined;
  throw new OpenCodeEventError(`Malformed OpenCode ${label}.`);
}

function optionalToolStatus(value: unknown): OpenCodeMessagePart["toolStatus"] | undefined {
  return value === "pending" || value === "running" || value === "completed" || value === "error" ? value : undefined;
}

function string(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function number(value: unknown): number {
  return typeof value === "number" ? value : 0;
}
