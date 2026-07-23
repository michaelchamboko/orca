import { randomUUID } from "node:crypto";

import type { OpenCodeLiveAdapter } from "../integrations/opencode/adapter.js";
import type { ModelRef, PairedRoster, Role, TaskEnvelope } from "../domain/types.js";
import type { DispatchOutboxAction, DispatchPurpose } from "../persistence/sqlite.js";
import type { WorkflowPersistence } from "./workflow-persistence.js";
import { RosterService } from "../pairing/roster-service.js";

const LEASE_MS = 30_000;
const MAX_DELIVERY_ATTEMPTS = 3;

export interface DispatchPromptPayloadRenderer {
  render(purpose: DispatchPurpose, payload: Record<string, unknown>, marker: string): string;
}

/**
 * Generalized durable dispatch outbox. Persists intent before send, validates
 * the captured model against the current roster binding, and uses the ORCA
 * marker to avoid duplicate sends on restart. Renders prompts from the
 * discriminated payload stored on the action so taskless Orchestrator
 * dispatches never call task lookup.
 */
export class DispatchOutbox {
  private readonly renderer: DispatchPromptPayloadRenderer;

  constructor(
    private readonly adapter: OpenCodeLiveAdapter,
    private readonly persistence: WorkflowPersistence,
    private readonly rosterService: RosterService,
    renderer?: DispatchPromptPayloadRenderer
  ) {
    this.renderer = renderer ?? defaultRenderer;
  }

async recoverPending(): Promise<DispatchOutboxAction[]> {
  const owner = `dispatch-outbox-${randomUUID()}`;
  const recovered: DispatchOutboxAction[] = [];
  for (;;) {
    const action = this.persistence.claimNextDispatch(owner, LEASE_MS);
    if (!action) return recovered;
    try {
      const roster = await this.rosterService.assertCurrent();
      const binding = bindingFor(roster, action.targetRole);
      if (action.targetSessionId !== binding.sessionId) throw new Error("roster drift: session mismatch");
      if (action.capturedModel.providerId !== binding.model.providerId || action.capturedModel.modelId !== binding.model.modelId) throw new Error("roster drift: model mismatch");
      if (action.attempt > MAX_DELIVERY_ATTEMPTS) {
        await this.block(action, owner, `exceeded ${MAX_DELIVERY_ATTEMPTS} delivery attempts`);
        continue;
      }
      const marker = `[ORCA_DISPATCH:${action.dispatchKey}]`;
      const messages = await this.adapter.listMessages(action.targetSessionId);
      const correlated = messages.some((message) => message.id === action.promptMessageId || message.parts.some((part) => part.text?.includes(marker)));
      if (!correlated) {
        await this.adapter.sendPrompt({
          messageId: action.promptMessageId,
          sessionId: action.targetSessionId,
          agent: `orca-${binding.role}`,
          model: { ...binding.model },
          content: this.renderer.render(action.purpose, action.promptPayload, marker)
        });
      }
      this.persistence.acknowledgeDispatch(action.id, owner);
      if (action.taskId) this.persistence.setTaskExecutionState(action.taskId, "dispatched");
      recovered.push(action);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "dispatch delivery failed";
      if (reason.startsWith("roster drift")) {
        await this.block(action, owner, reason);
        continue;
      }
      if (action.attempt >= MAX_DELIVERY_ATTEMPTS) {
        await this.block(action, owner, reason);
        continue;
      }
      this.persistence.releaseDispatch(action.id, owner, reason);
    }
  }
}

  private async block(action: DispatchOutboxAction, owner: string, reason: string): Promise<void> {
    this.persistence.runInTransaction(() => {
      this.persistence.setMissionFailure(action.missionId, reason);
      if (action.taskId) this.persistence.blockTaskExecution(action.taskId, reason);
    });
    this.persistence.acknowledgeDispatch(action.id, owner);
  }
}

function bindingFor(roster: PairedRoster, role: Role) {
  const binding = roster.bindings.find((candidate) => candidate.role === role);
  if (!binding) throw new Error("roster drift: missing binding");
  return binding;
}

export const defaultRenderer: DispatchPromptPayloadRenderer = {
  render(purpose, payload, marker) {
    switch (purpose) {
      case "worker_task": {
        const objective = (payload.objective as string | undefined) ?? "";
        return `${marker}\nReturn only a valid structured result for this task.\n\nSource objective:\n${objective}\n\nTask envelope:\n${JSON.stringify(payload.envelope ?? {})}`;
      }
      case "contract_repair": {
        const envelope = payload.envelope as TaskEnvelope | undefined;
        const original = (payload.originalPromptMessageId as string | undefined) ?? "";
        const objective = (payload.objective as string | undefined) ?? "";
        return `${marker}\nYour previous result was invalid. Reply with only valid JSON for this same task.\nOriginal prompt: ${original}\nSource objective:\n${objective}\nTask envelope:\n${JSON.stringify(envelope ?? {})}`;
      }
      case "orchestrator_decision": {
        const taskId = (payload.taskId as string | undefined) ?? "";
        const gate = (payload.gate as string | undefined) ?? "plan";
        return `${marker}\nMission ${payload.missionId} requires a decision on task ${taskId} (gate=${gate}). Reply with only valid OrchestratorAction JSON.`;
      }
      case "final_completion":
        return `${marker}\nAll gates approved for mission ${payload.missionId ?? ""}. Provide final completion summary.`;
      case "status_notice":
        return `${marker}\nStatus notice (${payload.code ?? "unknown"}): ${payload.message ?? ""}`;
    }
  }
};

export function modelRefFromBinding(binding: { model: ModelRef }): ModelRef {
  return { providerId: binding.model.providerId, modelId: binding.model.modelId };
}