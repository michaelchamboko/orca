# OpenCode Five-Session Orchestration

This repository hosts the ORCA controller that coordinates five manually opened OpenCode sessions in a single repository:

| Session | Role         | Authority                                  |
| ------- | ------------ | ----------------------------------------- |
| 1       | Orchestrator | Approves, rejects, requests completion   |
| 2       | Planner      | Discovery, decomposition                   |
| 3       | Builder      | Project files + targeted tests            |
| 4       | Reviewer     | Read-only review                          |
| 5       | Tester       | Read-only test evidence                   |

The user picks each session's model; ORCA preserves the model and never mutates it. The controller observes Session 1, ingests the user objective, dispatches visible work to Sessions 2–5, asks Session 1 for correlated decisions, and enforces Plan → Build → Review → Test → explicit final completion.

The authoritative execution plan is `planning.md` (the ORCA-LIVE-READINESS-REMEDIATION-2026-07-28 plan).

## Readiness gates

### Fake-readiness gate

```
pnpm.cmd run verify:95
```

runs lint + typecheck + build + unit + integration + contract + fake E2E + coverage. This is the gate that proves the controller-owned workflow end-to-end against the production-composed fake OpenCode adapter (`tests/e2e/fake-complete-mission.test.ts`).

### Live-acceptance gate

```
$env:ORCA_REAL_E2E = "1"
$env:ORCA_LIVE_WORKTREE = (Resolve-Path .).Path
pnpm.cmd run verify:release
```

runs `verify:95` and then `tests/e2e-real/real.test.ts` against a real OpenCode server. The release lane refuses to start unless:

- `ORCA_REAL_E2E=1` is exported.
- `ORCA_LIVE_WORKTREE` points at an isolated worktree (e.g. `.worktrees/live-readiness-remediation`) whose current branch is not `main` or `master`.
- The OpenCode server is reachable at `ORCA_OPENCODE_URL` with the credentials in `ORCA_OPENCODE_USERNAME` / `ORCA_OPENCODE_PASSWORD`.
- Five paired sessions, the controller role profiles, and a healthy controller are present.

The live test writes a sentinel `.orca/live-acceptance-sentinel.md` and a fresh mission row to `.orca/state.sqlite` for forensic inspection; ORCA never auto-commits, pushes, resets, or deletes user files.

### Alias

```
pnpm.cmd run verify
```

is an alias for `verify:95` (no live suite).

## Documentation

- `planning.md` — single active execution plan (ORCA-LIVE-READINESS-REMEDIATION-2026-07-28).
- `docs/architecture.md` — controller-first architecture, runtime, contracts, capability matrix, live-validation limitations.
- `docs/operations.md` — operational commands (`swarmctl pair`, `swarmctl controller start`, `/health`, `/status`) and the live-acceptance runbook.
- `docs/test-evidence.md` — empirical test evidence per remediation task with commit-pinned command output.
- `docs/threat-model.md` — security and reliability model.
- `docs/opencode-compatibility.md` — OpenCode 1.18.3 contract map.

## Local launcher

After building, run the gated localhost dashboard from the Git worktree root:

```powershell
node dist\cli.js ui --server http://127.0.0.1:4096
```

The dashboard installs role assets, assigns the five fixed roles to existing
OpenCode sessions, pairs the roster, and starts a UI-owned controller. Use
`--no-open` to print the one-time URL without opening a browser.

`swarmctl ui` performs an authenticated `/global/health` preflight before
binding. On transport failure, timeout, or `healthy: false` the command
exits with `OPENCODE_UNAVAILABLE` and does not start a launcher. HTTP 401
from the preflight keeps the specific authentication diagnostic.

### Two-terminal startup order

ORCA talks to a supported standalone OpenCode server, not to OpenCode
Desktop's private, ephemeral sidecar. OpenCode Desktop being open is not a
substitute. Start the standalone server in terminal A and run ORCA in
terminal B; both terminals must agree on the fixed port and the
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
node dist\cli.js doctor --server http://127.0.0.1:59711
node dist\cli.js ui --server http://127.0.0.1:59711
```
