import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import type { OrcaCheck, OrcaConfig } from "../config/orca-config.js";
import { resolveExecutable } from "../config/orca-config.js";
import type { WorkflowPersistence } from "./workflow-persistence.js";

const OUTPUT_LIMIT_BYTES = 64 * 1024;
const CHECK_LEASE_MS = 5 * 60_000;

export interface ControlledCheckExecutor {
  execute(leaseOwner: string): Promise<number>;
}

/**
 * Creates a controller-approved check executor. Each invocation claims the
 * next pending check intent, runs the executable with shell:false, captures
 * bounded stdout/stderr, and persists a terminal result in one transaction.
 * The executor never invokes a shell, never injects user content into argv,
 * and runs checks sequentially outside any SQLite write transaction.
 */
export function createControlledCheckExecutor(options: {
  persistence: WorkflowPersistence;
  config: OrcaConfig;
  cwd: string;
  env?: Readonly<Record<string, string>>;
  now?: () => Date;
}): ControlledCheckExecutor {
  const now = options.now ?? (() => new Date());
  const knownChecks = new Map<string, OrcaCheck>(options.config.checks.map((check) => [check.name, check]));
  return {
    async execute(leaseOwner: string) {
      const intent = options.persistence.claimNextCheckIntent(leaseOwner, CHECK_LEASE_MS, now().toISOString());
      if (!intent) return 0;
      const check = knownChecks.get(intent.checkName);
      if (!check || check.executable !== intent.executable || JSON.stringify(check.args) !== JSON.stringify(intent.args) || check.timeoutMs !== intent.timeoutMs) {
        options.persistence.completeCheckIntent(intent.checkIntentId, "spawn_error", null, "", `configuration mismatch for check ${intent.checkName}`, false, 0, now().toISOString());
        return 1;
      }
      const startedAt = now().getTime();
      const result = await runControlledCheck({ check, cwd: options.cwd, env: options.env ?? {}, workingDirectory: intent.workingDirectory ?? check.workingDirectory ?? options.cwd, timeoutMs: check.timeoutMs });
      const durationMs = now().getTime() - startedAt;
      options.persistence.completeCheckIntent(intent.checkIntentId, result.status, result.exitCode, result.stdout, result.stderr, result.truncated, durationMs, now().toISOString());
      return 1;
    }
  };
}

export function enqueueCheckIntents(persistence: WorkflowPersistence, missionId: string, config: OrcaConfig, configHash: string): string[] {
  const intentIds: string[] = [];
  for (const check of config.checks) {
    const intentId = `orca-check-${missionId}-${check.name}-${randomUUID().slice(0, 8)}`;
    persistence.enqueueCheckIntent({
      checkIntentId: intentId,
      missionId,
      checkName: check.name,
      executable: resolveExecutable(check.executable),
      args: check.args,
      timeoutMs: check.timeoutMs,
      workingDirectory: check.workingDirectory ?? null,
      env: check.env ?? {},
      configHash
    });
    intentIds.push(intentId);
  }
  return intentIds;
}

async function runControlledCheck(input: {
  check: OrcaCheck;
  cwd: string;
  env: Readonly<Record<string, string>>;
  workingDirectory: string;
  timeoutMs: number;
}): Promise<{ status: "passed" | "failed" | "timed_out" | "spawn_error"; exitCode: number | null; stdout: string; stderr: string; truncated: boolean }> {
  const executable = resolveExecutable(input.check.executable);
  return new Promise((resolve) => {
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;
    let child;
    try {
      child = spawn(executable, [...input.check.args], {
        cwd: input.workingDirectory,
        env: { ...process.env, ...input.env },
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      resolve({ status: "spawn_error", exitCode: null, stdout: "", stderr: (error as Error).message, truncated: false });
      return;
    }
    const timer = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ status: "timed_out", exitCode: null, stdout, stderr, truncated });
    }, input.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      if (stdoutBytes + buffer.length > OUTPUT_LIMIT_BYTES) {
        const remaining = OUTPUT_LIMIT_BYTES - stdoutBytes;
        if (remaining > 0) stdout += buffer.subarray(0, remaining).toString("utf8");
        truncated = true;
        stdoutBytes = OUTPUT_LIMIT_BYTES;
        return;
      }
      stdoutBytes += buffer.length;
      stdout += buffer.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      if (stderrBytes + buffer.length > OUTPUT_LIMIT_BYTES) {
        const remaining = OUTPUT_LIMIT_BYTES - stderrBytes;
        if (remaining > 0) stderr += buffer.subarray(0, remaining).toString("utf8");
        truncated = true;
        stderrBytes = OUTPUT_LIMIT_BYTES;
        return;
      }
      stderrBytes += buffer.length;
      stderr += buffer.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      resolve({ status: "spawn_error", exitCode: null, stdout, stderr: error.message, truncated });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      resolve({ status: code === 0 ? "passed" : "failed", exitCode: code, stdout, stderr, truncated });
    });
  });
}