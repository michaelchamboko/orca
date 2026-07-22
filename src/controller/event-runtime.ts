import type { OpenCodeLiveAdapter } from "../integrations/opencode/adapter.js";
import { MissionIngress } from "./mission-ingress.js";
import { PlannerDispatchOutbox } from "./planner-dispatch.js";
import { WorkerCompletionService } from "./worker-completion.js";

const reconnectDelays = [250, 500, 1_000, 2_000, 5_000] as const;

export class EventRuntime {
  private readonly abort = new AbortController();
  private eventTask: Promise<void> | undefined;
  private pollTask: Promise<void> | undefined;
  private pollTimer: ReturnType<typeof globalThis.setInterval> | undefined;
  private listening = false;

  constructor(private readonly adapter: OpenCodeLiveAdapter, private readonly ingress: MissionIngress, private readonly dispatch: PlannerDispatchOutbox, private readonly completion: WorkerCompletionService) {}

  get eventListening(): boolean { return this.listening; }

  async start(): Promise<void> {
    const cutoff = new Date();
    await this.ingress.processStartup(cutoff);
    await this.dispatch.recoverPending();
    await this.completion.observeAll();
    this.listening = true;
    this.eventTask = this.pumpEvents();
    this.pollTimer = globalThis.setInterval(() => {
      if (!this.pollTask) this.pollTask = this.poll().finally(() => { this.pollTask = undefined; });
    }, 1_000);
  }

  async stop(): Promise<void> {
    this.listening = false;
    this.abort.abort();
    if (this.pollTimer) globalThis.clearInterval(this.pollTimer);
    await this.eventTask;
    await this.pollTask;
  }

  private async poll(): Promise<void> {
    try { await this.ingress.poll(); await this.dispatch.recoverPending(); await this.completion.observeAll(); } catch { /* polling remains best-effort */ }
  }

  private async pumpEvents(): Promise<void> {
    let delayIndex = 0;
    while (!this.abort.signal.aborted) {
      try {
        for await (const event of this.adapter.subscribeEvents(this.abort.signal)) {
          if (event.type === "message.updated" || event.type === "message.part.updated") await this.ingress.processEvent(event.sessionId, event.messageId);
          await this.completion.observeEvent(event);
          delayIndex = 0;
        }
      } catch { /* reconnect below; never include event payloads in logs */ }
      if (this.abort.signal.aborted) return;
      await wait(reconnectDelays[Math.min(delayIndex++, reconnectDelays.length - 1)], this.abort.signal);
    }
  }
}

async function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = globalThis.setTimeout(resolve, delayMs);
    signal.addEventListener("abort", () => { globalThis.clearTimeout(timer); resolve(); }, { once: true });
  });
}
