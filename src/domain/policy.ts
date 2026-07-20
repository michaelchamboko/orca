import { MissionState } from "./types.js";

import { isApprovalGate } from "./workflow.js";

function assertApprovalGate(state: MissionState): void {
  if (!isApprovalGate(state)) {
    throw new Error(`mission state ${state} is not an approval gate`);
  }
}

export function resolveMissionApproval(state: MissionState, approved: boolean): MissionState {
  assertApprovalGate(state);

  if (!approved) {
    return "needs_user_input";
  }

  switch (state) {
    case "awaiting_plan_approval":
      return "building";
    case "awaiting_builder_approval":
      return "reviewing";
    case "awaiting_review_approval":
      return "testing";
    case "awaiting_test_approval":
      return "awaiting_final_approval";
    case "awaiting_final_approval":
      return "completed";
    default:
      throw new Error(`unsupported approval state: ${state}`);
  }
}

export function nextStateForDeniedApproval(state: MissionState): MissionState {
  return resolveMissionApproval(state, false);
}

export function shouldRequireUserApproval(state: MissionState): boolean {
  return isApprovalGate(state);
}
