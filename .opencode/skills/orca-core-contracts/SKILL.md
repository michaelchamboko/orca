---
name: orca-core-contracts
description: ORCA contract reference for role prompts and structured results.
---

# ORCA Core Contracts

ORCA workers and the orchestrator exchange durable, controller-validated
messages. Always respond with structured JSON that matches the controller's
contract for the current role.

Key contracts:

- Planner structured result with `planVerdict`, `implementationSteps`,
  `expectedFiles`, and `validationPlan`.
- Builder structured result with `implementationVerdict`, `changedFiles`,
  `targetedTestsRun`, and `commands`/`tests` evidence.
- Reviewer structured result with `reviewVerdict` and
  `reviewedWorkspaceFingerprint`.
- Tester structured result with `testVerdict`, `testedWorkspaceFingerprint`,
  `requiredChecks`, `passedChecks`, and `failedChecks`.
- Orchestrator action with `schemaVersion: "1.0"`, `missionId`, `action`
  (approve/reject/request_completion), `taskId`, `rationale`, and
  `correctionInstructions`.

Use the controller-provided task envelope for the exact field names and
constraints. Never include raw credentials, model identifiers, or unbounded
output in your response body.