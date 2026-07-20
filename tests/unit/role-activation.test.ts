import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { requireVerifiedRoleProfileActivation, requiresRoleProfileRestart } from "../../src/roles/activation.js";
import { installRoleProfiles } from "../../src/roles/installer.js";

const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

describe("role-profile activation", () => {
  it("requires one restart after profiles are created but allows an unchanged rerun", () => {
    const workspace = mkdtempSync(join(tmpdir(), "orca-profiles-"));
    workspaces.push(workspace);

    const firstInstall = installRoleProfiles(workspace);
    const secondInstall = installRoleProfiles(workspace);

    expect(firstInstall.every((file) => file.change === "created")).toBe(true);
    expect(requiresRoleProfileRestart(firstInstall)).toBe(true);
    expect(() => requireVerifiedRoleProfileActivation(firstInstall)).toThrow("no roster was saved");
    expect(secondInstall.every((file) => file.change === "unchanged")).toBe(true);
    expect(requiresRoleProfileRestart(secondInstall)).toBe(false);
    expect(() => requireVerifiedRoleProfileActivation(secondInstall)).not.toThrow();
  });
});
