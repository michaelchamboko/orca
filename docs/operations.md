# ORCA Operations

## Starting a mission

1. Pair five sessions with `swarmctl pair` (produces `.orca/state.sqlite`).
2. Confirm `orca.config.json` exists with the controller-approved checks.
3. Start the controller with `swarmctl controller start` (auto-binds to loopback port 4317 by default; pass `--port 0` for an ephemeral port).
4. Send a single Session 1 user objective — the controller creates a mission, dispatches the Planner, and advances on correlated orchestrator actions.

```powershell
swarmctl doctor
swarmctl pair
swarmctl controller start
```

To run the CLI from the build output:

```powershell
pnpm.cmd run build
node dist/cli.js doctor
node dist/cli.js pair
node dist/cli.js controller start
```

## Health and readiness

- `GET /health` returns liveness only: process identity, version, port, binding count, OpenCode health, and binding freshness. No readiness or workflow detail is exposed to avoid leaking credentials or prompts.
- `GET /status` returns the operational readiness snapshot: active mission, current task role/state, pending dispatch count, event-stream connection state, polling fallback flag, roster freshness, control-plane freshness, and the last redacted failure code.
- Both endpoints require the bearer token persisted in `.orca/controller-token`. The token is locked down to the operating system user on POSIX (chmod 600) and to the active Windows user via `icacls`.
- `swarmctl status` and `swarmctl controller status` surface the same health/readiness snapshot via the CLI.

## Restart and recovery

The controller is restart-safe. On startup it:

1. Rejects a stale runtime claim by reading `.orca/controller.json` and `/health` against the recorded process identity.
2. Replays the persisted `dispatch_outbox` leases through `claimNextDispatch`, recovering every pending dispatch including orchestrator decisions.
3. Walks `task_execution_metadata` for in-flight tasks and resumes the `WorkerCompletionService` quiet-window tracking.
4. Runs `MissionService.reconcileCompletedTasks` to advance any completed but unconsumed task into the next approval gate.

## Migrations

Migrations are additive. The controller refuses to start if a durable schema version is missing. Forward-only rollback is supported via restore of the pre-migration `.orca/state.sqlite` backup.

## Logs

Logs use identifiers, hashes, role names, state names, and timestamps only. Prompts, rationales, raw responses, credentials, and check output streams are never logged.

## Failure codes

- `roster_drift` — paired session or model no longer matches the controller.
- `missing_role_profile` — `.opencode/agents/orca-<role>.md` is missing.
- `role_profile_mismatch` — role profile content or hash does not match.
- `worker_blocked` — worker task exceeded the controller timeout, hit repeated polling failure, or hit a permission request.
- `completion_blocked` — orchestrator's `request_completion` arrived before the final approval gate.

## Acceptance gate

`pnpm.cmd run verify:95` is the fake-readiness release gate. It runs lint + typecheck + build + unit + integration + contract + fake E2E + coverage. All subcommands must exit `0`. The fake five-session E2E suite (`tests/e2e/fake-complete-mission.test.ts`) drives the controller through the production-composed fake adapter: Planner → Builder → Reviewer → Tester → Final → explicit completion.

`pnpm.cmd run verify:release` adds the live OpenCode suite and is the path to the **live-validation readiness** milestone. It is implemented by `scripts/verify-release.cjs` and fails fast with a clear error message when:

- `ORCA_REAL_E2E` is not set to `"1"`, or
- `ORCA_LIVE_WORKTREE` does not point at the isolated worktree (e.g. `.worktrees/live-readiness-remediation`).

The real OpenCode five-session acceptance (`tests/e2e-real/real.test.ts`) must run inside the isolated worktree against a reachable authenticated OpenCode server with exactly five paired sessions, heterogeneous user-selected models, no active mission, valid role profiles, and a healthy controller. The test leaves its sentinel diff and `.orca` evidence intact for inspection; it never auto-commits, pushes, resets, or deletes user files.

`pnpm.cmd run verify` is an alias for `verify:95` and excludes the live suite by default.

## Live validation runbook

```powershell
# 1. Pick or create an isolated worktree and pair five OpenCode sessions in it.
git worktree add .worktrees/live-readiness-remediation codex/live-readiness-remediation
cd .worktrees/live-readiness-remediation
pnpm.cmd install --frozen-lockfile

# 2. Pair five sessions in the OpenCode desktop client for this worktree, then:
swarmctl doctor   # OpenCode health + roster freshness
swarmctl pair     # write the five-binding roster to .orca/state.sqlite

# 3. Set the live-validation environment flags and run the gated release lane.
$env:ORCA_REAL_E2E   = "1"
$env:ORCA_LIVE_WORKTREE = (Resolve-Path .).Path
$env:ORCA_OPENCODE_URL      = "http://127.0.0.1:4096"
$env:ORCA_OPENCODE_USERNAME = "opencode"
$env:ORCA_OPENCODE_PASSWORD = "<password>"
pnpm.cmd run verify:release
```

The release suite writes a sentinel `.orca/live-acceptance-sentinel.md` (forensic evidence) and a fresh mission row in `.orca/state.sqlite`. Inspect both before deciding to keep, revert, or reset the worktree. ORCA never commits, pushes, or deletes user files on its own.
