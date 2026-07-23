import { createHash } from "node:crypto";

import type { OpenCodeLiveAdapter } from "../integrations/opencode/adapter.js";
import type { OpenCodeEvent, OpenCodeMessage } from "../integrations/opencode/types.js";
import type { PairedRoster } from "../domain/types.js";
import { validateOrchestratorAction, type OrchestratorAction } from "../domain/action-schemas.js";
import type { WorkflowPersistence } from "./workflow-persistence.js";
import { StableResponseTracker, initialStableResponseCheckpoint, type StableResponseCheckpoint } from "./response-stability.js";

export interface OrchestratorActionIntakeOptions {
  now?: () => number;
  quietWindowMs?: number;
}

export interface ActionIntakeContext {
  getRoster(): Promise<PairedRoster>;
  resolveDecisionPrompt(messageId: string): Promise<{ missionId: string; gate: "plan" | "builder" | "review" | "test" | "final" } | null>;
  consumePendingApproval(action: OrchestratorAction, messageId: string, decisionPromptMessageId: string): Promise<"applied" | "superseded" | "rejected">;
}

export type ActionIngestOutcome =
  | { kind: "accepted"; action: OrchestratorAction; decisionPromptMessageId: string }
  | { kind: "duplicate"; messageId: string }
  | { kind: "rejected"; reason: string; reasonCode: string };

const REASON_CODES = {
  not_orchestrator_session: "not_orchestrator_session",
  not_assistant_message: "not_assistant_message",
  no_decision_prompt: "no_decision_prompt",
  parent_mismatch: "parent_mismatch",
  not_idle: "not_idle",
  active_lineage_tool: "active_lineage_tool",
  not_stable: "not_stable",
  schema_invalid: "schema_invalid",
  already_recorded: "already_recorded"
} as const;

type IntakeCheckpoint = StableResponseCheckpoint & {
  decisionPromptMessageId?: string;
  validatedActionHash?: string;
  firstSeenAt?: number;
};

export class OrchestratorActionIntake {
  private readonly now: () => number;
  private readonly quietWindowMs: number;

  constructor(
    private readonly adapter: OpenCodeLiveAdapter,
    private readonly persistence: WorkflowPersistence,
    private readonly context: ActionIntakeContext,
    options: OrchestratorActionIntakeOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.quietWindowMs = options.quietWindowMs ?? 1_500;
  }

  async observeEvent(event: OpenCodeEvent): Promise<ActionIngestOutcome[]> {
    if (event.sessionId === undefined || event.messageId === undefined) return [];
    return this.observeMessage(event.sessionId, event.messageId);
  }

  async observeMessage(sessionId: string, messageId: string): Promise<ActionIngestOutcome[]> {
    const roster = await this.context.getRoster();
    const orchestrator = roster.bindings.find((binding) => binding.role === "orchestrator");
    if (!orchestrator || orchestrator.sessionId !== sessionId) {
      return [{ kind: "rejected", reason: "not_orchestrator_session", reasonCode: REASON_CODES.not_orchestrator_session }];
    }
    const decision = await this.context.resolveDecisionPrompt(messageId);
    if (!decision) {
      return [{ kind: "rejected", reason: "no_decision_prompt", reasonCode: REASON_CODES.no_decision_prompt }];
    }
    const decisionPromptMessageId = decision.missionId ? await this.lookupDecisionPromptMessageId(decision.missionId) : null;
    if (!decisionPromptMessageId) {
      return [{ kind: "rejected", reason: "no_decision_prompt", reasonCode: REASON_CODES.no_decision_prompt }];
    }
    let message: OpenCodeMessage;
    try { message = await this.adapter.getMessage(sessionId, messageId); }
    catch { return [{ kind: "rejected", reason: "not_idle", reasonCode: REASON_CODES.not_idle }]; }
    if (message.role !== "assistant") {
      this.recordDecisionResponse(decision.missionId, decisionPromptMessageId, messageId, hashActionEnvelopeRaw(message), "rejected", REASON_CODES.not_assistant_message, null, null);
      return [{ kind: "rejected", reason: "not_assistant_message", reasonCode: REASON_CODES.not_assistant_message }];
    }
    if (message.parentId !== decisionPromptMessageId) {
      this.recordDecisionResponse(decision.missionId, decisionPromptMessageId, messageId, hashActionEnvelopeRaw(message), "rejected", REASON_CODES.parent_mismatch, null, null);
      return [{ kind: "rejected", reason: "parent_mismatch", reasonCode: REASON_CODES.parent_mismatch }];
    }
    const status = await this.adapter.getSessionStatus(sessionId).catch(() => ({ idle: false, inFlightToolCalls: 0 }));
    if (!status.idle || status.inFlightToolCalls > 0) {
      return [{ kind: "rejected", reason: "not_idle", reasonCode: REASON_CODES.not_idle }];
    }
    const hasActiveLineageTool = (message.parts ?? []).some((part) => part.toolStatus === "pending" || part.toolStatus === "running");
    if (hasActiveLineageTool) {
      return [{ kind: "rejected", reason: "active_lineage_tool", reasonCode: REASON_CODES.active_lineage_tool }];
    }
    const text = (message.parts ?? []).filter((part) => typeof part.text === "string").map((part) => part.text).join("\n").trim();
    const payload = extractFirstJsonObject(text);
    const validation = validateOrchestratorAction(payload);
    if (!validation.ok) {
      this.recordDecisionResponse(decision.missionId, decisionPromptMessageId, messageId, hashActionEnvelopeRaw(message), "rejected", REASON_CODES.schema_invalid, null, null);
      return [{ kind: "rejected", reason: validation.error.message, reasonCode: REASON_CODES.schema_invalid }];
    }

    const actionHash = hashActionEnvelopeRaw(message);
    const checkpointKey = `controller:orchestrator-action:${decision.missionId}:${decisionPromptMessageId}:${messageId}`;
    const prior = this.loadCheckpoint(checkpointKey);
    const contentChanged = prior.validatedActionHash !== undefined && prior.validatedActionHash !== actionHash;
    const promptChanged = prior.decisionPromptMessageId !== undefined && prior.decisionPromptMessageId !== decisionPromptMessageId;
    if (promptChanged || contentChanged) {
      this.persistCheckpoint(checkpointKey, { ...initialStableResponseCheckpoint, decisionPromptMessageId });
    }
    const activePrior = this.loadCheckpoint(checkpointKey);
    const firstSeenAt = activePrior.firstSeenAt;
    const elapsed = firstSeenAt === undefined ? 0 : this.now() - firstSeenAt;
    if (elapsed < this.quietWindowMs) {
      this.persistCheckpoint(checkpointKey, {
        ...activePrior,
        decisionPromptMessageId,
        validatedActionHash: actionHash,
        firstSeenAt: firstSeenAt ?? this.now()
      });
      return [];
    }

    return this.applyValidatedAction(decision.missionId, decisionPromptMessageId, messageId, validation.value, message);
  }

  private firstSeenAt(): number | null {
    return null;
  }

  private async applyValidatedAction(missionId: string, decisionPromptMessageId: string, messageId: string, action: OrchestratorAction, message: OpenCodeMessage): Promise<ActionIngestOutcome[]> {
    const recorded = this.persistence.recordOrchestratorActionMessage({
      missionId: action.missionId,
      messageId,
      sessionId: message.sessionId,
      parentMessageId: message.parentId ?? null,
      decisionPromptMessageId,
      rawPayload: JSON.stringify(action),
      parsedPayload: { ...action },
      action: action.action,
      taskId: action.taskId ?? null
    });
    if (recorded.id === 0) {
      this.persistence.markOrchestratorActionMessageAccepted(messageId);
      return [{ kind: "duplicate", messageId }];
    }
    this.persistence.markOrchestratorActionMessageAccepted(messageId);
    this.recordDecisionResponse(missionId, decisionPromptMessageId, messageId, hashActionEnvelopeRaw(message), "accepted", null, action.taskId ?? null, action.action);
    const outcome = await this.context.consumePendingApproval(action, messageId, decisionPromptMessageId);
    if (outcome === "superseded") {
      this.persistence.recordMissionEvent(action.missionId, action.taskId ?? null, "orchestrator_action.superseded", { action: action.action, messageId });
    } else if (outcome === "rejected") {
      this.persistence.recordMissionEvent(action.missionId, action.taskId ?? null, "orchestrator_action.rejected", { action: action.action, messageId, reason: "stale_or_invalid_gate" });
    } else {
      this.persistence.recordMissionEvent(action.missionId, action.taskId ?? null, "orchestrator_action.applied", { action: action.action, messageId });
    }
    return [{ kind: "accepted", action, decisionPromptMessageId }];
  }

  private loadCheckpoint(key: string): IntakeCheckpoint {
    const raw = this.persistence.getControllerCheckpoint(key)?.payload as IntakeCheckpoint | undefined;
    return { ...initialStableResponseCheckpoint, ...raw };
  }

  private persistCheckpoint(key: string, checkpoint: IntakeCheckpoint): void {
    const roster = this.persistence.getCurrentRoster();
    this.persistence.saveControllerCheckpoint({
      cursorKey: key,
      rosterId: roster?.rosterId ?? null,
      cursor: new Date(this.now()).toISOString(),
      payload: { ...checkpoint }
    });
  }

  private trackerFor(checkpoint: StableResponseCheckpoint): StableResponseTracker {
    return new StableResponseTracker(checkpoint);
  }

  private async lookupDecisionPromptMessageId(missionId: string): Promise<string | null> {
    const events = this.persistence.getMissionEvents(missionId);
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event.eventType === "task.dispatched" && event.payload && typeof (event.payload as Record<string, unknown>).purpose === "string" && (event.payload as Record<string, unknown>).purpose === "orchestrator_decision") {
        const promptId = (event.payload as Record<string, unknown>).promptMessageId;
        if (typeof promptId === "string") return promptId;
      }
    }
    return null;
  }

  private recordDecisionResponse(missionId: string, decisionPromptMessageId: string, responseMessageId: string, responseHash: string, outcome: "accepted" | "rejected", reasonCode: string | null, taskId: string | null, action: string | null): void {
    this.persistence.recordOrchestratorDecisionResponse({ missionId, decisionPromptMessageId, responseMessageId, responseHash, outcome, reasonCode, taskId, action });
  }
}

function extractFirstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

function hashActionEnvelopeRaw(message: OpenCodeMessage): string {
  return createHash("sha256").update(JSON.stringify({ role: message.role, parentId: message.parentId, completedAt: message.completedAt, parts: (message.parts ?? []).map((part) => ({ id: part.id, type: part.type, toolStatus: part.toolStatus, text: typeof part.text === "string" })) })).digest("hex");
}
