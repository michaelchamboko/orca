import type { PairedRoster } from "../domain/types.js";

export interface RosterStatus {
  roster: PairedRoster | null;
  drift: "none" | "detected" | "unknown";
  controllerRunning: boolean;
}

export function formatRosterStatus(status: RosterStatus): string {
  if (!status.roster) return `No paired roster\nController: ${status.controllerRunning ? "running" : "not running"}`;
  const rows = status.roster.bindings.map((binding) => `${binding.position} | ${binding.role} | ${binding.agentName} | ${binding.model.providerId}/${binding.model.modelId}`);
  return ["Position | Role | Session | Model", ...rows, `Drift: ${status.drift}`, `Controller: ${status.controllerRunning ? "running" : "not running"}`].join("\n");
}
