import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { roleProfiles, type RoleProfile } from "./profiles.js";

export { roleProfiles } from "./profiles.js";

export interface InstalledRoleProfile {
  path: string;
  content: string;
  change: "created" | "updated" | "unchanged";
}

export interface InstalledSkillAsset {
  directory: string;
  skillFile: string;
  content: string;
  change: "created" | "updated" | "unchanged";
}

export interface InstallResult {
  profiles: InstalledRoleProfile[];
  skills: InstalledSkillAsset[];
  activationHash: string;
  profileRoot: string;
  skillRoot: string;
}

export function installRoleProfiles(projectRoot: string): InstalledRoleProfile[] {
  const agentsDirectory = join(projectRoot, ".opencode", "agents");
  mkdirSync(agentsDirectory, { recursive: true });
  return roleProfiles.map((profile) => {
    const path = join(agentsDirectory, `orca-${profile.role}.md`);
    const content = renderRoleProfile(profile);
    const change = !existsSync(path) ? "created" : readFileSync(path, "utf8") === content ? "unchanged" : "updated";
    if (change !== "unchanged") writeFileSync(path, content, "utf8");
    return { path, content, change };
  });
}

export function installSkillAssets(projectRoot: string): InstalledSkillAsset[] {
  const skillsRoot = join(projectRoot, ".opencode", "skills");
  mkdirSync(skillsRoot, { recursive: true });
  const installed: InstalledSkillAsset[] = [];
  for (const profile of roleProfiles) {
    for (const skill of profile.skills) {
      const directory = join(skillsRoot, skill);
      mkdirSync(directory, { recursive: true });
      const skillFile = join(directory, "SKILL.md");
      const content = renderSkillAsset(skill);
      const change = !existsSync(skillFile) ? "created" : readFileSync(skillFile, "utf8") === content ? "unchanged" : "updated";
      if (change !== "unchanged") writeFileSync(skillFile, content, "utf8");
      installed.push({ directory, skillFile, content, change });
    }
  }
  return installed;
}

export function installOrcaAssets(projectRoot: string): InstallResult {
  const profiles = installRoleProfiles(projectRoot);
  const skills = installSkillAssets(projectRoot);
  const activationHash = computeActivationHash(profiles, skills);
  return {
    profiles,
    skills,
    activationHash,
    profileRoot: join(projectRoot, ".opencode", "agents"),
    skillRoot: join(projectRoot, ".opencode", "skills")
  };
}

export function renderRoleProfile(profile: RoleProfile): string {
  const skills = profile.skills.length > 0 ? `skills:\n${profile.skills.map((skill) => `  - ${skill}`).join("\n")}\n` : "";
  return `---\ndescription: ORCA ${profile.role} role\nmode: ${profile.mode}\ntools:\n${profile.tools.map((tool) => `  ${tool}: true`).join("\n")}\n${skills}---\n\n${profile.instructions}\n`;
}

export function renderSkillAsset(skill: string): string {
  const sections: Record<string, { title: string; body: string }> = {
    "orca-core-contracts": { title: "ORCA Core Contracts", body: "Always respond with structured JSON that matches the controller's contract for the current role." },
    "orca-orchestrator-workflow": { title: "ORCA Orchestrator Workflow", body: "Approve or reject gate results, then issue request_completion exactly once after Tester pass." },
    "orca-planner-analysis": { title: "ORCA Planner Analysis", body: "Return a plan-only structured result with implementationSteps, expectedFiles, and validationPlan." },
    "orca-builder-implementation": { title: "ORCA Builder Implementation", body: "Implement the plan and return evidence with changedFiles, commands, and tests. Never touch control-plane files." },
    "orca-reviewer-quality": { title: "ORCA Reviewer Quality", body: "Inspect the workspace and return pass/changes_required/blocked with the reviewedWorkspaceFingerprint." },
    "orca-tester-evidence": { title: "ORCA Tester Evidence", body: "Diagnose the controller-produced evidence and return pass/fail/blocked with requiredChecks coverage." }
  };
  const section = sections[skill] ?? { title: skill, body: "ORCA skill asset." };
  return `---\nname: ${skill}\ndescription: ORCA ${section.title}.\n---\n\n# ${section.title}\n\n${section.body}\n`;
}

function computeActivationHash(profiles: readonly InstalledRoleProfile[], skills: readonly InstalledSkillAsset[]): string {
  const hash = createHash("sha256");
  for (const profile of [...profiles].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(profile.path);
    hash.update(":");
    hash.update(createHash("sha256").update(profile.content).digest("hex"));
    hash.update("\u0000");
  }
  for (const skill of [...skills].sort((a, b) => a.skillFile.localeCompare(b.skillFile))) {
    hash.update(skill.skillFile);
    hash.update(":");
    hash.update(createHash("sha256").update(skill.content).digest("hex"));
    hash.update("\u0000");
  }
  return hash.digest("hex");
}

export function listInstalledSkills(projectRoot: string): string[] {
  const skillsRoot = join(projectRoot, ".opencode", "skills");
  if (!existsSync(skillsRoot)) return [];
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}
