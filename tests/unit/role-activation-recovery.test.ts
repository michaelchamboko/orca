import { describe, expect, it } from "vitest";

import { RoleProfileReloadRequiredError, requiresRoleProfileRestart } from "../../src/roles/activation.js";

describe("activation", () => {
  it("requires restart when any installed profile changed", () => {
    const installed = [{ change: "created" as const }, { change: "unchanged" as const }];
    expect(requiresRoleProfileRestart(installed)).toBe(true);
  });

  it("does not require restart when every profile is unchanged", () => {
    const installed = [{ change: "unchanged" as const }, { change: "unchanged" as const }];
    expect(requiresRoleProfileRestart(installed)).toBe(false);
  });

  it("treats empty installation as no restart required", () => {
    expect(requiresRoleProfileRestart([])).toBe(false);
  });

  it("throws RoleProfileReloadRequiredError on strict verification", () => {
    expect(() => { throw new RoleProfileReloadRequiredError(); }).toThrow(RoleProfileReloadRequiredError);
    expect(() => { throw new RoleProfileReloadRequiredError(); }).toThrow(/OpenCode agent-profile activation/);
  });

  it("requires restart on a single updated profile", () => {
    const installed = [{ change: "updated" as const }];
    expect(requiresRoleProfileRestart(installed)).toBe(true);
  });
});