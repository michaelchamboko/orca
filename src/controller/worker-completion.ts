import { createHash } from "node:crypto";

import { parseWorkerResult } from "../domain/schemas.js";
import type { ModelRef, RoleWorkerResult } from "../domain/types.js";
import type { OpenCodeLiveAdapter } from "../integrations/opencode/adapter.js";
import type { OpenCodeEvent, OpenCodeMessage } from "../integrations/opencode/types.js";
import type { TaskExecutionRecord } from "../persistence/sqlite.js";
import type { WorkflowPersistence } from "./workflow-persistence.js";

type Binding = { agent: string; model: ModelRef };
type Checkpoint = { outputMessageId?: string; outputHash?: string; completionAt?: string; stableSince?: number; contractRepairs?: number; pollFailures?: number; snapshotHash?: string; stagnantPolls?: number };

export interface WorkerCompletionOptions {
  now?: () => number;
  quietWindowMs?: number;
  maxPollFailures?: number;
  maxStagnantPolls?: number;
  assertWorkerBinding: (task: TaskExecutionRecord) => Promise<Binding>;
}

/** Observes existing dispatches only; it never advances approval or role routing. */
export class WorkerCompletionService {
  private readonly now: () => number;
  constructor(private readonly adapter: OpenCodeLiveAdapter, private readonly persistence: WorkflowPersistence, private readonly options: WorkerCompletionOptions) {
    this.now = options.now ?? Date.now;
  }

  async observeEvent(event: OpenCodeEvent): Promise<void> {
    if (event.type.startsWith("permission.")) {
      for (const task of this.persistence.getTaskExecutionsForCompletion()) if (task.targetSessionId === event.sessionId) this.block(task, "worker permission request requires controller intervention");
      return;
    }
    await this.observeAll();
  }

  async observeAll(): Promise<void> {
    for (const task of this.persistence.getTaskExecutionsForCompletion()) await this.observe(task);
  }

  private async observe(task: TaskExecutionRecord): Promise<void> {
    if (this.now() - Date.parse(task.envelope.createdAt) > task.timeoutMs) return this.block(task, "worker completion timed out");
    let binding: Binding;
    try { binding = await this.options.assertWorkerBinding(task); } catch { return this.block(task, "roster drift or worker session closure prevented completion recovery"); }
    let messages: OpenCodeMessage[];
    let status: { idle: boolean; inFlightToolCalls: number };
    try { [messages, status] = await Promise.all([this.adapter.listMessages(task.targetSessionId), this.adapter.getSessionStatus(task.targetSessionId)]); }
    catch { return this.pollFailure(task); }
    const prior = this.checkpoint(task);
    const output = messages.filter((message) => message.role === "assistant" && message.parentId === task.controllerPromptMessageId).at(-1);
    const snapshotHash = hash(JSON.stringify({ status, id: output?.id, completedAt: output?.completedAt, parts: output?.parts.map((part) => ({ id: part.id, toolStatus: part.toolStatus, text: Boolean(part.text) })) }));
    const checkpoint = this.progress(task, prior, snapshotHash);
    if (!output) return;
    const text = output.parts.filter((part) => typeof part.text === "string").map((part) => part.text).join("\n").trim();
    let result: RoleWorkerResult;
    try { result = parseWorkerResult(task.role, task.missionId, task.taskId, JSON.parse(text)); }
    catch { return this.contractViolation(task, binding, checkpoint); }
    const hasInFlightWorkerTool = messages.some((message) => message.role === "assistant" && message.parts.some((part) => part.toolStatus === "pending" || part.toolStatus === "running"));
    if (!status.idle || status.inFlightToolCalls > 0 || hasInFlightWorkerTool) return;
    const completionAt = output.completedAt ?? output.createdAt;
    const outputHash = hash(text);
    if (prior.outputMessageId !== output.id || prior.outputHash !== outputHash || prior.completionAt !== completionAt) {
      this.save(task, { ...checkpoint, outputMessageId: output.id, outputHash, completionAt, stableSince: this.now() });
      this.persistence.recordControllerEvent(task.taskId, "worker.result_observed", { outputMessageId: output.id, completionAt, outputHash });
      return;
    }
    if (this.now() - (prior.stableSince ?? this.now()) < (this.options.quietWindowMs ?? 1_500)) return;
    this.persistence.saveTaskExecutionOutput(task.taskId, output.id);
    this.persistence.saveTaskResult(task.taskId, "completed", result);
    this.persistence.recordControllerEvent(task.taskId, "worker.completed", { outputMessageId: output.id, completionAt, outputHash });
  }

  private contractViolation(task: TaskExecutionRecord, binding: Binding, checkpoint: Checkpoint): void {
    const repairs = checkpoint.contractRepairs ?? 0;
    if (repairs >= 1) return this.block(task, "worker returned a second invalid result contract");
    this.save(task, { ...checkpoint, contractRepairs: repairs + 1 });
    this.persistence.setTaskExecutionState(task.taskId, "result_contract_violation");
    this.persistence.recordControllerEvent(task.taskId, "worker.contract_repair", { repair: repairs + 1 });
    void this.adapter.sendPrompt({ messageId: task.controllerPromptMessageId, sessionId: task.targetSessionId, agent: binding.agent, model: { ...binding.model }, content: "Your previous result was invalid. Reply to the original controller prompt with only valid JSON for this same task." }).catch(() => this.block(task, "worker contract-repair prompt could not be delivered"));
  }

  private pollFailure(task: TaskExecutionRecord): void {
    const checkpoint = this.checkpoint(task);
    const pollFailures = (checkpoint.pollFailures ?? 0) + 1;
    this.save(task, { ...checkpoint, pollFailures });
    this.persistence.recordControllerEvent(task.taskId, "worker.poll_failure", { pollFailures });
    if (pollFailures >= (this.options.maxPollFailures ?? 3)) this.block(task, "repeated worker polling failure");
  }

  private progress(task: TaskExecutionRecord, checkpoint: Checkpoint, snapshotHash: string): Checkpoint {
    const stagnantPolls = checkpoint.snapshotHash === snapshotHash ? (checkpoint.stagnantPolls ?? 0) + 1 : 0;
    const next = { ...checkpoint, snapshotHash, stagnantPolls, pollFailures: 0 };
    this.save(task, next);
    if (stagnantPolls >= (this.options.maxStagnantPolls ?? 30)) this.block(task, "worker completion stagnated without progress");
    return next;
  }

  private block(task: TaskExecutionRecord, reason: string): void {
    this.persistence.blockTaskExecution(task.taskId, reason);
    this.persistence.recordControllerEvent(task.taskId, "worker.blocked", { reason });
  }
  private checkpoint(task: TaskExecutionRecord): Checkpoint { return this.persistence.getControllerCheckpoint(`controller:worker-completion:${task.taskId}`)?.payload as Checkpoint ?? {}; }
  private save(task: TaskExecutionRecord, payload: Checkpoint): void { this.persistence.saveControllerCheckpoint({ cursorKey: `controller:worker-completion:${task.taskId}`, rosterId: this.persistence.getCurrentRoster()?.rosterId ?? null, cursor: String(this.now()), payload }); }
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
