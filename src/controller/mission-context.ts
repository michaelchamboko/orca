import { createHash } from "node:crypto";

import type { OpenCodeLiveAdapter } from "../integrations/opencode/adapter.js";
import type {
  MissionState,
  ModelRef,
  PairedRoster,
  Role,
  TaskEnvelope
} from "../domain/types.js";
import type { OrchestratorAction } from "../domain/action-schemas.js";
import { RosterService } from "../pairing/roster-service.js";
import type {
  DispatchOutboxAction,
  DispatchPurpose
} from "../persistence/sqlite.js";
import type { WorkflowPersistence } from "./workflow-persistence.js";
import { MissionService } from "./mission-service.js";
import { OrchestratorActionIntake } from "./orchestrator-actions.js";

const ROLE_TIMEOUT_MS = 10 * 60_000;

export type DecisionGate = "plan" | "builder" | "review" | "test" | "final";

export interface MissionContextBindings {
  getRoster(): Promise<PairedRoster>;
  bind(role: Role): { sessionId: string; agentName: string; model: ModelRef };
  nextTaskForRole(role: Exclude<Role, "orchestrator">, missionId: string, attempt: number): {
    envelope: TaskEnvelope;
    targetSessionId: string;
    capturedModel: ModelRef;
    promptMessageId: string;
    dispatchKey: string;
  };
  nextDecisionPrompt(missionId: string, gate: DecisionGate, taskId: string): {
    targetSessionId: string;
    capturedModel: ModelRef;
    promptMessageId: string;
    dispatchKey: string;
  };
  publishNotice?(content: string, correlationId: string): Promise<void>;
}

export interface MissionContext {
  missionService: MissionService;
  orchestratorActionIntake: OrchestratorActionIntake;
  consumeCompletedTasks(): number;
}

/**
 * Builds the durable controller context that connects MissionService to the
 * outbox, roster, and persistence. The returned object is the single source of
 * truth for the reconciliation cycle and the orchestrator-action intake.
 */
export function buildMissionContext(options: {
  adapter: OpenCodeLiveAdapter;
  persistence: WorkflowPersistence;
  rosterService: RosterService;
  bindings: MissionContextBindings;
}): MissionContext {
  const missionService = new MissionService(options.persistence, options.adapter, options.bindings);

  const resolveDecisionPrompt = async (
    messageId: string
  ): Promise<{ missionId: string; gate: DecisionGate } | null> => {
    const dispatch = options.persistence.getDispatchByPromptMessageId(messageId);
    if (!dispatch) return null;
    if (dispatch.purpose !== "orchestrator_decision") return null;
    const gate = dispatch.promptPayload.gate;
    if (typeof gate !== "string") return null;
    if (gate !== "plan" && gate !== "builder" && gate !== "review" && gate !== "test" && gate !== "final") return null;
    return { missionId: dispatch.missionId, gate };
  };

  const consumePendingApproval = async (
    action: OrchestratorAction,
    messageId: string,
    _decisionPromptMessageId: string
  ): Promise<"applied" | "superseded" | "rejected"> => {
    void _decisionPromptMessageId;
    const mission = options.persistence.getMission(action.missionId);
    if (!mission) return "rejected";
    const priorState = mission.state;
    const result = missionService.applyOrchestratorAction(action, messageId);
    if (result.missionBlocked) return "rejected";
    if (!result.applied) return "rejected";
    if (priorState === mission.state) return "superseded";
    return "applied";
  };

  const orchestratorActionIntake = new OrchestratorActionIntake(
    options.adapter,
    options.persistence,
    {
      getRoster: () => options.rosterService.assertCurrent(),
      resolveDecisionPrompt,
      consumePendingApproval
    }
  );

  return {
    missionService,
    orchestratorActionIntake,
    consumeCompletedTasks: () => missionService.reconcileCompletedTasks()
  };
}

/**
 * Builds deterministic next-task descriptors for worker roles. Produces
 * envelope, target session, captured model, prompt message id, and dispatch
 * key without consulting live adapter state so retries are idempotent.
 *
 * The mission id is supplied at call time (`nextTaskForRole(role, missionId, attempt)`)
 * so the same bindings can serve every mission in the controller's lifetime and
 * every dispatched task, decision prompt, dispatch key, and snapshot references
 * the actual mission id — never a synthetic placeholder such as `"bootstrap"`.
 */
export function createMissionBindings(roster: PairedRoster): MissionContextBindings {
  const findBinding = (role: Exclude<Role, "orchestrator">) => {
    const binding = roster.bindings.find((candidate) => candidate.role === role);
    if (!binding) throw new Error(`roster drift: missing binding for ${role}`);
    return binding;
  };

  return {
    getRoster: async () => roster,
    bind(role: Role) {
      const binding = roster.bindings.find((candidate) => candidate.role === role);
      if (!binding) throw new Error(`roster drift: missing binding for ${role}`);
      return { sessionId: binding.sessionId, agentName: binding.agentName, model: { ...binding.model } };
    },
    nextTaskForRole(role: Exclude<Role, "orchestrator">, missionId: string, attempt: number) {
      if (!missionId) throw new Error("nextTaskForRole requires the actual mission id");
      const binding = findBinding(role);
      const taskId = stableId("task", role, missionId, attempt);
      const promptMessageId = stableId("orca-prompt", role, missionId, attempt);
      const dispatchKey = stableId("dispatch", role, missionId, attempt);
      const envelope: TaskEnvelope = {
        schemaVersion: "1.0",
        missionId,
        taskId,
        role,
        objective: "controller-dispatched task",
        acceptanceCriteria: [],
        constraints: [],
        requiredEvidence: ["summary"],
        parentTaskIds: [],
        attempt,
        projectRoot: roster.projectRoot,
        baseCommit: "0000000",
        sourceWorkspaceFingerprint: "fingerprint",
        createdAt: new Date().toISOString(),
        timeoutMs: ROLE_TIMEOUT_MS
      };
      return {
        envelope,
        targetSessionId: binding.sessionId,
        capturedModel: { ...binding.model },
        promptMessageId,
        dispatchKey
      };
    },
    nextDecisionPrompt(missionId: string, gate: DecisionGate, taskId: string) {
      if (!missionId) throw new Error("nextDecisionPrompt requires the actual mission id");
      const binding = roster.bindings.find((candidate) => candidate.role === "orchestrator");
      if (!binding) throw new Error("roster drift: missing orchestrator binding");
      const seed = `${missionId}-${gate}-${taskId}`;
      const promptMessageId = stableId("orca-decision", gate as unknown as Role, seed, 1);
      const dispatchKey = stableId("dispatch-decision", gate as unknown as Role, seed, 1);
      return {
        targetSessionId: binding.sessionId,
        capturedModel: { ...binding.model },
        promptMessageId,
        dispatchKey
      };
    }
  };
}

function stableId(prefix: string, role: Role, missionId: string, attempt: number): string {
  return `${prefix}-${createHash("sha256").update(`${missionId}:${role}:${attempt}`).digest("hex").slice(0, 32)}`;
}

export function dispatchPurposeForMissionState(state: MissionState): DispatchPurpose {
  switch (state) {
    case "awaiting_plan_approval":
    case "awaiting_builder_approval":
    case "awaiting_review_approval":
    case "awaiting_test_approval":
    case "awaiting_final_approval":
      return "orchestrator_decision";
    case "completed":
      return "final_completion";
    default:
      return "worker_task";
  }
}

export function isPendingDispatchForCurrentMission(action: DispatchOutboxAction, missionId: string | null): boolean {
  if (action.acknowledgedAt) return false;
  if (!missionId) return true;
  return action.missionId === missionId;
}