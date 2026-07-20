import type { Role } from "../domain/types.js";

export interface RoleProfile {
  position: 1 | 2 | 3 | 4 | 5;
  role: Role;
  capabilities: readonly string[];
}

export const roleProfiles: readonly RoleProfile[] = Object.freeze([
  Object.freeze({ position: 1, role: "orchestrator", capabilities: Object.freeze(["mission:create", "mission:approve", "mission:finalize"]) }),
  Object.freeze({ position: 2, role: "planner", capabilities: Object.freeze(["result:submit"]) }),
  Object.freeze({ position: 3, role: "builder", capabilities: Object.freeze(["result:submit", "workspace:write"]) }),
  Object.freeze({ position: 4, role: "reviewer", capabilities: Object.freeze(["result:submit"]) }),
  Object.freeze({ position: 5, role: "tester", capabilities: Object.freeze(["result:submit", "test:run"]) })
]);
