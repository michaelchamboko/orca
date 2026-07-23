import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installOrcaAssets, installRoleProfiles, installSkillAssets, listInstalledSkills, renderRoleProfile, renderSkillAsset } from "../../src/roles/installer.js";
import { roleProfiles } from "../../src/roles/profiles.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "orca-skills-"));
  roots.push(root);
  mkdirSync(join(root, ".opencode"), { recursive: true });
  return root;
}

describe("installOrcaAssets", () => {
  it("installs role profiles and skill assets and returns a stable activation hash", () => {
    const root = makeRoot();
    const first = installOrcaAssets(root);
    const second = installOrcaAssets(root);
    expect(second.profiles.every((profile) => profile.change === "unchanged")).toBe(true);
    expect(second.skills.every((skill) => skill.change === "unchanged")).toBe(true);
    expect(first.activationHash).toBe(second.activationHash);
  });

  it("contains the core-contracts skill for every role", () => {
    const root = makeRoot();
    installOrcaAssets(root);
    const skillDir = join(root, ".opencode", "skills", "orca-core-contracts");
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);
    expect(roleProfiles.length).toBeGreaterThan(0);
  });

  it("declares orchestrator tools without bash/edit and only Builder with bash/edit", () => {
    for (const profile of roleProfiles) {
      if (profile.role === "orchestrator" || profile.role === "planner" || profile.role === "reviewer" || profile.role === "tester") {
        expect(profile.tools).not.toContain("bash");
        expect(profile.tools).not.toContain("edit");
      }
      if (profile.role === "builder") {
        expect(profile.tools).toContain("bash");
        expect(profile.tools).toContain("edit");
      }
    }
  });

  it("does not embed model selection in any profile", () => {
    for (const profile of roleProfiles) {
      expect(renderRoleProfile(profile)).not.toMatch(/^model:/m);
    }
  });
});

describe("installRoleProfiles", () => {
  it("creates one agent file per role and writes skill references", () => {
    const root = makeRoot();
    const profiles = installRoleProfiles(root);
    for (const profile of profiles) {
      const content = readFileSync(profile.path, "utf8");
      expect(content).toContain("ORCA");
      expect(content).toContain("tools:");
      const filename = profile.path.split(/[\\/]/).pop() ?? "";
      const expectedRole = filename.replace("orca-", "").replace(".md", "");
      const expectedSkills = roleProfiles.find((p) => p.role === expectedRole)?.skills ?? [];
      for (const skill of expectedSkills) {
        expect(content).toContain(skill);
      }
    }
  });
});

describe("installSkillAssets", () => {
  it("creates a SKILL.md file per declared skill", () => {
    const root = makeRoot();
    const installed = installSkillAssets(root);
    expect(installed.length).toBeGreaterThan(0);
    for (const skill of installed) {
      const content = readFileSync(skill.skillFile, "utf8");
      expect(content.startsWith("---\nname: ")).toBe(true);
    }
    const expected = [...new Set(installed.map((skill) => skill.directory.split(/[\\/]/).pop() ?? ""))].sort();
    expect(listInstalledSkills(root)).toEqual(expected);
  });
});

describe("renderSkillAsset", () => {
  it("produces YAML-frontmatter output for known skills", () => {
    const output = renderSkillAsset("orca-builder-implementation");
    expect(output).toContain("orca-builder-implementation");
    expect(output).toContain("ORCA Builder Implementation");
  });
});