import { describe, expect, it } from "vitest";

import { getVersion } from "../../src/cli/main.js";

describe("bootstrap", () => {
  it("exposes a version function", () => {
    expect(typeof getVersion()).toBe("string");
    expect(getVersion().length).toBeGreaterThan(0);
  });
});
