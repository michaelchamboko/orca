import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { roleProfiles, type RoleProfile } from "./profiles.js";

export { roleProfiles } from "./profiles.js";

export interface InstalledRoleProfile {
  path: string;
  content: string;
}

export function installRoleProfiles(projectRoot: string): InstalledRoleProfile[] {
  const agentsDirectory = join(projectRoot, ".opencode", "agents");
  mkdirSync(agentsDirectory, { recursive: true });
  return roleProfiles.map((profile) => {
    const path = join(agentsDirectory, `orca-${profile.role}.md`);
    const content = renderRoleProfile(profile);
    writeFileSync(path, content, "utf8");
    return { path, content };
  });
}

export function renderRoleProfile(profile: RoleProfile): string {
  return `---\ndescription: ORCA ${profile.role} role\nmode: ${profile.mode}\ntools:\n${profile.tools.map((tool) => `  ${tool}: true`).join("\n")}\n---\n\n${profile.instructions}\n`;
}
