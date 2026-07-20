import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ControllerRuntimeState {
  running: boolean;
  reason: "no validated controller runtime metadata" | "controller runtime verifier is unavailable";
}

/**
 * Task 4 owns the controller lifecycle. It will provide an authenticated runtime
 * verifier for `.orca/controller.json`. Until then, metadata alone is never
 * considered proof of a running controller: a PID can be stale or reused.
 */
export function readControllerRuntime(projectRoot: string): ControllerRuntimeState {
  const metadataPath = join(projectRoot, ".orca", "controller.json");
  if (!existsSync(metadataPath)) return { running: false, reason: "no validated controller runtime metadata" };
  try {
    JSON.parse(readFileSync(metadataPath, "utf8"));
  } catch {
    return { running: false, reason: "no validated controller runtime metadata" };
  }
  return { running: false, reason: "controller runtime verifier is unavailable" };
}
