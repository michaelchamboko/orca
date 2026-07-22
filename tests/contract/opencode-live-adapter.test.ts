import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { RealOpenCodeAdapter } from "../../src/integrations/opencode/real.js";

const credentials = { baseUrl: "", username: "operator", password: "fixture-password" };
const authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`;
const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
});

describe("RealOpenCodeAdapter", () => {
  it("uses basic authorization and translates health and project sessions", async () => {
    const baseUrl = await fixture(async (request, response) => {
      expect(request.headers.authorization).toBe(authorization);
      if (request.url === "/global/health") return json(response, { healthy: true, version: "1.18.3" });
      if (request.url === "/session?directory=C%3A%2Fworkspace") return json(response, [{ id: "s-1", title: "Planner", directory: "C:/workspace", time: { created: "2026-07-20T08:00:00.000Z", updated: "2026-07-20T09:00:00.000Z" }, model: { providerID: "openai", modelID: "gpt-5" } }]);
      response.statusCode = 404;
      response.end();
    });
    const adapter = new RealOpenCodeAdapter({ ...credentials, baseUrl });

    await expect(adapter.health()).resolves.toEqual({ healthy: true, version: "1.18.3" });
    await expect(adapter.listSessions("C:/workspace")).resolves.toEqual([expect.objectContaining({ id: "s-1", projectRoot: "C:/workspace", lastActivity: "2026-07-20T09:00:00.000Z", model: { providerId: "openai", modelId: "gpt-5" } })]);
  });

  it("preserves a session model reported as id", async () => {
    const baseUrl = await fixture((_request, response) => {
      json(response, [{ id: "s-1", directory: "C:/workspace", model: { providerID: "opencode", id: "north-mini-code-free" } }]);
    });
    const adapter = new RealOpenCodeAdapter({ ...credentials, baseUrl });

    await expect(adapter.listSessions("C:/workspace")).resolves.toEqual([
      expect.objectContaining({ model: { providerId: "opencode", modelId: "north-mini-code-free" } })
    ]);
  });

  it("reads a session model", async () => {
    const baseUrl = await fixture(async (request, response) => {
      if (request.url === "/session/s-1" && request.method === "GET") return json(response, { id: "s-1", model: { providerID: "opencode", id: "north-mini-code-free" } });
      response.statusCode = 404;
      response.end();
    });
    const adapter = new RealOpenCodeAdapter({ ...credentials, baseUrl });

    await expect(adapter.getSessionModel("s-1")).resolves.toEqual({ providerId: "opencode", modelId: "north-mini-code-free" });
  });

  it("gets session messages and normalizes text and tool parts", async () => {
    const message = {
      info: {
        id: "m-1",
        sessionID: "s-1",
        role: "assistant",
        parentID: "m-0",
        time: { created: 1_753_000_000_000, completed: 1_753_000_001_000 }
      },
      parts: [
        { id: "p-text", type: "text", text: "done" },
        { id: "p-pending", type: "tool", state: { status: "pending" } },
        { id: "p-running", type: "tool", state: { status: "running" } },
        { id: "p-completed", type: "tool", state: { status: "completed" } },
        { id: "p-error", type: "tool", state: { status: "error" } },
        { id: "p-step", type: "step-finish" }
      ]
    };
    const baseUrl = await fixture((request, response) => {
      if (request.url === "/session/s-1/message?limit=2") return json(response, [message]);
      if (request.url === "/session/s-1/message/m-1") return json(response, message);
      response.statusCode = 404;
      response.end();
    });
    const adapter = new RealOpenCodeAdapter({ ...credentials, baseUrl });

    await expect(adapter.listMessages("s-1", 2)).resolves.toEqual([normalizedMessage]);
    await expect(adapter.getMessage("s-1", "m-1")).resolves.toEqual(normalizedMessage);
  });

  it("rejects a listed message that belongs to another session", async () => {
    const baseUrl = await fixture((_request, response) => json(response, [messageFor("s-other")]));
    const adapter = new RealOpenCodeAdapter({ ...credentials, baseUrl });

    await expect(adapter.listMessages("s-1")).rejects.toMatchObject({ name: "OpenCodeEventError", message: expect.stringContaining("sessionID does not match") });
  });

  it("rejects a fetched message that belongs to another session", async () => {
    const baseUrl = await fixture((_request, response) => json(response, messageFor("s-other")));
    const adapter = new RealOpenCodeAdapter({ ...credentials, baseUrl });

    await expect(adapter.getMessage("s-1", "m-1")).rejects.toMatchObject({ name: "OpenCodeEventError", message: expect.stringContaining("sessionID does not match") });
  });

  it("rejects a fetched message whose identity differs from the requested message", async () => {
    const baseUrl = await fixture((_request, response) => json(response, messageFor("s-1", "m-other")));
    const adapter = new RealOpenCodeAdapter({ ...credentials, baseUrl });

    await expect(adapter.getMessage("s-1", "m-1")).rejects.toMatchObject({ name: "OpenCodeEventError", message: expect.stringContaining("message ID does not match") });
  });

  it("posts a correlated prompt with the paired model and does not update session configuration", async () => {
    const requests: Array<{ url: string | undefined; method: string | undefined; body?: unknown }> = [];
    const baseUrl = await fixture(async (request, response) => {
      requests.push({ url: request.url, method: request.method, body: request.method === "POST" ? await body(request) : undefined });
      if (request.url === "/session/s-1/prompt_async" && request.method === "POST") {
        response.statusCode = 204;
        response.end();
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    const adapter = new RealOpenCodeAdapter({ ...credentials, baseUrl });

    await expect(adapter.sendPrompt({
      messageId: "m-correlation",
      sessionId: "s-1",
      content: "implement the plan",
      agent: "build",
      model: { providerId: "opencode", modelId: "north-mini-code-free" }
    })).resolves.toBeUndefined();

    expect(requests).toEqual([{
      url: "/session/s-1/prompt_async",
      method: "POST",
      body: {
        messageID: "m-correlation",
        agent: "build",
        model: { providerID: "opencode", modelID: "north-mini-code-free" },
        parts: [{ type: "text", text: "implement the plan" }]
      }
    }]);
  });

  it("unwraps documented global event envelopes and correlates event identities", async () => {
    const baseUrl = await fixture((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([
        sse({ directory: "C:/workspace", payload: { type: "message.updated", properties: { info: { id: "m-1", sessionID: "s-1" } } } }),
        sse({ directory: "C:/workspace", payload: { type: "message.part.updated", properties: { part: { id: "p-1", sessionID: "s-1", messageID: "m-1" } } } }),
        sse({ directory: "C:/workspace", payload: { type: "session.status", properties: { sessionID: "s-1", status: { type: "busy" } } } }),
        sse({ directory: "C:/workspace", payload: { type: "session.idle", properties: { sessionID: "s-1" } } }),
        sse({ directory: "C:/workspace", payload: { type: "permission.updated", properties: { id: "permission-1", sessionID: "s-1", messageID: "m-1" } } }),
        sse({ directory: "C:/workspace", payload: { type: "session.error", properties: { sessionID: "s-1", error: { message: "provider failed" } } } }),
        sse({ directory: "C:/workspace", payload: { type: "session.deleted", properties: { info: { id: "s-1" } } } })
      ].join(""));
    });
    const adapter = new RealOpenCodeAdapter({ ...credentials, baseUrl });
    const controller = new AbortController();

    const events: unknown[] = [];
    for await (const event of adapter.subscribeEvents(controller.signal)) events.push(event);

    expect(events).toEqual([
      { directory: "C:/workspace", type: "message.updated", sessionId: "s-1", messageId: "m-1", payload: { info: { id: "m-1", sessionID: "s-1" } } },
      { directory: "C:/workspace", type: "message.part.updated", sessionId: "s-1", messageId: "m-1", payload: { part: { id: "p-1", sessionID: "s-1", messageID: "m-1" } } },
      { directory: "C:/workspace", type: "session.status", sessionId: "s-1", payload: { sessionID: "s-1", status: { type: "busy" } } },
      { directory: "C:/workspace", type: "session.idle", sessionId: "s-1", payload: { sessionID: "s-1" } },
      { directory: "C:/workspace", type: "permission.updated", sessionId: "s-1", messageId: "m-1", payload: { id: "permission-1", sessionID: "s-1", messageID: "m-1" } },
      { directory: "C:/workspace", type: "session.error", sessionId: "s-1", payload: { sessionID: "s-1", error: { message: "provider failed" } } },
      { directory: "C:/workspace", type: "session.deleted", sessionId: "s-1", payload: { info: { id: "s-1" } } }
    ]);
  });

  it("rejects malformed global event data with a controlled adapter error", async () => {
    const baseUrl = await fixture((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("data: {not-json}\n\n");
    });
    const adapter = new RealOpenCodeAdapter({ ...credentials, baseUrl });
    const controller = new AbortController();

    await expect(adapter.subscribeEvents(controller.signal)[Symbol.asyncIterator]().next()).rejects.toMatchObject({ name: "OpenCodeEventError", message: expect.stringContaining("Malformed") });
  });

  it("rejects a session.error event without a session correlation", async () => {
    const baseUrl = await fixture((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(sse({ directory: "C:/workspace", payload: { type: "session.error", properties: { error: { message: "provider failed" } } } }));
    });
    const adapter = new RealOpenCodeAdapter({ ...credentials, baseUrl });
    const controller = new AbortController();

    await expect(adapter.subscribeEvents(controller.signal)[Symbol.asyncIterator]().next()).rejects.toMatchObject({ name: "OpenCodeEventError", message: expect.stringContaining("session.error sessionID") });
  });

  it("turns HTTP failures into useful errors", async () => {
    const baseUrl = await fixture((_request, response) => {
      response.statusCode = 401;
      response.end("unauthorized");
    });
    const adapter = new RealOpenCodeAdapter({ ...credentials, baseUrl });

    await expect(adapter.health()).rejects.toMatchObject({ name: "OpenCodeHttpError", status: 401, message: expect.stringContaining("authentication failed") });
  });

  it("bounds a stalled request", async () => {
    const baseUrl = await fixture(() => undefined);
    const adapter = new RealOpenCodeAdapter({ ...credentials, baseUrl, timeoutMs: 25 });

    await expect(adapter.health()).rejects.toThrow(/timed out/i);
  });

  it("bounds a stalled event-stream handshake", async () => {
    const baseUrl = await fixture(() => undefined);
    const adapter = new RealOpenCodeAdapter({ ...credentials, baseUrl, timeoutMs: 25 });
    const controller = new AbortController();

    await expect(adapter.subscribeEvents(controller.signal)[Symbol.asyncIterator]().next()).rejects.toThrow(/timed out/i);
    controller.abort();
  });

  it("preserves authenticated HTTP errors when getting messages", async () => {
    const baseUrl = await fixture((_request, response) => {
      response.statusCode = 401;
      response.end("unauthorized");
    });
    const adapter = new RealOpenCodeAdapter({ ...credentials, baseUrl });

    await expect(adapter.listMessages("s-1")).rejects.toMatchObject({ name: "OpenCodeHttpError", status: 401, message: expect.stringContaining("authentication failed") });
  });
});

const normalizedMessage = {
  id: "m-1",
  sessionId: "s-1",
  role: "assistant",
  parentId: "m-0",
  createdAt: "2025-07-20T08:26:40.000Z",
  completedAt: "2025-07-20T08:26:41.000Z",
  parts: [
    { id: "p-text", type: "text", text: "done" },
    { id: "p-pending", type: "tool", toolStatus: "pending" },
    { id: "p-running", type: "tool", toolStatus: "running" },
    { id: "p-completed", type: "tool", toolStatus: "completed" },
    { id: "p-error", type: "tool", toolStatus: "error" },
    { id: "p-step", type: "step-finish" }
  ]
};

function sse(value: unknown): string {
  return `event: global\ndata: ${JSON.stringify(value)}\n\n`;
}

function messageFor(sessionID: string, id = "m-1") {
  return {
    info: { id, sessionID, role: "assistant", time: { created: "2026-07-21T12:00:00.000Z" } },
    parts: []
  };
}

async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>): Promise<string> {
  const server = createServer((request, response) => void handler(request, response));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function json(response: ServerResponse, data: unknown): void {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(data));
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
