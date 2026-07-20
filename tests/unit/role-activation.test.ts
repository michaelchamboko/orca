import { describe, expect, it } from "vitest";

import { requireVerifiedRoleProfileActivation } from "../../src/roles/activation.js";

describe("role-profile activation", () => {
  it("does not save a roster when the documented adapter cannot verify OpenCode reload", () => {
    expect(() => requireVerifiedRoleProfileActivation()).toThrow("Restart OpenCode once, then re-run `swarmctl pair`; no roster was saved.");
  });
});
