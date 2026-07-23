import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

const FORBIDDEN_ARGUMENT_CHARS = ["\u0000", "\r", "\n"];
const SHELL_OPERATORS = ["&&", "||", "|", ">", "<", ";", "`", "$", "*", "?", "~"];
const MAX_ARG_LENGTH = 2_048;
const MAX_CHECK_NAME_LENGTH = 64;
const MAX_TIMEOUT_MS = 60 * 60_000;

const allowedExecutables = new Set(["node", "pnpm", "vitest", "tsc", "eslint"]);

const checkSchema = z.object({
  name: z.string().trim().min(1).max(MAX_CHECK_NAME_LENGTH)
    .refine((value) => !FORBIDDEN_ARGUMENT_CHARS.some((char) => value.includes(char)), { message: "check name contains forbidden control character" }),
  executable: z.string(),
  args: z.array(z.string().min(1)).max(64),
  timeoutMs: z.number().int().min(1_000).max(MAX_TIMEOUT_MS),
  workingDirectory: z.string().optional(),
  env: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string().min(1).max(256)).optional()
}).strict();

export const orcaConfigSchema = z.object({
  schemaVersion: z.literal("1.0"),
  checks: z.array(checkSchema).max(32)
    .refine((checks) => new Set(checks.map((check) => check.name)).size === checks.length, { message: "duplicate check name" })
}).strict()
  .superRefine((value, ctx) => {
    for (let index = 0; index < value.checks.length; index += 1) {
      const check = value.checks[index];
      if (!allowedExecutables.has(check.executable)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["checks", index, "executable"], message: `unsupported executable: ${check.executable}` });
      }
      for (let argIndex = 0; argIndex < check.args.length; argIndex += 1) {
        const arg = check.args[argIndex];
        if (arg.length === 0) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["checks", index, "args", argIndex], message: "argument must be non-empty" });
        }
        if (arg.length > MAX_ARG_LENGTH) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["checks", index, "args", argIndex], message: `argument exceeds ${MAX_ARG_LENGTH} bytes` });
        }
        if (FORBIDDEN_ARGUMENT_CHARS.some((char) => arg.includes(char))) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["checks", index, "args", argIndex], message: "argument contains NUL or newline" });
        }
        if (SHELL_OPERATORS.some((op) => arg.includes(op))) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["checks", index, "args", argIndex], message: `argument contains shell operator: ${arg}` });
        }
      }
    }
  });

export type OrcaCheck = z.infer<typeof checkSchema>;
export type OrcaConfig = z.infer<typeof orcaConfigSchema>;

export interface OrcaConfigLoadResult {
  readonly config: OrcaConfig;
  readonly hash: string;
  readonly path: string;
}

/**
 * Strict loader for the ORCA controller configuration file. Rejects unknown
 * fields, duplicate names, empty values, NUL/newline characters, oversized
 * arguments, shell operators, and invalid timeouts. The loader never returns
 * a partial result; it throws on the first violation.
 */
export function loadOrcaConfig(projectRoot: string): OrcaConfigLoadResult {
  const path = resolve(projectRoot, "orca.config.json");
  if (!existsSync(path)) throw new OrcaConfigError("missing_orca_config", `orca.config.json not found at ${path}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new OrcaConfigError("invalid_json", `orca.config.json is not valid JSON: ${(error as Error).message}`);
  }
  const result = orcaConfigSchema.safeParse(parsed);
  if (!result.success) {
    const message = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new OrcaConfigError("schema_invalid", message);
  }
  for (const check of result.data.checks) validateCheck(check);
  const hash = computeConfigHash(result.data);
  return { config: result.data, hash, path };
}

function validateCheck(check: OrcaCheck): void {
  if (!allowedExecutables.has(check.executable)) throw new OrcaConfigError("unknown_executable", `unsupported executable: ${check.executable}`);
  for (const arg of check.args) {
    if (arg.length === 0) throw new OrcaConfigError("empty_argument", `check '${check.name}' contains an empty argument`);
    if (FORBIDDEN_ARGUMENT_CHARS.some((char) => arg.includes(char))) {
      throw new OrcaConfigError("argument_control_char", `check '${check.name}' argument contains NUL or newline`);
    }
    if (SHELL_OPERATORS.some((op) => arg.includes(op))) {
      throw new OrcaConfigError("shell_operator_in_argument", `check '${check.name}' argument contains shell operator: ${arg}`);
    }
    if (arg.length > MAX_ARG_LENGTH) {
      throw new OrcaConfigError("argument_too_long", `check '${check.name}' argument exceeds ${MAX_ARG_LENGTH} bytes`);
    }
  }
  if (check.timeoutMs > MAX_TIMEOUT_MS) {
    throw new OrcaConfigError("timeout_too_long", `check '${check.name}' timeout exceeds ${MAX_TIMEOUT_MS / 1000}s`);
  }
}

function computeConfigHash(config: OrcaConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

export class OrcaConfigError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "OrcaConfigError";
  }
}

/**
 * Resolves an executable name to a fixed, OS-specific command path. The
 * controller never invokes a shell; it uses fixed argv arrays only.
 */
export function resolveExecutable(executable: OrcaCheck["executable"], platform: typeof process.platform = process.platform): string {
  if (executable === "pnpm" && platform === "win32") return "pnpm.cmd";
  return executable;
}

export const ORCA_CONFIG_FILENAME = "orca.config.json";
export const ORCA_CONFIG_MAX_TIMEOUT_MS = MAX_TIMEOUT_MS;
export const ORCA_CONFIG_MAX_ARG_LENGTH = MAX_ARG_LENGTH;