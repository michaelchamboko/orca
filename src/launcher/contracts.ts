import { z } from "zod";

import type { Role } from "../domain/types.js";
import { roleProfiles } from "../roles/profiles.js";

export const launcherRoles = roleProfiles.map((profile) => profile.role) as readonly Role[];

export type LauncherErrorCode =
  | "OPENCODE_UNAVAILABLE"
  | "PROFILE_RELOAD_REQUIRED"
  | "SESSION_CHANGED"
  | "SESSION_NOT_IDLE"
  | "ROSTER_LOCKED"
  | "CONTROLLER_ALREADY_RUNNING"
  | "OPERATION_IN_PROGRESS"
  | "START_FAILED"
  | "RECOVERY_REQUIRED"
  | "INVALID_REQUEST"
  | "UNAUTHORIZED";

export type LauncherLifecycle =
  | "stopped"
  | "starting"
  | "running-not-ready"
  | "ready"
  | "reconnecting"
  | "stopping"
  | "blocked"
  | "recovery-required";

export const emptyBodySchema = z.object({}).strict();

export const bootstrapBodySchema = z.object({
  nonce: z.string().min(16)
}).strict();

export const assignmentSchema = z.object({
  orchestrator: z.string().min(1),
  planner: z.string().min(1),
  builder: z.string().min(1),
  reviewer: z.string().min(1),
  tester: z.string().min(1)
}).strict();

export const pairBodySchema = z.object({
  assignments: assignmentSchema
}).strict();

export type LauncherAssignments = z.infer<typeof assignmentSchema>;

export class LauncherError extends Error {
  public readonly code: LauncherErrorCode;
  public readonly statusCode: number;

  constructor(code: LauncherErrorCode, message: string, statusCode = 400) {
    super(message);
    this.name = "LauncherError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function orderedAssignmentSessionIds(assignments: LauncherAssignments): string[] {
  return roleProfiles.map((profile) => assignments[profile.role]);
}
