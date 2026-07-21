import { createHash } from "node:crypto";

import type { OpenCodeLiveAdapter } from "../integrations/opencode/adapter.js";
import type { OpenCodeMessage } from "../integrations/opencode/types.js";
import type { PairedRoster, TaskEnvelope } from "../domain/types.js";
import { RosterService } from "../pairing/roster-service.js";
import type { WorkflowPersistence } from "./workflow-persistence.js";
import { captureProvisionalDispatchBaseline } from "./workspace-baseline.js";
import { PlannerDispatchOutbox } from "./planner-dispatch.js";

const TASK_TIMEOUT_MS = 10 * 60_000;

export class MissionIngress {
  constructor(
    private readonly projectRoot: string,
    private readonly adapter: OpenCodeLiveAdapter,
    private readonly persistence: WorkflowPersistence,
    private readonly rosterService: RosterService,
    private readonly dispatch: PlannerDispatchOutbox
  ) {}

  async processStartup(cutoff: Date): Promise<void> {
    const roster = await this.rosterService.assertCurrent();
    const orchestrator = bindingFor(roster, "orchestrator");
    for (const message of await this.adapter.listMessages(orchestrator.sessionId)) await this.process(message, cutoff);
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
    if (historicalCutoff && Date.parse(message.createdAt) <= historicalCutoff.getTime()) return;
    const objective = message.parts.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text ?? "").join("\n").trim();
    if (!objective || objective.includes("[ORCA_DISPATCH:")) return;
    const messageHash = stableId("processed", roster.rosterId, message.id);
    if (!this.persistence.recordProcessedMessage({ messageHash, messageId: message.id, eventType: "mission.ingress", sessionId: message.sessionId, payload: { outcome: "received" } })) return;
    let current: PairedRoster;
    try { current = await this.rosterService.assertCurrent(); } catch {
      return;
    }
    try {
      const planner = bindingFor(current, "planner");
      const baseline = captureProvisionalDispatchBaseline(this.projectRoot);
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
        dispatch: { dispatchKey, targetRole: "planner", targetSessionId: planner.sessionId, capturedModel: { ...planner.model }, promptMessageId },
        snapshot: { snapshotId: stableId("snapshot", current.rosterId, message.id), missionId, projectRoot: current.projectRoot, fingerprint: baseline.sourceWorkspaceFingerprint, payload: baseline.payload }
      });
      await this.dispatch.recoverPending();
    } catch (error) {
      if (error instanceof Error && /unique|constraint/i.test(error.message)) {
        await this.adapter.sendPrompt({ messageId: stableId("orca-explanation", current.rosterId, message.id), sessionId: orchestrator.sessionId, agent: "orca-orchestrator", model: { ...orchestrator.model }, content: `This objective cannot start because another mission is active. [ORCA_CORRELATION:${message.id}]` });
      }
    }
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
