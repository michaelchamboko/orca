import { describe, expect, it, vi } from "vitest";

import { FakeOpenCodeAdapter } from "../../src/integrations/opencode/fake.js";

describe("FakeOpenCodeAdapter", () => {
  it("delivers a controller task only to the requested session", async () => {
    const adapter = new FakeOpenCodeAdapter([session("s-2", 2)]);

    await adapter.deliverTask("s-2", { taskId: "t-1", content: "plan" });

    expect(adapter.deliveries()).toEqual([
      { sessionId: "s-2", taskId: "t-1", content: "plan" }
    ]);
  });

  it("rejects delivery to an unknown OpenCode session", async () => {
    const adapter = new FakeOpenCodeAdapter([]);

    await expect(
      adapter.deliverTask("missing", { taskId: "t-1", content: "plan" })
    ).rejects.toThrow("unknown OpenCode session");
  });

  it("supports normalized messages, correlated prompts, and normalized events", async () => {
    const adapter = new FakeOpenCodeAdapter([session("s-2", 2)], [{
      id: "m-1",
      sessionId: "s-2",
      role: "assistant",
      createdAt: "2026-07-21T12:00:00.000Z",
      parts: [{ id: "p-1", type: "text", text: "ready" }]
    }]);
    const listener = vi.fn();
    adapter.subscribe(listener);

    await expect(adapter.listMessages("s-2")).resolves.toEqual([expect.objectContaining({ id: "m-1" })]);
    await expect(adapter.getMessage("s-2", "m-1")).resolves.toEqual(expect.objectContaining({ id: "m-1" }));
    await adapter.sendPrompt({
      messageId: "m-correlation",
      sessionId: "s-2",
      content: "implement",
      agent: "build",
      model: { providerId: "openai", modelId: "gpt-5" }
    });
    adapter.emit({ directory: "C:/workspace", sessionId: "s-2", messageId: "m-1", type: "message.updated", payload: { info: { id: "m-1" } } });

    expect(adapter.prompts()).toEqual([{
      messageId: "m-correlation",
      sessionId: "s-2",
      content: "implement",
      agent: "build",
      model: { providerId: "openai", modelId: "gpt-5" }
    }]);
    expect(listener).toHaveBeenCalledWith({ directory: "C:/workspace", sessionId: "s-2", messageId: "m-1", type: "message.updated", payload: { info: { id: "m-1" } } });
  });

  it("does not notify an unsubscribed listener", () => {
    const adapter = new FakeOpenCodeAdapter([session("s-2", 2)]);
    const listener = vi.fn();
    const stop = adapter.subscribe(listener);

    stop();
    adapter.emit({ sessionId: "s-2", type: "message" });

    expect(listener).not.toHaveBeenCalled();
  });
});

function session(id: string, position: number) {
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
