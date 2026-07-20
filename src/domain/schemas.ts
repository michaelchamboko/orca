import { z } from "zod";

import {
  BaseWorkerResult,
  PlannerResult,
  BuilderResult,
  ReviewerResult,
  TesterResult,
  TaskEnvelope,
  ValidationFieldError,
  Role
} from "./types.js";

const nonEmptyString = z.string().trim().min(1);

export const roleSchema = z.union([
  z.literal("orchestrator"),
  z.literal("planner"),
  z.literal("builder"),
  z.literal("reviewer"),
  z.literal("tester")
]);

export const evidenceRequirementSchema = z.union([
  z.literal("summary"),
  z.literal("files"),
  z.literal("commands"),
  z.literal("tests"),
  z.literal("findings"),
  z.literal("risk_summary"),
  z.literal("recommended_next_action")
]);

export const taskEnvelopeSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    missionId: nonEmptyString,
    taskId: nonEmptyString,
    role: z.union([z.literal("planner"), z.literal("builder"), z.literal("reviewer"), z.literal("tester")]),
    objective: nonEmptyString,
    acceptanceCriteria: z.array(nonEmptyString).min(1),
    constraints: z.array(z.string()),
    requiredEvidence: z
      .array(evidenceRequirementSchema)
      .min(1)
      .refine((items) => new Set(items).size === items.length, {
        message: "requiredEvidence must not contain duplicates"
      }),
    parentTaskIds: z.array(z.string()),
    attempt: z.number().int().min(1),
    projectRoot: nonEmptyString,
    baseCommit: nonEmptyString,
    sourceWorkspaceFingerprint: nonEmptyString,
    allowedPaths: z.array(nonEmptyString).optional(),
    createdAt: z.string().datetime({ offset: true }).or(nonEmptyString),
    timeoutMs: z.number().int().positive()
  })
  .strict();

export const baseWorkerResultSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    missionId: nonEmptyString,
    taskId: nonEmptyString,
    role: z.union([z.literal("planner"), z.literal("builder"), z.literal("reviewer"), z.literal("tester")]),
    status: z.union([z.literal("completed"), z.literal("blocked"), z.literal("failed")]),
    summary: z.string(),
    workPerformed: z.array(nonEmptyString),
    files: z.array(
      z.object({
        path: nonEmptyString,
        action: z.union([z.literal("read"), z.literal("created"), z.literal("modified"), z.literal("deleted")]),
        summary: nonEmptyString
      })
    ),
    commands: z.array(
      z.object({
        command: nonEmptyString,
        exitCode: z.number().int().nullable(),
        summary: nonEmptyString
      })
    ),
    tests: z.array(
      z.object({
        name: nonEmptyString,
        command: nonEmptyString,
        status: z.union([z.literal("passed"), z.literal("failed"), z.literal("not_run")]),
        evidence: z.string()
      })
    ),
    findings: z.array(
      z.object({
        severity: z.union([
          z.literal("info"),
          z.literal("low"),
          z.literal("medium"),
          z.literal("high"),
          z.literal("critical")
        ]),
        title: nonEmptyString,
        description: nonEmptyString,
        file: z.string().optional(),
        line: z.number().int().positive().optional(),
        blocking: z.boolean()
      })
    ),
    risks: z.array(nonEmptyString),
    questions: z.array(nonEmptyString),
    recommendedNextAction: z.string(),
    sourceWorkspaceFingerprint: nonEmptyString,
    completedAt: z.string().datetime({ offset: true }).or(nonEmptyString)
  })
  .strict();

export const plannerResultPayloadSchema = z
  .object({
    planVerdict: z.union([z.literal("ready"), z.literal("blocked")]),
    implementationSteps: z.array(nonEmptyString).min(1),
    expectedFiles: z.array(nonEmptyString),
    validationPlan: z.array(nonEmptyString)
  })
  .strict();

export const builderResultPayloadSchema = z
  .object({
    implementationVerdict: z.union([z.literal("implemented"), z.literal("blocked"), z.literal("failed")]),
    changedFiles: z.array(nonEmptyString),
    targetedTestsRun: z.array(nonEmptyString)
  })
  .strict();

export const reviewerResultPayloadSchema = z
  .object({
    reviewVerdict: z.union([z.literal("pass"), z.literal("changes_required"), z.literal("blocked")]),
    reviewedWorkspaceFingerprint: nonEmptyString
  })
  .strict();

export const testerResultPayloadSchema = z
  .object({
    testVerdict: z.union([z.literal("pass"), z.literal("fail"), z.literal("blocked")]),
    testedWorkspaceFingerprint: nonEmptyString,
    requiredChecks: z.array(nonEmptyString),
    passedChecks: z.array(nonEmptyString),
    failedChecks: z.array(nonEmptyString)
  })
  .strict();

const withPlannerRules = baseWorkerResultSchema.extend({
  role: z.literal("planner")
}).extend(plannerResultPayloadSchema.shape);

const withBuilderRules = baseWorkerResultSchema.extend({
  role: z.literal("builder")
}).extend(builderResultPayloadSchema.shape)
  .superRefine((value, ctx) => {
    if (value.implementationVerdict === "implemented" && value.changedFiles.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["changedFiles"],
        message: "changedFiles must be present when implementationVerdict is implemented"
      });
    }
  });

const withReviewerRules = baseWorkerResultSchema
  .extend({ role: z.literal("reviewer") })
  .extend(reviewerResultPayloadSchema.shape)
  .superRefine((value, ctx) => {
    if (
      value.reviewVerdict === "pass" &&
      value.findings.some((finding) => finding.blocking && (finding.severity === "high" || finding.severity === "critical"))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reviewVerdict"],
        message: "pass verdict cannot include blocking high or critical findings"
      });
    }
  });

const withTesterRules = baseWorkerResultSchema
  .extend({ role: z.literal("tester") })
  .extend(testerResultPayloadSchema.shape)
  .superRefine((value, ctx) => {
    if (value.testVerdict === "pass") {
      if (value.requiredChecks.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requiredChecks"],
          message: "pass verdict requires requiredChecks"
        });
      }

      for (const check of value.requiredChecks) {
        if (!value.passedChecks.includes(check)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["passedChecks"],
            message: `required check ${check} not present in passedChecks`
          });
        }
      }

      if (value.failedChecks.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["failedChecks"],
          message: "pass verdict cannot include failed checks"
        });
      }
    }
  });

export const workerResultSchemaByRole: Record<Exclude<Role, "orchestrator">, z.ZodTypeAny> = {
  planner: withPlannerRules,
  builder: withBuilderRules,
  reviewer: withReviewerRules,
  tester: withTesterRules
};

export function parseTaskEnvelope(input: unknown): TaskEnvelope {
  return taskEnvelopeSchema.parse(input);
}

export function parseWorkerResult(
  role: Exclude<Role, "orchestrator">,
  missionId: string,
  taskId: string,
  input: unknown
): BaseWorkerResult &
  (PlannerResult | BuilderResult | ReviewerResult | TesterResult) {
  const schema = workerResultSchemaByRole[role];
  const parsed = schema.parse(input) as
    BaseWorkerResult &
    (PlannerResult | BuilderResult | ReviewerResult | TesterResult);

  if (parsed.missionId !== missionId) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: ["missionId"],
        message: `missionId mismatch: expected ${missionId}, received ${parsed.missionId}`
      }
    ]);
  }

  if (parsed.taskId !== taskId) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: ["taskId"],
        message: `taskId mismatch: expected ${taskId}, received ${parsed.taskId}`
      }
    ]);
  }

  if (parsed.role !== role) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: ["role"],
        message: `role mismatch: expected ${role}, received ${parsed.role}`
      }
    ]);
  }

  return parsed;
}

export function formatValidationErrors(error: z.ZodError): ValidationFieldError[] {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message
  }));
}
