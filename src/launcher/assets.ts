import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { roleProfiles } from "../roles/profiles.js";
import { renderRoleProfile, renderSkillAsset } from "../roles/installer.js";

export interface AssetInspection {
  active: boolean;
  profiles: Array<{ role: string; path: string; state: "missing" | "current" | "stale" }>;
  skills: Array<{ name: string; path: string; state: "missing" | "current" | "stale" }>;
}

export function inspectOrcaAssets(projectRoot: string): AssetInspection {
  const profiles = roleProfiles.map((profile) => {
    const path = join(projectRoot, ".opencode", "agents", `orca-${profile.role}.md`);
    return { role: profile.role, path, state: inspectFile(path, renderRoleProfile(profile)) };
  });
  const seenSkills = new Set<string>();
  const skills = roleProfiles.flatMap((profile) => profile.skills).filter((skill) => {
    if (seenSkills.has(skill)) return false;
    seenSkills.add(skill);
    return true;
  }).map((skill) => {
    const path = join(projectRoot, ".opencode", "skills", skill, "SKILL.md");
    return { name: skill, path, state: inspectFile(path, renderSkillAsset(skill)) };
  });
  return {
    active: [...profiles, ...skills].every((asset) => asset.state === "current"),
    profiles,
    skills
  };
}

function inspectFile(path: string, expected: string): "missing" | "current" | "stale" {
  if (!existsSync(path)) return "missing";
  return readFileSync(path, "utf8") === expected ? "current" : "stale";
}
