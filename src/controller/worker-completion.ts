import { createHash } from "node:crypto";

import { parseWorkerResult } from "../domain/schemas.js";
import type { ModelRef, RoleWorkerResult, TaskEnvelope } from "../domain/types.js";
import type { OpenCodeLiveAdapter } from "../integrations/opencode/adapter.js";
import type { OpenCodeEvent, OpenCodeMessage } from "../integrations/opencode/types.js";
import type { TaskExecutionRecord } from "../persistence/sqlite.js";
import type { WorkflowPersistence } from "./workflow-persistence.js";
import {
  StableResponseTracker,
  hashStableResponse,
  initialStableResponseCheckpoint,
  type StableResponseCheckpoint
} from "./response-stability.js";
import type { DispatchOutbox } from "./dispatch-outbox.js";

type Binding = { agent: string; model: ModelRef; sessionId: string };
type Checkpoint = StableResponseCheckpoint & { repairPromptMessageId?: string; lastFailureReason?: string; lastInvalidOutputMessageId?: string };

const REPAIR_ATTEMPT_CAP = 1;

export interface WorkerCompletionOptions {
  now?: () => number;
  quietWindowMs?: number;
  maxPollFailures?: number;
  maxStagnantPolls?: number;
  assertWorkerBinding: (task: TaskExecutionRecord) => Promise<Binding>;
}

export class WorkerCompletionService {
  private readonly now: () => number;
  private readonly quietWindowMs: number;
  private readonly maxPollFailures: number;
  private readonly maxStagnantPolls: number;
  private readonly trackers = new Map<string, StableResponseTracker>();

  constructor(private readonly adapter: OpenCodeLiveAdapter, private readonly persistence: WorkflowPersistence, private readonly dispatchOutbox: DispatchOutbox, private readonly options: WorkerCompletionOptions) {
    this.now = options.now ?? Date.now;
    this.quietWindowMs = options.quietWindowMs ?? 1_500;
    this.maxPollFailures = options.maxPollFailures ?? 3;
    this.maxStagnantPolls = options.maxStagnantPolls ?? 30;
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
    const tracker = this.trackerFor(task);
    if (this.isTerminal(task)) { this.trackers.delete(task.taskId); return; }
    const attempts = this.persistence.getTaskPromptAttempts(task.taskId);
    const initialAttempt = attempts.find((attempt) => attempt.purpose === "worker_task");
    const timeoutOrigin = initialAttempt?.acknowledgedAt
      ? Date.parse(initialAttempt.acknowledgedAt)
      : Date.parse(task.envelope.createdAt);
    if (this.now() - timeoutOrigin > task.timeoutMs) return this.block(task, "worker completion timed out");
    let binding: Binding;
    try { binding = await this.options.assertWorkerBinding(task); } catch { return this.block(task, "roster drift or worker session closure prevented completion recovery"); }
    let messages: OpenCodeMessage[];
    let status: { idle: boolean; inFlightToolCalls: number };
    try { [messages, status] = await Promise.all([this.adapter.listMessages(task.targetSessionId), this.adapter.getSessionStatus(task.targetSessionId)]); }
    catch { return this.recordPollFailure(task); }
    const activePromptId = this.activePromptId(task);
    const activeCorrelated = messages.filter((message) => message.role === "assistant" && message.parentId === activePromptId);
    const output = activeCorrelated.at(-1);
    if (!output) {
      this.persistCheckpoint(task, tracker);
      return;
    }
    const snapshot = { outputMessageId: output.id, outputHash: hashText(extractText(output)), completionAt: output.completedAt ?? output.createdAt };
    const snapshotHash = hashStableResponse(JSON.stringify({ status, id: output.id, completedAt: output.completedAt, parts: output.parts.map((part) => ({ id: part.id, toolStatus: part.toolStatus, text: Boolean(part.text) })) }));
    const { advanced } = tracker.observe(snapshot, snapshotHash, this.now());
    if (tracker.hasStagnated(this.maxStagnantPolls)) return this.block(task, "worker completion stagnated without progress");
    const text = extractText(output);
    let result: RoleWorkerResult;
    try { result = parseWorkerResult(task.role, task.missionId, task.taskId, JSON.parse(text)); }
    catch {
      await this.recordContractViolation(task, output.id, tracker, binding);
      return;
    }
    const activeLineageTool = activeCorrelated.some((message) => message.parts.some((part) => part.toolStatus === "pending" || part.toolStatus === "running"));
    if (!status.idle || status.inFlightToolCalls > 0 || activeLineageTool) {
      this.persistCheckpoint(task, tracker);
      return;
    }
    if (output.parentId !== activePromptId || advanced || !tracker.hasQuietWindowElapsed(this.now(), this.quietWindowMs)) {
      this.persistCheckpoint(task, tracker);
      return;
    }
    this.persistCheckpoint(task, tracker);
    this.persistence.completeTaskExecutionAtomically(task.taskId, output.id, result, { outputMessageId: output.id, completionAt: snapshot.completionAt, outputHash: snapshot.outputHash });
    this.trackers.delete(task.taskId);
  }

  private isTerminal(task: TaskExecutionRecord): boolean {
    return task.state === "completed" || task.state === "approved" || task.state === "blocked" || task.state === "failed" || task.state === "cancelled" || task.state === "rejected" || task.state === "timed_out";
  }

  private async recordContractViolation(task: TaskExecutionRecord, offendingOutputMessageId: string, tracker: StableResponseTracker, binding: Binding): Promise<void> {
    const checkpoint = this.persistence.getControllerCheckpoint(`controller:worker-completion:${task.taskId}`)?.payload as Checkpoint | undefined;
    if (checkpoint?.lastInvalidOutputMessageId === offendingOutputMessageId && (checkpoint.contractRepairs ?? 0) >= REPAIR_ATTEMPT_CAP) {
      this.block(task, "worker returned a second invalid result contract");
      return;
    }
    const attempts = this.persistence.getTaskPromptAttempts(task.taskId);
    const repairs = attempts.filter((attempt) => attempt.purpose === "contract_repair").length;
    if (repairs >= REPAIR_ATTEMPT_CAP) {
      this.block(task, "worker returned a second invalid result contract");
      return;
    }
    const newRepairPromptId = `orca-repair-${task.taskId}-${this.now()}`;
    tracker.recordContractRepair();
    this.persistCheckpoint(task, tracker, { lastInvalidOutputMessageId: offendingOutputMessageId });
    this.persistence.runInTransaction(() => {
      this.persistence.setTaskExecutionState(task.taskId, "result_contract_violation");
      this.persistence.recordTaskPromptAttempt(task.taskId, newRepairPromptId, "contract_repair", repairs + 1);
      this.persistence.recordControllerEvent(task.taskId, "worker.contract_repair", { repair: repairs + 1, repairPromptMessageId: newRepairPromptId, offendingOutputMessageId });
      this.persistence.enqueueDispatch({
        missionId: task.missionId,
        dispatchKey: `${task.taskId}:repair:${repairs + 1}`,
        targetRole: task.role,
        targetSessionId: binding.sessionId,
        capturedModel: binding.model,
        promptMessageId: newRepairPromptId,
        taskId: task.taskId,
        purpose: "contract_repair",
        parentPromptMessageId: task.controllerPromptMessageId,
        promptPayload: { kind: "contract_repair", contract: "worker_result", envelope: task.envelope, originalPromptMessageId: task.controllerPromptMessageId }
      });
    });
    void this.dispatchOutbox.recoverPending().catch(() => this.block(task, "worker contract-repair prompt could not be delivered"));
  }

  private recordPollFailure(task: TaskExecutionRecord): void {
    const tracker = this.trackerFor(task);
    const pollFailures = tracker.recordPollFailure();
    this.persistCheckpoint(task, tracker);
    this.persistence.recordControllerEvent(task.taskId, "worker.poll_failure", { pollFailures });
    if (pollFailures >= this.maxPollFailures) this.block(task, "repeated worker polling failure");
  }

  private block(task: TaskExecutionRecord, reason: string): void {
    this.persistence.runInTransaction(() => {
      this.persistence.blockTaskExecution(task.taskId, reason);
      this.persistence.recordControllerEvent(task.taskId, "worker.blocked", { reason });
    });
    this.trackers.delete(task.taskId);
  }

  private trackerFor(task: TaskExecutionRecord): StableResponseTracker {
    let tracker = this.trackers.get(task.taskId);
    if (!tracker) {
      const prior = this.persistence.getControllerCheckpoint(`controller:worker-completion:${task.taskId}`)?.payload as Checkpoint | undefined;
      tracker = new StableResponseTracker(prior ?? initialStableResponseCheckpoint);
      this.trackers.set(task.taskId, tracker);
    }
    return tracker;
  }

  private persistCheckpoint(task: TaskExecutionRecord, tracker: StableResponseTracker, extras: Partial<Checkpoint> = {}): void {
    const checkpoint = { ...tracker.snapshot(), ...extras } as Checkpoint;
    this.persistence.saveControllerCheckpoint({ cursorKey: `controller:worker-completion:${task.taskId}`, rosterId: this.persistence.getCurrentRoster()?.rosterId ?? null, cursor: String(this.now()), payload: { ...checkpoint } });
  }

  private activePromptId(task: TaskExecutionRecord): string {
    const attempts = this.persistence.getTaskPromptAttempts(task.taskId);
    const latest = attempts.at(-1);
    return latest?.promptMessageId ?? task.controllerPromptMessageId;
  }
}

function extractText(message: OpenCodeMessage): string {
  return message.parts.filter((part) => typeof part.text === "string").map((part) => part.text).join("\n").trim();
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export type { TaskEnvelope };