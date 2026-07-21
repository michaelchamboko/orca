import type { Role } from "../domain/types.js";

export const ORCA_AGENT_MODEL = "minimax-coding-plan/MiniMax-M3";

export interface RoleProfile {
  position: 1 | 2 | 3 | 4 | 5;
  role: Role;
  mode: "primary";
  model: string;
  tools: readonly string[];
  instructions: string;
}

export const roleProfiles: readonly RoleProfile[] = Object.freeze([
  profile(1, "orchestrator", ["read", "glob", "grep", "webfetch", "websearch", "task", "todowrite", "skill"]),
  profile(2, "planner", ["read", "glob", "grep", "webfetch", "websearch", "lsp", "skill"]),
  profile(3, "builder", ["bash", "read", "edit", "glob", "grep", "webfetch", "websearch", "lsp", "skill"]),
  profile(4, "reviewer", ["read", "glob", "grep", "webfetch", "websearch", "lsp", "skill"]),
  profile(5, "tester", ["read", "glob", "grep", "lsp", "skill"])
]);

function profile(position: 1 | 2 | 3 | 4 | 5, role: Role, tools: readonly string[]): RoleProfile {
  return Object.freeze({
    position,
    role,
    mode: "primary",
    model: ORCA_AGENT_MODEL,
    tools: Object.freeze([...tools]),
    instructions: `You are ORCA's ${role}. Return a structured controller result with summary, files, commands, tests, findings, risks, questions, and recommended next action.`
  });
}
