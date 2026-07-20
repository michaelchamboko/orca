import {
  BaseWorkerResult,
  BuilderResult,
  MissionState,
  PlannerResult,
  ReviewerResult,
  TaskState,
  TesterResult
} from "./types.js";

export type WorkerResult = BaseWorkerResult &
  (PlannerResult | BuilderResult | ReviewerResult | TesterResult);

export const roleSequence = ["planner", "builder", "reviewer", "tester"] as const;

export type WorkerRole = (typeof roleSequence)[number];

export function requiredRoleForMissionState(state: MissionState): WorkerRole | null {
  if (state === "planning") {
    return "planner";
  }

  if (state === "building") {
    return "builder";
  }

  if (state === "reviewing") {
    return "reviewer";
  }

  if (state === "testing") {
    return "tester";
  }

  return null;
}

export function isApprovalGate(state: MissionState): boolean {
  return [
    "awaiting_plan_approval",
    "awaiting_builder_approval",
    "awaiting_review_approval",
    "awaiting_test_approval",
    "awaiting_final_approval"
  ].includes(state);
}

export function isTerminalState(state: MissionState): boolean {
  return ["completed", "failed", "cancelled", "blocked"].includes(state);
}

export function nextMissionStateFromResult(currentState: MissionState, result: WorkerResult): MissionState {
  if (isTerminalState(currentState)) {
    throw new Error(`cannot advance terminal mission state: ${currentState}`);
  }

  if (result.role === "planner") {
    const parsed = result as BaseWorkerResult & PlannerResult;
    if (currentState !== "planning") {
      throw new Error(`planner result not valid in state ${currentState}`);
    }

    return parsed.planVerdict === "ready" ? "awaiting_plan_approval" : "needs_user_input";
  }

  if (result.role === "builder") {
    const parsed = result as BaseWorkerResult & BuilderResult;
    if (currentState !== "building") {
      throw new Error(`builder result not valid in state ${currentState}`);
    }

    if (parsed.implementationVerdict === "implemented") {
      return "awaiting_builder_approval";
    }

    return "needs_user_input";
  }

  if (result.role === "reviewer") {
    const parsed = result as BaseWorkerResult & ReviewerResult;
    if (currentState !== "reviewing") {
      throw new Error(`reviewer result not valid in state ${currentState}`);
    }

    if (parsed.reviewVerdict === "pass") {
      return "awaiting_review_approval";
    }

    return "needs_user_input";
  }

  if (result.role === "tester") {
    const parsed = result as BaseWorkerResult & TesterResult;
    if (currentState !== "testing") {
      throw new Error(`tester result not valid in state ${currentState}`);
    }

    if (parsed.testVerdict === "pass") {
      return "awaiting_test_approval";
    }

    return "needs_user_input";
  }

  throw new Error(`unsupported role: ${result.role}`);
}

export function nextTaskStateFromMissionState(state: MissionState): TaskState {
  if (state === "planning" || state === "building" || state === "reviewing" || state === "testing") {
    return "running";
  }

  if (state === "awaiting_plan_approval") {
    return "awaiting_permission";
  }

  if (state === "awaiting_builder_approval") {
    return "awaiting_permission";
  }

  if (state === "awaiting_review_approval") {
    return "awaiting_permission";
  }

  if (state === "awaiting_test_approval") {
    return "awaiting_permission";
  }

  if (state === "awaiting_final_approval") {
    return "awaiting_permission";
  }

  if (isTerminalState(state)) {
    return "approved";
  }

  return "queued";
}
