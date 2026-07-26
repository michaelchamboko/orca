import type { Role } from "../domain/types.js";

export interface RoleProfile {
  position: 1 | 2 | 3 | 4 | 5;
  role: Role;
  mode: "primary";
  tools: readonly string[];
  skills: readonly string[];
  instructions: string;
}

export const roleProfiles: readonly RoleProfile[] = Object.freeze([
  profile(1, "orchestrator", ["read", "glob", "grep", "webfetch", "websearch", "todowrite", "skill"], ["orca-core-contracts", "orca-orchestrator-workflow"]),
  profile(2, "planner", ["read", "glob", "grep", "webfetch", "websearch", "lsp", "skill"], ["orca-core-contracts", "orca-planner-analysis"]),
  profile(3, "builder", ["bash", "read", "edit", "glob", "grep", "webfetch", "websearch", "lsp", "skill"], ["orca-core-contracts", "orca-builder-implementation"]),
  profile(4, "reviewer", ["read", "glob", "grep", "webfetch", "websearch", "lsp", "skill"], ["orca-core-contracts", "orca-reviewer-quality"]),
  profile(5, "tester", ["read", "glob", "grep", "lsp", "skill"], ["orca-core-contracts", "orca-tester-evidence"])
]);

function profile(position: 1 | 2 | 3 | 4 | 5, role: Role, tools: readonly string[], skills: readonly string[]): RoleProfile {
  return Object.freeze({
    position,
    role,
    mode: "primary",
    tools: Object.freeze([...tools]),
    skills: Object.freeze([...skills]),
    instructions: `You are ORCA's ${role}. Return a structured controller result with summary, files, commands, tests, findings, risks, questions, and recommended next action.`
  });
}
