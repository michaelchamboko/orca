# ORCA Architecture

ORCA is a local controller for five manually opened OpenCode sessions in one
Git worktree. The workflow roles are fixed: Orchestrator, Planner, Builder,
Reviewer, and Tester. Users choose which current OpenCode session occupies each
role; they do not redefine the workflow or change session models through ORCA.

## Components

- `src/cli/main.ts` exposes `swarmctl doctor`, `pair`, `status`,
  `controller start|status|stop`, and `ui`.
- `src/launcher/*` implements the foreground localhost dashboard used by
  `swarmctl ui`.
- `src/integrations/opencode/real.ts` is the live OpenCode HTTP/SSE adapter.
- `src/pairing/roster-service.ts` validates and persists fixed-role rosters.
- `src/controller/main.ts` composes the controller, event runtime, mission
  ingress, dispatch outbox, completion observer, and authenticated controller
  API.
- `src/persistence/sqlite.ts` owns `.orca\orca.db` migrations and workflow
  persistence.

## Launcher Boundary

The launcher is separate from the controller API. It binds only to
`127.0.0.1` on an ephemeral port, serves embedded HTML/CSS/JavaScript from the
TypeScript bundle, and starts an owned controller by calling `startController()`
without changing that contract.

The launcher accepts only standalone OpenCode at `http://127.0.0.1:<port>`.
It rejects remote hosts, `localhost`, file/UNC URLs, credentials in URLs, path
suffixes, query strings, and fragments.

The current working directory is the project authority. `swarmctl ui` must be
run from the canonical Git worktree root. There is no folder picker.

## Security Model

The first browser URL carries a short-lived bootstrap nonce in the fragment.
The browser exchanges it once for a host-only `HttpOnly`, `SameSite=Strict`
cookie and a per-session CSRF token. Mutating routes require exact Host,
Origin, JSON content type, the session cookie, and `X-ORCA-CSRF`.

The launcher disables CORS, uses a restrictive CSP, sets no-referrer and
nosniff headers, and renders all session titles, models, paths, and errors with
text nodes. OpenCode credentials and controller tokens remain server-side in
memory.

## Pairing Model

The launcher discovers OpenCode sessions for the canonical project root, but it
does not trust the requested root as evidence. If OpenCode omits a session
directory, that session is unverified and cannot be selected.

Pairing requires exactly five unique, active, idle sessions with known models
and verified directories matching the project root. The server maps submitted
session IDs through the fixed role order and persists the current OpenCode
models. Title-only changes are tolerated; ID, model, directory, server, closure,
or activity changes fail closed.

## Runtime Model

The controller remains the workflow authority. It owns mission ingress,
dispatch, completion observation, and status. The launcher only reports
redacted state and can stop a controller it started. An externally started
controller is visible but cannot be stopped from the UI.

The UI Start action is release-gated by the existing controller readiness plan:
assets active, roster current, five paired sessions idle, OpenCode healthy, no
active mission, no external controller, and no in-flight operation. Successful
start requires controller status to confirm current bindings/control plane and
working SSE or polling ingress.

## Release Boundary

The launcher does not introduce a daemon, autostart, scheduled task, firewall
rule, installer, browser credential input, model editor, workflow editor, or
mission textbox. Existing CLI commands remain the rollback and recovery path.

Real release still requires the fresh standalone OpenCode five-session receipt
defined in `planning.md`.
