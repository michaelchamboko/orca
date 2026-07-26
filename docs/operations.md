# ORCA Operations

## Starting a mission

1. Pair five sessions with `swarmctl pair` (produces `.orca/state.sqlite`).
2. Confirm `orca.config.json` exists with the controller-approved checks.
3. Start the controller with `swarmctl start` (auto-binds to loopback port 4317 by
   default; pass `--port 0` for an ephemeral port).
4. Send a single Session 1 user objective — the controller creates a mission,
   dispatches the Planner, and advances on correlated orchestrator actions.

## Health and readiness

- `GET /health` returns liveness only: process identity, version, port, binding count,
  OpenCode health, and binding freshness. No readiness or workflow detail is
  exposed to avoid leaking credentials or prompts.
- `GET /status` returns the operational readiness snapshot: active mission,
  current task role/state, pending dispatch count, event-stream connection state,
  polling fallback flag, roster freshness, control-plane freshness, and the last
  redacted failure code.
- Both endpoints require the bearer token persisted in
  `.orca/controller-token`. The token is locked down to the operating system user
  on POSIX (chmod 600) and to the active Windows user via `icacls`.

## Restart and recovery

The controller is restart-safe. On startup it:

1. Rejects a stale runtime claim by reading `.orca/controller.json` and
   `/health` against the recorded process identity.
2. Replays the persisted `dispatch_outbox` leases through `claimNextDispatch`,
   recovering every pending dispatch including orchestrator decisions.
3. Walks `task_execution_metadata` for in-flight tasks and resumes the
   `WorkerCompletionService` quiet-window tracking.
4. Runs `MissionService.reconcileCompletedTasks` to advance any completed but
   unconsumed task into the next approval gate.

## Migrations

Migrations are additive. The controller will refuse to start if a durable
schema version is missing. Forward-only rollback is supported via restore of
the pre-migration `.orca/state.sqlite` backup.

## Logs

Logs use identifiers, hashes, role names, state names, and timestamps only.
Prompts, rationales, raw responses, credentials, and check output streams are
never logged.

## Failure codes

- `roster_drift` — paired session or model no longer matches the controller.
- `missing_role_profile` — `.opencode/agents/orca-<role>.md` is missing.
- `role_profile_mismatch` — role profile content or hash does not match.
- `worker_blocked` — worker task exceeded the controller timeout, hit
  repeated polling failure, or hit a permission request.
- `completion_blocked` — orchestrator's `request_completion` arrived before the
  final approval gate.

## Acceptance gate

`pnpm.cmd run verify:95` is the 95% readiness release gate. It runs lint +
typecheck + build + unit + integration + contract + fake E2E + coverage. All
subcommands must exit `0`. The fake five-session E2E suite
(`tests/e2e/fake-complete-mission.test.ts`) drives the controller through
Planner → Builder → Reviewer → Tester with scripted fake OpenCode responses.

`pnpm.cmd run verify:release` adds the live OpenCode suite and is the path to
the **100% readiness** milestone. The real OpenCode five-session acceptance
(`pnpm.cmd run test:e2e:real`) is opt-in and runs only when
`ORCA_REAL_E2E=1` is exported.

`pnpm.cmd run verify` is an alias for `verify:95` and excludes the live suite
by default.