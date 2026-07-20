export class RoleProfileReloadRequiredError extends Error {
  constructor() {
    super("OpenCode agent-profile activation cannot be verified through the documented adapter contract. Restart OpenCode once, then re-run `swarmctl pair`; no roster was saved.");
    this.name = "RoleProfileReloadRequiredError";
  }
}

export function requireVerifiedRoleProfileActivation(): never {
  throw new RoleProfileReloadRequiredError();
}
