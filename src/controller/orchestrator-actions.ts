import { createHash } from "node:crypto";

import type { OpenCodeLiveAdapter } from "../integrations/opencode/adapter.js";
import type { OpenCodeEvent, OpenCodeMessage } from "../integrations/opencode/types.js";
import type { PairedRoster } from "../domain/types.js";
import { validateOrchestratorAction, type OrchestratorAction } from "../domain/action-schemas.js";
import type { WorkflowPersistence } from "./workflow-persistence.js";

export interface OrchestratorActionIntakeOptions {
  now?: () => number;
  quietWindowMs?: number;
}

export interface ActionIntakeContext {
  getRoster(): Promise<PairedRoster>;
  getActiveDecisionPrompt(missionId: string, gate: "plan" | "builder" | "review" | "test" | "final"): Promise<string | null>;
  consumePendingApproval(action: OrchestratorAction, messageId: string): Promise<"applied" | "superseded" | "rejected">;
}

export type ActionIngestOutcome =
  | { kind: "accepted"; action: OrchestratorAction }
  | { kind: "duplicate"; messageId: string }
  | { kind: "rejected"; reason: string };

export class OrchestratorActionIntake {
  private readonly now: () => number;
  private readonly quietWindowMs: number;
  private readonly stableSince = new Map<string, number>();

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
    const roster = await this.context.getRoster();
    const orchestrator = roster.bindings.find((binding) => binding.role === "orchestrator");
    if (!orchestrator) return [];
    if (event.sessionId !== orchestrator.sessionId) return [];
    return this.observeMessage(event.sessionId, event.messageId);
  }

  async observeMessage(sessionId: string, messageId: string): Promise<ActionIngestOutcome[]> {
    const roster = await this.context.getRoster();
    const orchestrator = roster.bindings.find((binding) => binding.role === "orchestrator");
    if (!orchestrator || orchestrator.sessionId !== sessionId) return [];
    let message: OpenCodeMessage;
    try { message = await this.adapter.getMessage(sessionId, messageId); }
    catch { return []; }
    if (message.role !== "assistant") return [];
    const text = message.parts.filter((part) => typeof part.text === "string").map((part) => part.text).join("\n").trim();
    if (!text) return [];
    return this.evaluateAssistantText(sessionId, messageId, message.parentId ?? null, text, orchestrator.sessionId);
  }

  private async evaluateAssistantText(sessionId: string, messageId: string, parentMessageId: string | null, text: string, orchestratorSessionId: string): Promise<ActionIngestOutcome[]> {
    const payload = extractFirstJsonObject(text);
    const validation = validateOrchestratorAction(payload);
    if (!validation.ok) return [];
    const action = validation.value;
    const recorded = this.persistence.recordOrchestratorActionMessage({
      missionId: action.missionId,
      messageId,
      sessionId,
      parentMessageId,
      decisionPromptMessageId: null,
      rawPayload: JSON.stringify(payload),
      parsedPayload: { ...action },
      action: action.action,
      taskId: action.taskId ?? null
    });
    if (recorded.id === 0) {
      this.persistence.markOrchestratorActionMessageAccepted(messageId);
      return [{ kind: "duplicate", messageId }];
    }
    if (parentMessageId !== null && parentMessageId !== orchestratorSessionId) {
      this.persistence.markOrchestratorActionMessageRejected(messageId, "action parent is not the controller decision prompt");
      return [{ kind: "rejected", reason: "parent mismatch" }];
    }
    this.persistence.markOrchestratorActionMessageAccepted(messageId);
    this.stableSince.set(`${sessionId}:${messageId}`, this.now());
    const outcome = await this.context.consumePendingApproval(action, messageId);
    if (outcome === "superseded") {
      this.persistence.recordMissionEvent(action.missionId, action.taskId ?? null, "orchestrator_action.superseded", { action: action.action, messageId });
    } else if (outcome === "rejected") {
      this.persistence.recordMissionEvent(action.missionId, action.taskId ?? null, "orchestrator_action.rejected", { action: action.action, messageId, reason: "stale or invalid gate" });
    } else {
      this.persistence.recordMissionEvent(action.missionId, action.taskId ?? null, "orchestrator_action.applied", { action: action.action, messageId });
    }
    return [{ kind: "accepted", action }];
  }
}

function extractFirstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

export function hashActionEnvelope(action: OrchestratorAction): string {
  return createHash("sha256").update(JSON.stringify({ missionId: action.missionId, action: action.action, taskId: action.taskId ?? null })).digest("hex");
}