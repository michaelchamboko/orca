import type { PairedRoster } from "../domain/types.js";
import { RosterConnectivityError, RosterService, type RosterPersistence, type RosterSessionLister } from "./roster-service.js";

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

export async function readRosterStatus(persistence: RosterPersistence, adapter: RosterSessionLister | undefined, controllerRunning: boolean): Promise<RosterStatus> {
  const roster = persistence.getCurrentRoster();
  if (!roster) return { roster: null, drift: "none", controllerRunning };
  if (!adapter) return { roster, drift: "unknown", controllerRunning };
  try {
    await new RosterService(adapter, persistence).assertCurrent();
    return { roster, drift: "none", controllerRunning };
  } catch (error) {
    if (error instanceof RosterConnectivityError) return { roster, drift: "unknown", controllerRunning };
    return { roster, drift: "detected", controllerRunning };
  }
}
