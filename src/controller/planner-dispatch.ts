import { randomUUID } from "node:crypto";

import type { OpenCodeLiveAdapter } from "../integrations/opencode/adapter.js";
import type { PairedRoster, TaskEnvelope } from "../domain/types.js";
import { RosterService } from "../pairing/roster-service.js";
import type { WorkflowPersistence } from "./workflow-persistence.js";

const LEASE_MS = 30_000;

export class PlannerDispatchOutbox {
  constructor(
    private readonly adapter: OpenCodeLiveAdapter,
    private readonly persistence: WorkflowPersistence,
    private readonly rosterService: RosterService
  ) {}

  async recoverPending(): Promise<void> {
    const owner = `planner-dispatch-${randomUUID()}`;
    for (;;) {
      const action = this.persistence.claimNextDispatch(owner, LEASE_MS);
      if (!action) return;
      try {
        const roster = await this.rosterService.assertCurrent();
        const planner = bindingFor(roster, "planner");
        if (action.targetSessionId !== planner.sessionId || action.capturedModel.providerId !== planner.model.providerId || action.capturedModel.modelId !== planner.model.modelId) throw new Error("roster drift");
        const task = actionForTask(this.persistence, action.promptMessageId);
        const marker = `[ORCA_DISPATCH:${action.dispatchKey}]`;
        const messages = await this.adapter.listMessages(action.targetSessionId);
        const correlated = messages.some((message) => message.id === action.promptMessageId || message.parts.some((part) => part.text?.includes(marker)));
        if (!correlated) {
          await this.adapter.sendPrompt({
            messageId: action.promptMessageId,
            sessionId: action.targetSessionId,
            agent: "orca-planner",
            model: { ...planner.model },
            content: buildPlannerPrompt(marker, task.envelope, task.envelope.objective)
          });
        }
        this.persistence.acknowledgeDispatch(action.id, owner);
        this.persistence.setTaskExecutionState(task.envelope.taskId, "dispatched");
      } catch (error) {
        const reason = error instanceof Error && error.message === "roster drift" ? "roster drift prevented Planner dispatch" : "Planner dispatch delivery failed";
        if (reason.startsWith("roster drift")) {
          this.persistence.setMissionFailure(action.missionId, reason);
          this.persistence.setTaskExecutionState(actionForTask(this.persistence, action.promptMessageId).envelope.taskId, "failed");
          await this.explainRosterDrift(action.missionId, reason);
          this.persistence.acknowledgeDispatch(action.id, owner);
        } else {
          this.persistence.releaseDispatch(action.id, owner, reason);
        }
      }
    }
  }

  private async explainRosterDrift(missionId: string, reason: string): Promise<void> {
    const mission = this.persistence.getMission(missionId);
    const roster = this.persistence.getCurrentRoster();
    const orchestrator = roster?.bindings.find((binding) => binding.role === "orchestrator");
    if (!mission || !orchestrator) return;
    await this.adapter.sendPrompt({
      messageId: `orca-explanation-${missionId}`,
      sessionId: orchestrator.sessionId,
      agent: "orca-orchestrator",
      model: { ...orchestrator.model },
      content: `${reason}. [ORCA_CORRELATION:${mission.sourceSessionMessageId ?? missionId}]`
    });
  }
}

function actionForTask(persistence: WorkflowPersistence, promptMessageId: string) {
  return persistence.getTaskExecutionByPromptMessageId(promptMessageId)
    ?? fail(`task execution not found for prompt: ${promptMessageId}`);
}

function bindingFor(roster: PairedRoster, role: "planner") {
  const binding = roster.bindings.find((candidate) => candidate.role === role);
  if (!binding) throw new Error("roster drift");
  return binding;
}

export function buildPlannerPrompt(marker: string, envelope: TaskEnvelope, objective: string): string {
  return `${marker}\nReturn only a valid Planner structured result for this task. Do not write files.\n\nTask envelope:\n${JSON.stringify(envelope)}\n\nSource objective:\n${objective}`;
}

function fail(message: string): never { throw new Error(message); }
