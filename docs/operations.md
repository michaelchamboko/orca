# ORCA Operations

## Starting a mission

1. Pair five sessions with `swarmctl pair` (writes the authoritative roster to `.orca/orca.db`).
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

## Local launcher

For a gated localhost dashboard, run from the Git worktree root selected in OpenCode:

```powershell
node dist\cli.js ui --server http://127.0.0.1:4096
```

Use `--no-open` to print the one-time localhost URL without opening a browser.
The launcher binds to `127.0.0.1` on an ephemeral port and accepts only
standalone OpenCode origins of the form `http://127.0.0.1:<port>`.

`swarmctl ui` performs an authenticated `/global/health` preflight before
binding the dashboard. On transport failure, timeout, or `healthy: false` the
command exits with `OPENCODE_UNAVAILABLE` and does not start a launcher,
print a URL, or open a browser. HTTP 401 from the preflight keeps the
specific authentication diagnostic.

### Two-terminal startup order

ORCA talks to a supported standalone OpenCode server, not to OpenCode
Desktop's private, ephemeral sidecar. OpenCode Desktop being open is not a
substitute. Run the standalone server in terminal A and the ORCA CLI in
terminal B; the two terminals must agree on the fixed port and the
`OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD` environment
variables.

```powershell
# Terminal A — supported standalone server (terminal-scoped credentials).
$env:OPENCODE_SERVER_USERNAME = "opencode"
$env:OPENCODE_SERVER_PASSWORD = "<fresh local-only password>"
opencode serve --hostname 127.0.0.1 --port 59711

# Terminal B — verify reachability and credentials before launching the UI.
$env:OPENCODE_SERVER_USERNAME = "opencode"
$env:OPENCODE_SERVER_PASSWORD = "<same fresh local-only password>"
swarmctl doctor --server http://127.0.0.1:59711
swarmctl ui --server http://127.0.0.1:59711
```

Credential-matching rule: the credentials in terminal A (the standalone
server) must match the credentials in terminal B (the ORCA CLI). Wrong
credentials yield HTTP 401 with a specific authentication diagnostic, not
`OPENCODE_UNAVAILABLE`. Reuse the existing `--server` argument or the
`OPENCODE_SERVER_URL` environment variable instead of editing the launcher
contract.

The UI flow is fixed:

1. Install ORCA role and skill assets.
2. Restart OpenCode if the install changed any asset, then relaunch the UI.
3. Assign one idle OpenCode session to each fixed role:
   Orchestrator, Planner, Builder, Reviewer, Tester.
4. Pair the roster.
5. Start ORCA.

The mission objective is still entered in the assigned Orchestrator OpenCode
session. The UI has no mission prompt box, model picker, workflow editor,
credential field, or project folder picker.

The existing CLI remains the recovery path:

```powershell
node dist\cli.js doctor --server http://127.0.0.1:4096
node dist\cli.js pair --server http://127.0.0.1:4096
node dist\cli.js status
node dist\cli.js controller start
node dist\cli.js controller status
node dist\cli.js controller stop
```

Closing the browser does not stop ORCA. Use the UI Stop button for a
UI-owned controller, or run `swarmctl controller stop`. Ctrl+C in the
foreground launcher stops the dashboard and its owned controller cleanly.

Pairing and controller state are stored under `.orca\orca.db`. Controller
runtime metadata and token files are stored under `.orca\controller.json` and
`.orca\controller-token`.

## Health and readiness

- `GET /health` returns liveness only: process identity, version, port, binding count, OpenCode health, and binding freshness. No readiness or workflow detail is exposed to avoid leaking credentials or prompts.
- `GET /status` returns the operational readiness snapshot: active mission, current task role/state, pending dispatch count, event-stream connection state, polling fallback flag, roster freshness, control-plane freshness, and the last redacted failure code.
- Both endpoints require the bearer token persisted in `.orca/controller-token`. The token is locked down to the operating system user on POSIX (chmod 600) and to the active Windows user via `icacls`.
- `swarmctl status` and `swarmctl controller status` surface the same health/readiness snapshot via the CLI.

The launcher never exposes OpenCode credentials or controller tokens in HTML,
JavaScript state, URLs, API responses, SQLite rows, or logs.

## Restart and recovery

The controller is restart-safe. On startup it:

1. Rejects a stale runtime claim by reading `.orca/controller.json` and `/health` against the recorded process identity.
2. Replays the persisted `dispatch_outbox` leases through `claimNextDispatch`, recovering every pending dispatch including orchestrator decisions.
3. Walks `task_execution_metadata` for in-flight tasks and resumes the `WorkerCompletionService` quiet-window tracking.
4. Runs `MissionService.reconcileCompletedTasks` to advance any completed but unconsumed task into the next approval gate.

## Migrations

Migrations are additive. The controller refuses to start if a durable schema version is missing. Forward-only rollback is supported via restore of the pre-migration `.orca/orca.db` backup.

## Logs

Logs use identifiers, hashes, role names, state names, and timestamps only. Prompts, rationales, raw responses, credentials, and check output streams are never logged.

## Failure codes

- `roster_drift` — paired session or model no longer matches the controller.
- `missing_role_profile` — `.opencode/agents/orca-<role>.md` is missing.
- `role_profile_mismatch` — role profile content or hash does not match.
- `worker_blocked` — worker task exceeded the controller timeout, hit repeated polling failure, or hit a permission request.
- `completion_blocked` — orchestrator's `request_completion` arrived before the final approval gate.
- `mission.context_error` — a worker dispatch was blocked because the required upstream evidence was missing.

## Acceptance gate

`pnpm.cmd run verify:95` is the fake-readiness release gate. It runs lint + typecheck + build + unit + integration + contract + fake E2E + coverage. All subcommands must exit `0`. The fake five-session E2E suite (`tests/e2e/fake-complete-mission.test.ts`) drives the controller through the production-composed fake adapter: Planner → Builder → Reviewer → Tester → Final → explicit completion.

`pnpm.cmd run verify:release` adds the live OpenCode suite and is the path to the **live-validation readiness** milestone. It is implemented by `scripts/verify-release.cjs`. The script validates the prerequisites **before** any `verify:95` step runs and exits `2` with a clear error message when:

- `ORCA_REAL_E2E` is not set to `"1"`,
- `ORCA_LIVE_WORKTREE` is missing or does not point at an isolated worktree (`.worktrees/<name>`),
- the resolved branch is `main` or `master`,
- the worktree hint disagrees with the current git worktree root, or
- the worktree does not contain a `package.json`.

Only after these checks pass does the script run `verify:95` followed by `pnpm.cmd run test:e2e:real`.

The real OpenCode five-session acceptance (`tests/e2e-real/real.test.ts`) opens `.orca/orca.db` (it refuses to run when a root-level `state.sqlite` is present or `.orca/orca.db` is missing), requires an existing manually paired roster of exactly five sessions pointing at the worktree with non-empty models, fails fast on reserved markers in the objective or an existing `docs/orca-live-acceptance-sentinel.md`, refuses to call `RosterService.pair()`, and bounds every role wait and the whole mission. The Builder — not the test harness — creates the sentinel file with the unique run id; the test then verifies Builder evidence names the sentinel, the file contains the run id, only the Builder changed project files, the durable mission traversed every gate, and every dispatch used a paired model.

`pnpm.cmd run verify` is an alias for `verify:95` and excludes the live suite by default.

```powershell
node node_modules\vitest\vitest.mjs run tests\unit\launcher-api.test.ts tests\unit\cli.test.ts tests\unit\roster-service.test.ts tests\contract\opencode-live-adapter.test.ts tests\contract\controller-start.test.ts
node node_modules\typescript\bin\tsc -p tsconfig.json --noEmit
pnpm.cmd run lint
pnpm.cmd run build
node dist\cli.js ui --help
pnpm.cmd run verify:95
pnpm.cmd run verify:release
```

`verify:release` remains the live OpenCode gate. No release claim is valid until
a fresh five-session standalone OpenCode receipt proves fixed roles, unchanged
models, full role execution, a correction loop, restart recovery, truthful
status, explicit completion, and clean Stop.

## Live validation runbook

```powershell
# 1. Pick or create an isolated worktree and pair five OpenCode sessions in it.
git worktree add .worktrees/live-readiness-remediation codex/live-readiness-remediation
cd .worktrees/live-readiness-remediation
pnpm.cmd install --frozen-lockfile

# 2. Pair five sessions in the OpenCode desktop client for this worktree, then:
swarmctl doctor   # OpenCode health + roster freshness
swarmctl pair     # write the five-binding roster to .orca/orca.db

# 3. Set the live-validation environment flags and run the gated release lane.
$env:ORCA_REAL_E2E   = "1"
$env:ORCA_LIVE_WORKTREE = (Resolve-Path .).Path
$env:ORCA_OPENCODE_URL      = "http://127.0.0.1:4096"
$env:ORCA_OPENCODE_USERNAME = "opencode"
$env:ORCA_OPENCODE_PASSWORD = "<password>"
pnpm.cmd run verify:release
```

The release suite writes a sentinel `docs/orca-live-acceptance-sentinel.md` (created by the Builder — forensic evidence of the mission's file write) and a fresh mission row in `.orca/orca.db`. Inspect both before deciding to keep, revert, or reset the worktree. ORCA never commits, pushes, or deletes user files on its own.
