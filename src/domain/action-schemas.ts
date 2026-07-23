import { z } from "zod";

export const ORCHESTRATOR_ACTION_SCHEMA_VERSION = "1.0" as const;

export const ORCHESTRATOR_ACTION_RATIONALE_MAX = 8_192;
export const ORCHESTRATOR_ACTION_CORRECTION_ITEM_MAX = 2_048;
export const ORCHESTRATOR_ACTION_CORRECTION_ITEMS_MAX = 20;

export const orchestratorActionSchema = z.object({
  schemaVersion: z.literal(ORCHESTRATOR_ACTION_SCHEMA_VERSION),
  missionId: z.string().min(1),
  action: z.union([z.literal("approve"), z.literal("reject"), z.literal("request_completion")]),
  taskId: z.string().min(1).optional(),
  rationale: z.string().max(ORCHESTRATOR_ACTION_RATIONALE_MAX),
  correctionInstructions: z.array(z.string().max(ORCHESTRATOR_ACTION_CORRECTION_ITEM_MAX)).max(ORCHESTRATOR_ACTION_CORRECTION_ITEMS_MAX)
}).strict();

export type OrchestratorAction = z.infer<typeof orchestratorActionSchema>;

export interface ValidatedOrchestratorAction {
  readonly action: OrchestratorAction;
  readonly hasTaskId: boolean;
}

export type OrchestratorActionValidationError =
  | { kind: "schema"; message: string }
  | { kind: "task_required"; message: string }
  | { kind: "task_forbidden"; message: string };

export function validateOrchestratorAction(input: unknown): { ok: true; value: OrchestratorAction } | { ok: false; error: OrchestratorActionValidationError } {
  const parsed = orchestratorActionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { kind: "schema", message: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") } };
  }
  const value = parsed.data;
  if ((value.action === "approve" || value.action === "reject") && !value.taskId) {
    return { ok: false, error: { kind: "task_required", message: `taskId is required for ${value.action}` } };
  }
  if (value.action === "request_completion" && value.taskId !== undefined) {
    return { ok: false, error: { kind: "task_forbidden", message: "taskId must be omitted for request_completion" } };
  }
  return { ok: true, value };
}

export function isRequestCompletion(action: OrchestratorAction): boolean {
  return action.action === "request_completion";
}

export function isApproval(action: OrchestratorAction): boolean {
  return action.action === "approve";
}

export function isRejection(action: OrchestratorAction): boolean {
  return action.action === "reject";
}