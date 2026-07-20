import { getVersion } from "../../src/cli/main.js";

import type { OpencodeIntegrationEntry, OpencodeRuntime } from "../../src/integrations/opencode/types.js";

export function setupIntegrationEntry(): OpencodeIntegrationEntry {
  return {
    name: "opencode-orchestration",
    version: getVersion(),
    commands: [
      {
        command: "swarmctl",
        description: "Controller entrypoint for five-session orchestration workflows"
      }
    ]
  };
}

export function registerIntegration(runtime: OpencodeRuntime): void {
  const entry = setupIntegrationEntry();

  for (const command of entry.commands) {
    runtime.registerCommand(command);
  }
}
