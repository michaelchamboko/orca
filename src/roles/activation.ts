export class RoleProfileReloadRequiredError extends Error {
  constructor() {
    super("OpenCode agent-profile activation cannot be verified through the documented adapter contract. Restart OpenCode once, then re-run `swarmctl pair`; no roster was saved.");
    this.name = "RoleProfileReloadRequiredError";
  }
}

interface ProfileInstallation {
  change: "created" | "updated" | "unchanged";
}

export function requiresRoleProfileRestart(installed: readonly ProfileInstallation[]): boolean {
  return installed.some((profile) => profile.change !== "unchanged");
}

export function requireVerifiedRoleProfileActivation(installed: readonly ProfileInstallation[]): void {
  if (requiresRoleProfileRestart(installed)) throw new RoleProfileReloadRequiredError();
}
