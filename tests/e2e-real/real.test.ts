import { describe, it, expect } from "vitest";

const isEnabled = process.env.ORCA_REAL_E2E === "1";

if (isEnabled) {
  describe("real e2e", () => {
    it("requires implementation before this lane can run", () => {
      expect(isEnabled).toBe(true);
      throw new Error("Real OpenCode e2e coverage is not implemented yet.");
    });
  });
} else {
  describe.skip("real e2e", () => {
    it("is reserved for production controller + OpenCode round-trip coverage", () => {
      // Kept intentionally empty until real OpenCode-backed execution is wired.
    });
  });
}
