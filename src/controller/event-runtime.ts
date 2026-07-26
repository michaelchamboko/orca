import type { OpenCodeLiveAdapter } from "../integrations/opencode/adapter.js";
import type { OpenCodeEvent } from "../integrations/opencode/types.js";
import { MissionIngress } from "./mission-ingress.js";
import { DispatchOutbox } from "./dispatch-outbox.js";
import { WorkerCompletionService } from "./worker-completion.js";
import { ReconciliationMutex } from "./reconciliation-mutex.js";
import type { MissionContext } from "./mission-context.js";

const reconnectDelays = [250, 500, 1_000, 2_000, 5_000] as const;

export class EventRuntime {
  private readonly abort = new AbortController();
  private eventTask: Promise<void> | undefined;
  private pollTask: Promise<void> | undefined;
  private pollTimer: ReturnType<typeof globalThis.setInterval> | undefined;
  private listening = false;
  private readonly mutex = new ReconciliationMutex();

  constructor(
    private readonly adapter: OpenCodeLiveAdapter,
    private readonly ingress: MissionIngress,
    private readonly dispatch: DispatchOutbox,
    private readonly completion: WorkerCompletionService,
    private readonly missionContext: MissionContext
  ) {}

  get eventListening(): boolean { return this.listening; }

  async start(): Promise<void> {
    const cutoff = new Date();
    await this.ingress.processStartup(cutoff);
    await this.reconcileOnce("startup");
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
    try {
      await this.ingress.poll();
      await this.reconcileOnce("poll");
    } catch { /* polling remains best-effort */ }
  }

  async reconcileOnce(reason: "startup" | "poll" | "event"): Promise<void> {
    await this.mutex.run(async () => {
      try {
        await this.dispatch.recoverPending();
        await this.completion.observeAll();
        const reconciled = this.missionContext.consumeCompletedTasks();
        if (reconciled > 0) await this.dispatch.recoverPending();
      } catch {
        /* reconciliation must remain best-effort; durable outbox retries on the next pass */
      }
      void reason;
    });
  }

  private async pumpEvents(): Promise<void> {
    let delayIndex = 0;
    while (!this.abort.signal.aborted) {
      try {
        for await (const event of this.adapter.subscribeEvents(this.abort.signal)) {
          await this.handleEvent(event);
          delayIndex = 0;
        }
      } catch { /* reconnect below; never include event payloads in logs */ }
      if (this.abort.signal.aborted) return;
      await wait(reconnectDelays[Math.min(delayIndex++, reconnectDelays.length - 1)], this.abort.signal);
    }
  }

  private async handleEvent(event: OpenCodeEvent): Promise<void> {
    await this.mutex.run(async () => {
      if (event.type === "message.updated" || event.type === "message.part.updated") {
        await this.ingress.processEvent(event.sessionId, event.messageId);
      }
      await this.completion.observeEvent(event);
      try {
        const reconciled = this.missionContext.consumeCompletedTasks();
        if (reconciled > 0) await this.dispatch.recoverPending();
      } catch {
        /* event-driven reconciliation must remain best-effort */
      }
    });
  }
}

async function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = globalThis.setTimeout(resolve, delayMs);
    signal.addEventListener("abort", () => { globalThis.clearTimeout(timer); resolve(); }, { once: true });
  });
}