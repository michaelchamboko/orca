import { randomUUID } from "node:crypto";

import type { OpenCodeLiveAdapter } from "../integrations/opencode/adapter.js";
import type { PairedRoster, TaskEnvelope } from "../domain/types.js";
import type { DispatchPurpose } from "../persistence/sqlite.js";
import type { WorkflowPersistence } from "./workflow-persistence.js";
import { RosterService } from "../pairing/roster-service.js";

const LEASE_MS = 30_000;

/**
 * Generalized durable dispatch outbox that replaces the planner-only
 * PlannerDispatchOutbox. Handles any DispatchPurpose, validates the
 * captured model against the current roster before delivery, and uses
 * the dispatch_outbox marker to avoid duplicate sends on restart.
 */
export class DispatchOutbox {
  constructor(
    private readonly adapter: OpenCodeLiveAdapter,
    private readonly persistence: WorkflowPersistence,
    private readonly rosterService: RosterService
  ) {}

  async recoverPending(): Promise<void> {
    const owner = `dispatch-outbox-${randomUUID()}`;
    for (;;) {
      const action = this.persistence.claimNextDispatch(owner, LEASE_MS);
      if (!action) return;
      try {
        const roster = await this.rosterService.assertCurrent();
        const binding = bindingFor(roster, action.targetRole);
        if (action.targetSessionId !== binding.sessionId || action.capturedModel.providerId !== binding.model.providerId || action.capturedModel.modelId !== binding.model.modelId) throw new Error("roster drift");
        const marker = `[ORCA_DISPATCH:${action.dispatchKey}]`;
        const messages = await this.adapter.listMessages(action.targetSessionId);
        const correlated = messages.some((message) => message.id === action.promptMessageId || message.parts.some((part) => part.text?.includes(marker)));
        if (!correlated) {
          const task = actionForTask(this.persistence, action.promptMessageId);
          await this.adapter.sendPrompt({
            messageId: action.promptMessageId,
            sessionId: action.targetSessionId,
            agent: `orca-${binding.role}`,
            model: { ...binding.model },
            content: buildPromptContent(marker, (action.purpose ?? "worker_task") as DispatchPurpose, task.envelope)
          });
        }
        this.persistence.acknowledgeDispatch(action.id, owner);
      } catch (error) {
        const reason = error instanceof Error && error.message === "roster drift" ? "roster drift prevented dispatch" : "dispatch delivery failed";
        if (reason.startsWith("roster drift")) {
          this.persistence.runInTransaction(() => {
            this.persistence.setMissionFailure(action.missionId, reason);
            const task = this.persistence.getTaskExecutionByPromptMessageId(action.promptMessageId);
            if (task) this.persistence.blockTaskExecution(task.taskId, reason);
          });
          this.persistence.acknowledgeDispatch(action.id, owner);
        } else {
          this.persistence.releaseDispatch(action.id, owner, reason);
        }
      }
    }
  }
}

function bindingFor(roster: PairedRoster, role: string) {
  const binding = roster.bindings.find((candidate) => candidate.role === role);
  if (!binding) throw new Error("roster drift");
  return binding;
}

function actionForTask(persistence: WorkflowPersistence, promptMessageId: string) {
  return persistence.getTaskExecutionByPromptMessageId(promptMessageId)
    ?? fail(`task execution not found for prompt: ${promptMessageId}`);
}

function fail(message: string): never { throw new Error(message); }

export function buildPromptContent(marker: string, purpose: DispatchPurpose, envelope: TaskEnvelope): string {
  switch (purpose) {
    case "worker_task":
      return `${marker}\nReturn only a valid structured result for this task.\n\nTask envelope:\n${JSON.stringify(envelope)}`;
    case "contract_repair":
      return `${marker}\nYour previous result was invalid. Reply with only valid JSON for this same task.\n\nTask envelope:\n${JSON.stringify(envelope)}`;
    case "orchestrator_decision":
      return `${marker}\nReview the current mission state and respond with a valid OrchestratorAction JSON envelope.`;
    case "final_completion":
      return `${marker}\nAll gates have been approved; provide a final completion summary.`;
    case "status_notice":
      return `${marker}\nStatus notice: ${JSON.stringify(envelope)}`;
  }
}