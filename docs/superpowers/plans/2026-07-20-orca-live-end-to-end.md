# ORCA Live End-to-End Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Every task uses test-first red/green steps, a task-scoped commit, and an independent spec/code-quality review before the next task.

**Goal:** Deliver a runnable ORCA that pairs five real OpenCode sessions interactively, starts an external controller, visibly delegates work across those sessions, enforces review/test gates, survives restart, and completes a real code-change mission.

**Architecture:** ORCA connects to the existing authenticated OpenCode server through one real adapter, persists a fixed five-session roster in SQLite, and uses model-free OpenCode agent profiles for role permissions. The controller is the only workflow authority; it observes Session 1, dispatches prompts through the server API, validates structured results, and advances a mission only when durable gates pass.

**Current verified baseline:** `codex/orca-controller-first` contains reviewed adapter/fake work (`47531e5`) and five-session roster validation (`710ede4`, `8c5c44b`). The live OpenCode CLI is `1.18.3`; a server is listening at `http://127.0.0.1:4096` and currently returns HTTP Basic `401` without credentials. The original checkout has the corrected `dist/cli.js` package-script path, but no functional commands.

**Tech stack:** TypeScript 5.7, Node.js 24, Commander, native `fetch`, Fastify, Pino, Zod, better-sqlite3, execa, Vitest, tsup, OpenCode 1.18.3.

## Global constraints

- Build and commit only in `codex/orca-controller-first`; preserve the dirty `master` checkout.
- The first release gate is a live authenticated OpenCode connection and real interactive pairing, not another fake-only abstraction.
- One OpenCode server and exactly five unique sessions from the same repository are required.
- Pairing order is selected interactively and fixed as Orchestrator, Planner, Builder, Reviewer, Tester.
- ORCA records and reuses each session's selected provider/model; role profiles contain no `model` field.
- No browser, keyboard, mouse, terminal-tab automation, OpenCode source modification, or worker-to-worker transport.
- Reviewer and Tester profiles omit `edit` and `bash`; only Builder receives write/shell tools.
- Controller test execution accepts configured executable/argument arrays only, with `shell: false`.
- Server and controller credentials are never logged or stored in SQLite. Read `OPENCODE_SERVER_USERNAME` (default `opencode`) and `OPENCODE_SERVER_PASSWORD`; if the password is absent, prompt securely for the current process.
- The controller binds `127.0.0.1:4317`, uses a generated local bearer token stored in gitignored `.orca/controller-token`, and redacts it from logs.
- Every milestone ends with a command the user can run and an observed acceptance result. Do not document a command before it exists and passes its acceptance test.

---

## Milestone 1: A real CLI that diagnoses and pairs the live server

### Task 1: Reconcile the development branch and package the executable CLI

**Files:** `package.json`, `tsup.config.ts`, `src/cli/main.ts`, `tests/unit/cli.test.ts`, `.gitignore`

**Public interface:**

```text
pnpm run swarmctl -- --help
pnpm run swarmctl -- doctor --server http://127.0.0.1:4096
pnpm run swarmctl -- pair --server http://127.0.0.1:4096
pnpm run swarmctl -- status
pnpm run swarmctl -- controller start
```

- [ ] Copy the approved plan and the `package.json` `dist/cli.js` correction into the isolated branch; retain reviewed Task 1/2 commits.
- [ ] Add a failing CLI test proving the five command paths are registered and unknown commands exit nonzero; correct the Windows-invalid `tests/e2e:real` script path to `tests/e2e-real`.
- [ ] Add a `#!/usr/bin/env node` banner to the built CLI, `bin.swarmctl = "dist/cli.js"`, and Commander subcommands whose handlers are dependency-injected functions rather than placeholders.
- [ ] Make unimplemented handler injection fail with `ORCA_NOT_CONFIGURED` in tests; no command may silently exit zero.
- [ ] Add `.orca/` to `.gitignore` for runtime state and secrets.
- [ ] Run `pnpm vitest run tests/unit/cli.test.ts`, `pnpm run typecheck`, `pnpm run build`, and `pnpm run swarmctl -- --help`.
- [ ] Commit `feat: expose functional ORCA CLI commands` and pass independent review.

**Acceptance gate:** Help lists `doctor`, `pair`, `status`, and `controller`; invoking a missing/invalid subcommand returns a clear nonzero error instead of silence or `MODULE_NOT_FOUND`.

### Task 2: Implement authenticated live OpenCode diagnostics

**Files:** `src/integrations/opencode/real.ts`, `src/config/opencode-auth.ts`, `src/cli/doctor.ts`, `tests/contract/opencode-live-adapter.test.ts`, `tests/unit/opencode-auth.test.ts`

**Interfaces:**

```ts
interface OpenCodeConnectionConfig {
  baseUrl: string;
  username: string;
  password: string;
}

interface OpenCodeAdapter {
  health(): Promise<{ healthy: boolean; version?: string }>;
  listSessions(projectRoot: string): Promise<OpenCodeSession[]>;
  getSessionModel(sessionId: string): Promise<ModelRef>;
  sendPrompt(input: SessionPrompt): Promise<void>;
  subscribeEvents(signal: AbortSignal): AsyncIterable<OpenCodeEvent>;
  getSessionStatus(sessionId: string): Promise<SessionStatus>;
}
```

- [ ] Add failing contract tests using an HTTP fixture server for Basic Authorization, health, session listing, model lookup, async prompt dispatch, SSE event parsing, HTTP errors, and bounded timeouts.
- [ ] Implement the real adapter with native `fetch`; keep all endpoint paths and wire-shape translation in `real.ts`.
- [ ] Implement credential resolution: CLI flags are prohibited for passwords; environment first, secure prompt second; fail clearly when stdin is noninteractive and no password is available.
- [ ] Implement `doctor` to report CLI version, server reachability/authentication, OpenCode version when exposed, repository path, session count, SQLite native-binding availability, and role-profile availability without printing credentials or session contents.
- [ ] Run contract/unit/typecheck/lint tests, then run against `127.0.0.1:4096` with the user's credential supplied only through secure prompt or environment.
- [ ] Commit `feat: connect ORCA diagnostics to live OpenCode` and pass independent review.

**Acceptance gate:** `doctor` authenticates to the actual port 4096 server and reports its real session count. A `401` produces an actionable authentication message, never an empty/hanging command.

### Task 3: Install model-free role profiles and pair sessions interactively

**Files:** `src/roles/profiles.ts`, `src/roles/installer.ts`, `src/pairing/interactive.ts`, `src/pairing/roster-service.ts`, `src/persistence/sqlite.ts`, `tests/e2e/pair-live.test.ts`

**Role permissions:**

| Role | OpenCode agent mode | Allowed tools |
|---|---|---|
| Orchestrator | primary | `read,glob,grep,webfetch,websearch,task,todowrite,skill` |
| Planner | primary | `read,glob,grep,webfetch,websearch,lsp,skill` |
| Builder | primary | `bash,read,edit,glob,grep,webfetch,websearch,lsp,skill` |
| Reviewer | primary | `read,glob,grep,webfetch,websearch,lsp,skill` |
| Tester | primary | `read,glob,grep,lsp,skill` |

- [ ] Add failing snapshot tests proving every generated profile omits `model`, only Builder includes `edit`/`bash`, and role instructions require structured controller results.
- [ ] Install profiles under the target repository's `.opencode/agents/`; update only ORCA-owned files and report whether OpenCode detects them through `opencode agent list/debug`.
- [ ] Add failing interactive-selector tests for numbered choices, duplicate choices, cancellation, fewer/more than five candidates, sessions from another repository, missing models, and closed sessions.
- [ ] List candidates with position number, title, shortened session ID, selected provider/model, and last activity. Never infer visual tab order.
- [ ] Prompt sequentially for Session 1 through Session 5, validate the reviewed roster service, persist bindings/models/fingerprints, and print the final table for confirmation before saving.
- [ ] Persist `.orca/orca.db`; add schema migrations for rosters/session bindings and enforce unique positions, roles, and session IDs.
- [ ] Implement `status` to display the paired roster, model preservation, drift, and whether the controller is running.
- [ ] Run fake interaction tests, SQLite tests, then execute real interactive pairing against the five open sessions.
- [ ] Commit `feat: pair five live OpenCode sessions interactively` and pass independent review.

**Acceptance gate:** The user sees and confirms the exact five-session role/model table; `status` immediately reads the same durable roster; no model changes occur. If live role profiles require OpenCode reload, pairing exits with a precise one-time restart/re-pair instruction and does not claim success.

---

## Milestone 2: Start the controller and prove one visible delegation

### Task 4: Start an authenticated durable controller

**Files:** `src/controller/main.ts`, `src/controller/api.ts`, `src/controller/auth.ts`, `src/controller/runtime.ts`, `tests/contract/controller-start.test.ts`

- [ ] Add failing tests for loopback-only binding, generated bearer-token authentication, token/log redaction, double-start rejection, graceful shutdown, roster drift, missing server credentials, and stale PID files.
- [ ] Compose one process with SQLite, the real adapter, roster service, event listener, dispatcher, and health/status API.
- [ ] On startup authenticate to OpenCode, validate all five bindings/models/repository/profile availability, recover durable work, then begin event listening; never listen for missions when validation fails.
- [ ] Store PID/port metadata in `.orca/controller.json`; store the random bearer token separately in `.orca/controller-token` with user-only filesystem permissions where supported.
- [ ] Implement `controller start`, `controller stop`, and `controller status`; foreground is the default, `--daemon` is optional and must capture logs to `.orca/logs/` with size bounds.
- [ ] Run contract/typecheck/lint/build tests and start the controller against the live paired roster.
- [ ] Commit `feat: start authenticated ORCA controller` and pass independent review.

**Acceptance gate:** `controller start` stays running, `controller status` reports healthy OpenCode connectivity and five current bindings, and unauthenticated localhost requests receive `401`.

### Task 5: Deliver the first real Session 1 → Session 2 mission slice

**Files:** `src/controller/mission-service.ts`, `src/controller/dispatcher.ts`, `src/domain/action-schemas.ts`, `tests/e2e/live-planner-delegation.test.ts`

**Message protocol:**

```ts
type OrchestratorAction = {
  schemaVersion: "1.0";
  action: "start_mission" | "approve" | "reject" | "request_completion";
  missionId: string;
  taskId?: string;
  rationale: string;
};
```

- [ ] Add failing fake-E2E tests: only a new user message in paired Session 1 can start a mission; historical messages, worker messages, and a second mission are ignored/rejected.
- [ ] Pairing records an event cursor/start timestamp. The controller observes the first new Session 1 user instruction when no mission is active and prompts Session 1 under the Orchestrator profile for a structured `start_mission` action.
- [ ] Validate the action, create mission/Planner task/outbox in one SQLite transaction, then dispatch the Planner envelope into Session 2 using its captured model and `orca-planner` profile.
- [ ] Record adapter request/response metadata without prompt bodies or secrets. Persist an idempotency key before delivery.
- [ ] Add a live opt-in test that requires the actual paired roster and asks the user to confirm the Planner task is visible in Session 2.
- [ ] Run fake E2E first, then the real five-session slice. Stop this plan at this gate if the task is not visible; fix transport/session mapping before later workflow work.
- [ ] Commit `feat: delegate live missions from orchestrator to planner` and pass independent review.

**Acceptance gate:** The user types one instruction only in Session 1 and visibly sees the controller-generated Planner task in the selected Session 2. This is the first release-candidate checkpoint.

---

## Milestone 3: Complete the controller-enforced mission workflow

### Task 6: Validate worker completion with multiple signals

**Files:** `src/completion/detector.ts`, `src/domain/schemas.ts`, `tests/unit/completion-detector.test.ts`

- [ ] Require a role-specific structured result matching mission/task/session/role, session idle, zero in-flight tools, and a configurable 1.5-second quiet window.
- [ ] Deduplicate persisted event IDs; reconnect SSE with bounded exponential backoff and poll status while disconnected.
- [ ] Permit exactly one contract-repair prompt. A second invalid result blocks the task with a durable reason.
- [ ] Apply task timeout, session closure, pending permission, and controller-restart cases without treating idle alone as completion.
- [ ] Run detector unit tests covering every signal combination and commit `feat: detect worker completion safely` after review.

### Task 7: Enforce Plan → Build → Review → Test → Final completion

**Files:** `src/controller/mission-service.ts`, `src/domain/policy.ts`, `src/workspace/fingerprint.ts`, `src/execution/test-runner.ts`, `tests/e2e/fake-complete-mission.test.ts`

- [ ] Implement durable controller actions for worker-result ingestion and Session 1 approval/rejection; caller role comes only from the paired session ID.
- [ ] Planner success waits for Session 1 approval before Builder dispatch. Builder completion requires changed-file/diff/test evidence and creates a new workspace fingerprint.
- [ ] Reviewer receives the current fingerprint and cannot pass with blocking high/critical findings. Tester requests only named configured checks; the controller executes executable/argument arrays under the repository root with `shell: false`, timeout, and output truncation.
- [ ] Review/test failure creates a bounded Builder correction task. New Builder output deletes or invalidates older review/test approvals.
- [ ] Final completion requires a structured Session 1 `request_completion`, current passed review/test approvals, matching fingerprints, no running task/permission, and current roster/repository state.
- [ ] Add fake-E2E tests for happy path, plan rejection, review correction, test correction, stale approval, missing evidence, unsafe command, unauthorized caller, and premature completion.
- [ ] Commit `feat: enforce complete ORCA mission gates` only after all fake-E2E cases pass and independent review approves.

**Acceptance gate:** A fake five-session mission cannot skip a role, self-approve, use stale evidence, or complete without explicit current gates.

### Task 8: Make dispatch and restart recovery idempotent

**Files:** `src/persistence/sqlite.ts`, `src/controller/outbox-worker.ts`, `src/recovery/recovery-service.ts`, `tests/integration/recovery.test.ts`

- [ ] Version migrations for missions, tasks, approvals, events, snapshots, failure reasons, and outbox claim/attempt/error fields.
- [ ] Enforce one active mission per roster and unique dispatch idempotency keys.
- [ ] On restart reconcile claimed/unpublished actions with OpenCode session messages/events before retry; never assume uncertain work completed.
- [ ] Recover nonterminal missions, event cursors, quiet windows, pending permissions, and controller timeouts.
- [ ] Add crash-point tests before delivery, after delivery/before acknowledgment, during worker execution, and after approval/before next dispatch.
- [ ] Commit `feat: recover ORCA missions without duplicate dispatch` after integration tests and review.

---

## Milestone 4: Prove the real five-session product and package it

### Task 9: Run the real acceptance mission

**Files:** `tests/e2e-real/five-session-mission.test.ts`, `docs/test-evidence.md`, `docs/operations.md`, `docs/architecture.md`

- [ ] Add an opt-in real test guarded by `ORCA_REAL_E2E=1`; it must never create its own sessions or choose models.
- [ ] Pair the user's five open sessions interactively and record session IDs/models in redacted evidence.
- [ ] Run a small code change through Planner, Builder, Reviewer, and Tester; visually confirm each task appears in the selected session.
- [ ] Deliberately fail one review or test, observe correction returning only to Builder, and verify stale approvals disappear.
- [ ] Restart the controller during a second nonterminal mission and verify no duplicate prompt is delivered.
- [ ] Complete only through Session 1's explicit request after current review/test passes.
- [ ] Run `pnpm run lint`, `pnpm run typecheck`, unit, integration, contract, fake-E2E, real-E2E, coverage, and build. Required test lanes must no longer use `--passWithNoTests`.
- [ ] Update documentation with exact observed commands, exit codes, OpenCode 1.18.3 compatibility, authentication setup, limitations, and recovery steps.
- [ ] Commit `test: verify live five-session ORCA mission` and perform a final whole-branch review.

**Final acceptance:** From a clean checkout, the user builds once, pairs interactively, starts the controller, sends one mission only in Session 1, observes all delegated work in Sessions 2–5, observes a correction loop, restarts safely, and receives completion only after current review/test approval.

## User runbook after implementation

```powershell
cd "C:\Users\micha\Desktop\Antigravity Applications Created\opencodeOrka"
$env:OPENCODE_SERVER_USERNAME = "opencode"
$env:OPENCODE_SERVER_PASSWORD = Read-Host "OpenCode server password" -MaskInput
pnpm install --frozen-lockfile
pnpm run build
pnpm run swarmctl -- doctor --server http://127.0.0.1:4096
pnpm run swarmctl -- pair --server http://127.0.0.1:4096
pnpm run swarmctl -- controller start
```

After `controller start` reports healthy, the user types the mission only in paired Session 1. These commands must not be handed to the user again until their milestone acceptance tests pass.

## Definition of done

- Tasks 1–9 have task-scoped commits and clean independent reviews.
- The original dirty checkout is preserved until the completed branch is reviewed and intentionally integrated.
- All required local suites contain tests and exit zero; no pass-with-no-tests masking remains.
- The live authenticated server, interactive five-session pairing, visible delegation, correction loop, restart recovery, and final completion gate are observed with the user's actual sessions.
- If any live prerequisite is unavailable, the exact gate is marked blocked; ORCA is not described as operational.
