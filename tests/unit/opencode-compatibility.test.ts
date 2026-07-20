import { describe, expect, it } from "vitest";

import {
  registerIntegration,
  setupIntegrationEntry
} from "../../integrations/opencode/generated-entry.js";
import type { OpencodeIntegrationRegistration } from "../../src/integrations/opencode/types.js";

describe("OpenCode integration entrypoint", () => {
  it("exposes integration metadata", () => {
    const entry = setupIntegrationEntry();

    expect(entry.name).toBe("opencode-orchestration");
    expect(entry.version).toBeTypeOf("string");
    expect(entry.version.length).toBeGreaterThan(0);
    expect(entry.commands).toEqual([
      {
        command: "swarmctl",
        description: "Controller entrypoint for five-session orchestration workflows"
      }
    ]);
  });

  it("can register commands into a compatible runtime", () => {
    const registrations: OpencodeIntegrationRegistration[] = [];

    registerIntegration({
      registerCommand(command) {
        registrations.push(command);
      }
    });

    expect(registrations).toEqual([
      {
        command: "swarmctl",
        description: "Controller entrypoint for five-session orchestration workflows"
      }
    ]);
  });
});
