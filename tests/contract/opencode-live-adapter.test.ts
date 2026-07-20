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
      if (request.url === "/session?directory=C%3A%2Fworkspace") return json(response, [{ id: "s-1", title: "Planner", directory: "C:/workspace", time: { created: 1 }, model: { providerID: "openai", modelID: "gpt-5" } }]);
      response.statusCode = 404;
      response.end();
    });
    const adapter = new RealOpenCodeAdapter({ ...credentials, baseUrl });

    await expect(adapter.health()).resolves.toEqual({ healthy: true, version: "1.18.3" });
    await expect(adapter.listSessions("C:/workspace")).resolves.toEqual([expect.objectContaining({ id: "s-1", projectRoot: "C:/workspace", model: { providerId: "openai", modelId: "gpt-5" } })]);
  });

  it("looks up a session model and dispatches prompts asynchronously", async () => {
    const seen: unknown[] = [];
    const baseUrl = await fixture(async (request, response) => {
      if (request.url === "/session/s-1" && request.method === "GET") return json(response, { id: "s-1", model: { providerID: "openai", modelID: "gpt-5" } });
      if (request.url === "/session/s-1/prompt_async" && request.method === "POST") {
        seen.push(await body(request));
        response.statusCode = 204;
        response.end();
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    const adapter = new RealOpenCodeAdapter({ ...credentials, baseUrl });

    await expect(adapter.getSessionModel("s-1")).resolves.toEqual({ providerId: "openai", modelId: "gpt-5" });
    await expect(adapter.sendPrompt({ sessionId: "s-1", content: "implement the plan" })).resolves.toBeUndefined();
    expect(seen).toEqual([{ parts: [{ type: "text", text: "implement the plan" }] }]);
  });

  it("parses SSE event payloads", async () => {
    const baseUrl = await fixture((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("event: message.updated\ndata: {\"sessionID\":\"s-1\",\"value\":{\"ok\":true}}\n\n");
    });
    const adapter = new RealOpenCodeAdapter({ ...credentials, baseUrl });
    const controller = new AbortController();

    const events = adapter.subscribeEvents(controller.signal);
    await expect(events[Symbol.asyncIterator]().next()).resolves.toEqual({ done: false, value: { sessionId: "s-1", type: "message.updated", payload: { ok: true } } });
    controller.abort();
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
});

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
