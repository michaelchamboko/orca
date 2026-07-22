import { createHash } from "node:crypto";

import type { OpenCodeLiveAdapter } from "../integrations/opencode/adapter.js";
import type { OpenCodeMessage } from "../integrations/opencode/types.js";
import type { PairedRoster, TaskEnvelope } from "../domain/types.js";
import { RosterService } from "../pairing/roster-service.js";
import type { WorkflowPersistence } from "./workflow-persistence.js";
import { captureProvisionalDispatchBaseline } from "./workspace-baseline.js";
import { DispatchOutbox } from "./dispatch-outbox.js";

const TASK_TIMEOUT_MS = 10 * 60_000;

export class MissionIngress {
  private startupCutoff: Date | undefined;
  constructor(
    private readonly projectRoot: string,
    private readonly adapter: OpenCodeLiveAdapter,
    private readonly persistence: WorkflowPersistence,
    private readonly rosterService: RosterService,
    private readonly dispatch: DispatchOutbox
  ) {}

  async processStartup(cutoff: Date): Promise<void> {
    const roster = await this.rosterService.assertCurrent();
    const cutoffKey = `controller:mission-ingress-cutoff:${roster.rosterId}`;
    const persisted = this.persistence.getControllerCheckpoint(cutoffKey);
    const persistedTime = persisted ? Date.parse(persisted.cursor) : Number.NaN;
    this.startupCutoff = Number.isFinite(persistedTime) && persistedTime < cutoff.getTime() ? new Date(persistedTime) : cutoff;
    this.persistence.saveControllerCheckpoint({ cursorKey: cutoffKey, rosterId: roster.rosterId, cursor: this.startupCutoff.toISOString(), payload: { kind: "startup_cutoff" } });
    const orchestrator = bindingFor(roster, "orchestrator");
    for (const message of await this.adapter.listMessages(orchestrator.sessionId)) await this.process(message, this.startupCutoff);
  }

  async processEvent(sessionId: string | undefined, messageId: string | undefined): Promise<void> {
    if (!sessionId || !messageId) return;
    const roster = this.persistence.getCurrentRoster();
    const orchestrator = roster && roster.bindings.find((binding) => binding.role === "orchestrator");
    if (!orchestrator || sessionId !== orchestrator.sessionId) return;
    await this.process(await this.adapter.getMessage(sessionId, messageId));
  }

  async poll(): Promise<void> {
    const roster = this.persistence.getCurrentRoster();
    const orchestrator = roster && roster.bindings.find((binding) => binding.role === "orchestrator");
    if (!orchestrator) return;
    for (const message of await this.adapter.listMessages(orchestrator.sessionId)) await this.process(message);
  }

  private async process(message: OpenCodeMessage, historicalCutoff?: Date): Promise<void> {
    const roster = this.persistence.getCurrentRoster();
    const orchestrator = roster && roster.bindings.find((binding) => binding.role === "orchestrator");
    if (!roster || !orchestrator || message.sessionId !== orchestrator.sessionId || message.role !== "user") return;
    const cutoff = historicalCutoff ?? this.startupCutoff;
    if (cutoff && Date.parse(message.createdAt) <= cutoff.getTime()) return;
    const objective = message.parts.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text ?? "").join("\n").trim();
    if (!objective || objective.includes("[ORCA_DISPATCH:") || objective.includes("[ORCA_CORRELATION:")) return;
    let current: PairedRoster;
    try {
      current = await this.rosterService.assertCurrent();
      if (current.projectRoot !== this.projectRoot) throw new Error("repository root mismatch");
    } catch {
      await this.explainBlockedIngress(message, orchestrator, "The paired roster is no longer valid, so this objective remains eligible for a safe retry. ");
      return;
    }
    let baseline: ReturnType<typeof captureProvisionalDispatchBaseline>;
    try { baseline = captureProvisionalDispatchBaseline(this.projectRoot); } catch {
      await this.explainBlockedIngress(message, orchestrator, "The repository baseline could not be captured, so this objective remains eligible for a safe retry. ");
      return;
    }
    const messageHash = stableId("processed", current.rosterId, message.id);
    if (!this.persistence.recordProcessedMessage({ messageHash, messageId: message.id, eventType: "mission.ingress", sessionId: message.sessionId, payload: { outcome: "validated" } })) return;
    try {
      const planner = bindingFor(current, "planner");
      const missionId = stableId("mission", current.rosterId, message.id);
      const taskId = stableId("task", current.rosterId, message.id);
      const dispatchKey = stableId("dispatch", current.rosterId, message.id);
      const promptMessageId = stableId("orca-prompt", current.rosterId, message.id);
      const envelope: TaskEnvelope = {
        schemaVersion: "1.0", missionId, taskId, role: "planner", objective,
        acceptanceCriteria: ["Return a valid Planner structured result."],
        constraints: ["No file-writing authority.", "Do not execute arbitrary commands."],
        requiredEvidence: ["summary", "files", "commands", "tests", "risk_summary", "recommended_next_action"],
        parentTaskIds: [], attempt: 1, projectRoot: current.projectRoot, baseCommit: baseline.baseCommit,
        sourceWorkspaceFingerprint: baseline.sourceWorkspaceFingerprint, createdAt: new Date().toISOString(), timeoutMs: TASK_TIMEOUT_MS
      };
      this.persistence.createMissionTaskAndDispatch({
        mission: { missionId, rosterId: current.rosterId, objective, sourceSessionMessageId: message.id, state: "planning" },
        task: { envelope, targetSessionId: planner.sessionId, controllerPromptMessageId: promptMessageId },
        dispatch: {
          dispatchKey,
          targetRole: "planner",
          targetSessionId: planner.sessionId,
          capturedModel: { ...planner.model },
          promptMessageId,
          taskId,
          purpose: "worker_task",
          parentPromptMessageId: null,
          promptPayload: { kind: "worker_task", objective, envelope }
        },
        snapshot: { snapshotId: stableId("snapshot", current.rosterId, message.id), missionId, projectRoot: current.projectRoot, fingerprint: baseline.sourceWorkspaceFingerprint, payload: baseline.payload }
      });
      await this.dispatch.recoverPending();
    } catch (error) {
      if (error instanceof Error && /unique|constraint/i.test(error.message)) {
        await this.adapter.sendPrompt({ messageId: stableId("orca-explanation", current.rosterId, message.id), sessionId: orchestrator.sessionId, agent: "orca-orchestrator", model: { ...orchestrator.model }, content: `This objective cannot start because another mission is active. [ORCA_CORRELATION:${message.id}]` });
      }
    }
  }

  private async explainBlockedIngress(message: OpenCodeMessage, orchestrator: PairedRoster["bindings"][number], explanation: string): Promise<void> {
    const rosterId = this.persistence.getCurrentRoster()?.rosterId ?? "unpaired";
    const failureIdentity = stableId("ingress-failure", rosterId, explanation);
    const cursorKey = `controller:mission-ingress-failure:${message.id}:${failureIdentity}`;
    if (this.persistence.getControllerCheckpoint(cursorKey)) return;
    this.persistence.saveControllerCheckpoint({ cursorKey, rosterId: rosterId === "unpaired" ? null : rosterId, cursor: new Date().toISOString(), payload: { outcome: "blocked", reason: explanation, failureIdentity } });
    await this.adapter.sendPrompt({ messageId: stableId("orca-explanation", rosterId, `${message.id}:${failureIdentity}`), sessionId: orchestrator.sessionId, agent: "orca-orchestrator", model: { ...orchestrator.model }, content: `${explanation}[ORCA_CORRELATION:${message.id}]` });
  }
}

function bindingFor(roster: PairedRoster, role: "orchestrator" | "planner") {
  const binding = roster.bindings.find((candidate) => candidate.role === role);
  if (!binding) throw new Error("roster drift");
  return binding;
}

export function stableId(prefix: string, rosterId: string, messageId: string): string {
  return `${prefix}-${createHash("sha256").update(`${rosterId}:${messageId}`).digest("hex").slice(0, 32)}`;
}
