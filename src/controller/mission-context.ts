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

export type FindingSeverity = "info" | "low" | "medium" | "high" | "critical";

export interface MissionFinding {
  severity: FindingSeverity;
  title: string;
  description: string;
  file?: string;
  line?: number;
  blocking: boolean;
}

export interface PlannerEvidence {
  sourceTaskId: string;
  planVerdict: "ready" | "blocked";
  implementationSteps: string[];
  expectedFiles: string[];
  validationPlan: string[];
  acceptanceCriteria: string[];
  summary: string;
  sourceWorkspaceFingerprint: string;
  completedAt: string;
}

export interface BuilderEvidence {
  sourceTaskId: string;
  implementationVerdict: "implemented" | "blocked" | "failed";
  changedFiles: string[];
  targetedTestsRun: string[];
  summary: string;
  findings: MissionFinding[];
  sourceWorkspaceFingerprint: string;
  completedAt: string;
}

export interface ReviewerFindings {
  sourceTaskId: string;
  reviewVerdict: "pass" | "changes_required" | "blocked";
  reviewedWorkspaceFingerprint: string;
  findings: MissionFinding[];
  summary: string;
  completedAt: string;
}

export interface ControllerCheckEvidence {
  configHash: string;
  testedWorkspaceFingerprint: string;
  requiredChecks: string[];
  passedChecks: string[];
  failedChecks: string[];
  capturedAt: string;
}

export interface BuilderCorrectionContext {
  rejectedRole: "reviewer" | "tester";
  rejectedVerdict: string;
  rejectedFindings: MissionFinding[];
  correctionInstructions: string[];
}

export interface MissionTaskContext {
  objective: string;
  sourceWorkspaceFingerprint: string;
  plannerEvidence?: PlannerEvidence;
  builderEvidence?: BuilderEvidence;
  reviewerFindings?: ReviewerFindings;
  controllerChecks?: ControllerCheckEvidence;
  correction?: BuilderCorrectionContext;
}

export interface MissionTaskDescriptor {
  envelope: TaskEnvelope;
  promptPayload: Record<string, unknown>;
  targetSessionId: string;
  capturedModel: ModelRef;
  promptMessageId: string;
  dispatchKey: string;
}

export interface MissionContextBindings {
  getRoster(): Promise<PairedRoster>;
  bind(role: Role): { sessionId: string; agentName: string; model: ModelRef };
  nextTaskForRole(
    role: Exclude<Role, "orchestrator">,
    missionId: string,
    attempt: number,
    context: MissionTaskContext
  ): MissionTaskDescriptor;
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
    const prior = options.persistence.getMission(action.missionId);
    if (!prior) return "rejected";
    const priorState = prior.state;
    const result = missionService.applyOrchestratorAction(action, messageId);
    if (result.missionBlocked) return "rejected";
    if (!result.applied) return "rejected";
    const after = options.persistence.getMission(action.missionId);
    if (!after || after.state === priorState) return "superseded";
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
 * envelope, target session, captured model, prompt message id, dispatch key,
 * AND the complete prompt payload so the dispatcher can persist the payload
 * transactionally with the task and dispatch intent.
 *
 * The mission id is supplied at call time (`nextTaskForRole(role, missionId, attempt, context)`)
 * so the same bindings can serve every mission in the controller's lifetime and
 * every dispatched task, decision prompt, dispatch key, and snapshot references
 * the actual mission id ΓÇö never a synthetic placeholder such as `"bootstrap"`.
 *
 * Each role requires the upstream context required to do useful work; missing
 * required context throws `MissionContextError` so dispatch fails fast instead
 * of sending an empty `controller-dispatched task` placeholder.
 */
export function createMissionBindings(roster: PairedRoster): MissionContextBindings {
  const findBinding = (role: Exclude<Role, "orchestrator">) => {
    const binding = roster.bindings.find((candidate) => candidate.role === role);
    if (!binding) throw new MissionContextError(`roster drift: missing binding for ${role}`);
    return binding;
  };

  return {
    getRoster: async () => roster,
    bind(role: Role) {
      const binding = roster.bindings.find((candidate) => candidate.role === role);
      if (!binding) throw new MissionContextError(`roster drift: missing binding for ${role}`);
      return { sessionId: binding.sessionId, agentName: binding.agentName, model: { ...binding.model } };
    },
    nextTaskForRole(role, missionId, attempt, context) {
      if (!missionId) throw new MissionContextError("nextTaskForRole requires the actual mission id");
      const binding = findBinding(role);
      validateRoleContext(role, context);
      const taskId = stableId("task", role, missionId, attempt);
      const promptMessageId = stableId("orca-prompt", role, missionId, attempt);
      const dispatchKey = stableId("dispatch", role, missionId, attempt);
      const envelope = buildEnvelope(role, missionId, taskId, attempt, context);
      const promptPayload = buildPromptPayload(role, context);
      return {
        envelope,
        promptPayload,
        targetSessionId: binding.sessionId,
        capturedModel: { ...binding.model },
        promptMessageId,
        dispatchKey
      };
    },
    nextDecisionPrompt(missionId: string, gate: DecisionGate, taskId: string) {
      if (!missionId) throw new MissionContextError("nextDecisionPrompt requires the actual mission id");
      const binding = roster.bindings.find((candidate) => candidate.role === "orchestrator");
      if (!binding) throw new MissionContextError("roster drift: missing orchestrator binding");
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

export class MissionContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissionContextError";
  }
}

function validateRoleContext(role: Exclude<Role, "orchestrator">, context: MissionTaskContext): void {
  if (!context.objective || !context.objective.trim()) {
    throw new MissionContextError(`mission context requires a non-empty objective for ${role}`);
  }
  if (!context.sourceWorkspaceFingerprint || !context.sourceWorkspaceFingerprint.trim()) {
    throw new MissionContextError(`mission context requires a sourceWorkspaceFingerprint for ${role}`);
  }
  if (role === "builder") {
    if (!context.plannerEvidence && !context.correction) {
      throw new MissionContextError(`builder task requires approved planner evidence or a correction context`);
    }
    if (context.plannerEvidence && context.plannerEvidence.sourceWorkspaceFingerprint !== context.sourceWorkspaceFingerprint) {
      throw new MissionContextError(`builder task fingerprint does not match planner evidence fingerprint`);
    }
  }
  if (role === "reviewer") {
    if (!context.builderEvidence) {
      throw new MissionContextError(`reviewer task requires builder evidence`);
    }
    if (context.builderEvidence.sourceWorkspaceFingerprint !== context.sourceWorkspaceFingerprint) {
      throw new MissionContextError(`reviewer task fingerprint does not match builder evidence fingerprint`);
    }
  }
  if (role === "tester") {
    if (!context.controllerChecks) {
      throw new MissionContextError(`tester task requires controller check evidence`);
    }
    if (context.controllerChecks.testedWorkspaceFingerprint !== context.sourceWorkspaceFingerprint) {
      throw new MissionContextError(`tester task fingerprint does not match controller check fingerprint`);
    }
  }
}

function buildEnvelope(
  role: Exclude<Role, "orchestrator">,
  missionId: string,
  taskId: string,
  attempt: number,
  context: MissionTaskContext
): TaskEnvelope {
  const objective = context.objective.trim();
  const baseEnvelope: TaskEnvelope = {
    schemaVersion: "1.0",
    missionId,
    taskId,
    role,
    objective,
    acceptanceCriteria: ["Return a valid structured result."],
    constraints: ["No file-writing authority for non-builder roles.", "Do not execute arbitrary commands."],
    requiredEvidence: ["summary"],
    parentTaskIds: [],
    attempt,
    projectRoot: "",
    baseCommit: "0000000",
    sourceWorkspaceFingerprint: context.sourceWorkspaceFingerprint,
    createdAt: new Date().toISOString(),
    timeoutMs: ROLE_TIMEOUT_MS
  };
  if (role === "planner") {
    return {
      ...baseEnvelope,
      constraints: ["No file-writing authority.", "Do not execute arbitrary commands."],
      requiredEvidence: ["summary", "files", "commands", "tests", "risk_summary", "recommended_next_action"]
    };
  }
  if (role === "builder" && context.plannerEvidence) {
    const plan = context.plannerEvidence;
    return {
      ...baseEnvelope,
      objective: `${plan.summary ? `${plan.summary}\n\n` : ""}Original objective: ${objective}`,
      acceptanceCriteria: [
        "Implement the approved planner plan.",
        ...plan.expectedFiles.map((path) => `Touch expected file: ${path}`),
        ...plan.implementationSteps.map((step) => `Step: ${step}`)
      ],
      constraints: ["Write only inside the project root.", "Run the planned validation steps before reporting completion."],
      requiredEvidence: ["summary", "files", "commands", "tests", "risk_summary", "recommended_next_action"],
      parentTaskIds: [plan.sourceTaskId]
    };
  }
  if (role === "builder" && context.correction) {
    const correction = context.correction;
    const findingsText = correction.rejectedFindings
      .map((finding) => `- [${finding.severity}] ${finding.title}${finding.blocking ? " (blocking)" : ""}: ${finding.description}${finding.file ? ` (file: ${finding.file}${finding.line ? `:${finding.line}` : ""})` : ""}`)
      .join("\n");
    const instructionsText = correction.correctionInstructions.length > 0
      ? `Orchestrator correction instructions:\n${correction.correctionInstructions.map((instruction) => `- ${instruction}`).join("\n")}`
      : "No additional orchestrator correction instructions were provided.";
    return {
      ...baseEnvelope,
      objective: `Original objective: ${objective}\n\nRejection source: ${correction.rejectedRole} (verdict=${correction.rejectedVerdict}).\n\nRejected findings:\n${findingsText || "(none)"}\n\n${instructionsText}`,
      acceptanceCriteria: [
        "Address every blocking rejected finding.",
        "Add or update tests covering the rejected finding.",
        "Preserve all previously approved files unless the rejection explicitly removes them."
      ],
      constraints: ["Write only inside the project root.", "Re-run targeted tests for the corrected area before reporting completion."],
      requiredEvidence: ["summary", "files", "commands", "tests", "risk_summary", "recommended_next_action"]
    };
  }
  if (role === "reviewer" && context.builderEvidence) {
    const builder = context.builderEvidence;
    return {
      ...baseEnvelope,
      objective: `Original objective: ${objective}\n\nBuilder summary: ${builder.summary}\nBuilder verdict: ${builder.implementationVerdict}\nBuilder changed files: ${builder.changedFiles.join(", ") || "(none)"}`,
      acceptanceCriteria: [
        "Verify the Builder's changed files against the original objective.",
        "Emit one blocking finding for every high/critical issue you observe."
      ],
      constraints: ["Read-only.", "Do not execute arbitrary commands."],
      requiredEvidence: ["summary", "files", "findings", "risk_summary", "recommended_next_action"],
      parentTaskIds: [builder.sourceTaskId]
    };
  }
  if (role === "tester" && context.controllerChecks) {
    const checks = context.controllerChecks;
    const checkSummary = [
      `requiredChecks: ${checks.requiredChecks.join(", ") || "(none)"}`,
      `passedChecks: ${checks.passedChecks.join(", ") || "(none)"}`,
      `failedChecks: ${checks.failedChecks.join(", ") || "(none)"}`
    ].join("\n");
    return {
      ...baseEnvelope,
      objective: `Original objective: ${objective}\n\nController-generated check evidence:\n${checkSummary}`,
      acceptanceCriteria: [
        "All requiredChecks must be in passedChecks.",
        "No entry in failedChecks may be present in a passing verdict."
      ],
      constraints: ["Read-only.", "Do not execute arbitrary shell commands; consume the controller check evidence."],
      requiredEvidence: ["summary", "files", "tests", "findings", "risk_summary", "recommended_next_action"]
    };
  }
  return baseEnvelope;
}

function buildPromptPayload(role: Exclude<Role, "orchestrator">, context: MissionTaskContext): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    kind: "worker_task",
    objective: context.objective,
    sourceWorkspaceFingerprint: context.sourceWorkspaceFingerprint
  };
  if (role === "builder" && context.plannerEvidence) {
    payload.plannerEvidence = context.plannerEvidence;
  }
  if (role === "builder" && context.correction) {
    payload.correction = context.correction;
  }
  if (role === "reviewer" && context.builderEvidence) {
    payload.builderEvidence = context.builderEvidence;
  }
  if (role === "tester" && context.controllerChecks) {
    payload.controllerChecks = context.controllerChecks;
  }
  return payload;
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
