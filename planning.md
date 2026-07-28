# ORCA-LIVE-READINESS-REMEDIATION-2026-07-28

> **Authoritative plan.** This file replaces the prior 95%-readiness plan with a targeted remediation plan for live-validation readiness. The plan must be executed from the isolated worktree at `.worktrees/live-readiness-remediation`.

---

# ORCA-LIVE-ACCEPTANCE-CORRECTION-2026-07-28

> **Targeted correction plan.** This amendment addresses the remaining live-validation defects identified after `bc13cf7` shipped the previous remediation plan. Preserve the passing fake workflow, make real agents receive useful mission context, and ensure the live test uses the manually paired roster and proves a Builder-created sentinel change.

## Acceptance IDs (correction)

- CAC-1 Every worker prompt payload carries the same mission id and original objective as the durable mission.
- CAC-2 Builder prompts include the approved Planner plan (steps, expected files, validation plan, acceptance criteria).
- CAC-3 Reviewer prompts include the Builder result/evidence and the current workspace fingerprint.
- CAC-4 Tester prompts include the controller-generated check evidence (required/passed/failed checks) and the tested workspace fingerprint.
- CAC-5 Builder correction tasks include the rejected review/test findings and the Orchestrator's correction instructions.
- CAC-6 The complete prompt payload is persisted transactionally with its task and dispatch intent.
- CAC-7 Missing required upstream context blocks dispatch instead of sending an empty task.
- CAC-8 The live test opens `.orca/orca.db`, never creates or uses a root-level `state.sqlite`, and refuses to pair sessions or change models.
- CAC-9 The live test fails fast on missing or stale roster, wrong repository binding, fewer/more than five bindings, missing model, existing active mission, existing sentinel, or OpenCode auth failure.
- CAC-10 The Builder (not the test harness) creates `docs/orca-live-acceptance-sentinel.md` containing the unique run id.
- CAC-11 Only the Builder changed project files; Reviewer and Tester fingerprints confirm no later mutation.
- CAC-12 The durable mission traversed Planner → Builder → Reviewer → Tester → final approval → explicit completion, and every dispatch used a paired model.
- CAC-13 `verify-release.cjs` validates `ORCA_REAL_E2E` and `ORCA_LIVE_WORKTREE` before running `verify:95` and refuses `main`/`master`.
- CAC-14 Documentation uses `.orca/orca.db`, 18 fake E2E tests, and the Builder-created sentinel; `docs/test-evidence.md` records fresh commit hashes.

## Execution Ledger

- [x] CORR-1 `fix: propagate mission context through ORCA workflow` — commit `318dae0`
- [x] CORR-2 `fix: make live acceptance use paired ORCA state` — commits `CORR-2a` (tests/e2e-real/real.test.ts), `CORR-2b` (scripts/verify-release.cjs)
- [x] CORR-3 `docs: align ORCA live release evidence` — commit `CORR-3` (docs/test-evidence.md, docs/threat-model.md, docs/architecture.md, docs/operations.md)

## Implementation Changes

### CORR-1 — Propagate real mission context

- Replace generic follow-on task content such as `"controller-dispatched task"` with persisted mission context.
- Builder receives the original objective, approved Planner result, expected files, validation plan, and acceptance criteria.
- Reviewer receives the objective, Builder result/evidence, and current workspace fingerprint.
- Tester receives controller check evidence and the tested workspace fingerprint.
- Builder correction tasks receive the rejected review/test findings and Orchestrator correction instructions.
- Persist each complete prompt payload transactionally with its task and dispatch intent.

Tests must prove:

- Every role receives the same real mission ID and objective.
- Builder receives the approved plan.
- Reviewer receives Builder evidence.
- Tester receives controller-generated check evidence.
- Correction tasks include the rejected findings.
- Missing required upstream context blocks dispatch instead of sending an empty task.

Commit: `fix: propagate mission context through ORCA workflow`

### CORR-2 — Correct the live acceptance harness

Modify `tests/e2e-real/real.test.ts`:

- Send a plain Session 1 user objective without `[ORCA_CORRELATION:]` or `[ORCA_DISPATCH:]`.
- Open the authoritative `.orca/orca.db`; never create or use root-level `state.sqlite`.
- Require an existing manually paired roster. Never call `RosterService.pair()` from the test.
- Fail before starting the controller if the roster is absent, stale, not exactly five sessions, points at another repository, or any paired model is missing.
- Fail if another mission is active.
- Remove `applySentinelChange()` and all direct test writes to the sentinel.
- Instruct the mission to create `docs/orca-live-acceptance-sentinel.md` containing a unique run ID.
- Fail before execution if the sentinel already exists; do not delete it automatically.
- After completion, verify:
  - Builder evidence names the sentinel.
  - The file contains the expected run ID.
  - Only the Builder changed project files.
  - Reviewer and Tester fingerprints confirm no later mutation.
  - The durable mission traversed Planner, Builder, Reviewer, Tester, final approval, and explicit completion.
  - All dispatches used the paired models.

Error tests must cover:

- Reserved marker in objective is rejected by the test helper.
- Missing `.orca/orca.db`.
- Empty or stale roster.
- Wrong repository binding.
- Fewer or more than five bindings.
- Missing model.
- Existing active mission.
- Existing sentinel.
- OpenCode authentication failure.
- Controller timeout or blocked mission.
- Missing Builder evidence.
- Unexpected changed path.
- Premature completion.

Commit: `fix: make live acceptance use paired ORCA state`

### CORR-3 — Correct release gating and documentation

- Move `ORCA_REAL_E2E` and `ORCA_LIVE_WORKTREE` validation before `verify:95` in `scripts/verify-release.cjs` so missing prerequisites genuinely fail fast with exit `2`.
- Verify the supplied worktree equals the current Git worktree and is not `main` or `master`.
- Keep all release commands fixed; no model output may influence executable names or arguments.
- Correct documentation to use `.orca/orca.db`, 18 fake E2E tests, and the Builder-created `docs/orca-live-acceptance-sentinel.md`.
- Update `docs/threat-model.md` to state that the real harness is implemented but remains unexecuted.
- Record fresh commit hashes and command outputs in `docs/test-evidence.md`; remove `<this commit>` placeholders.

Error tests must prove:

- Missing live flag exits `2` before lint/build/tests run.
- Missing or incorrect worktree exits `2`.
- Main/master worktree is rejected.
- Failed `verify:95` prevents live execution.
- Failed real E2E prevents a release-success message.
- No-environment real test remains skipped without claiming live success.

Commit: `docs: align ORCA live release evidence`

## Verification

Before each code edit, run GitNexus impact analysis on affected shared symbols. Before each commit, run `detect_changes()` and inspect `git diff`.

Run:

```powershell
pnpm.cmd run lint
pnpm.cmd run typecheck
pnpm.cmd run build
pnpm.cmd run test:unit
pnpm.cmd run test:integration
pnpm.cmd run test:contract
pnpm.cmd run test:e2e:fake
pnpm.cmd run test:coverage
pnpm.cmd run verify:95
node scripts/verify-release.cjs
git diff --check
git status --short --branch
```

Expected non-live result:

- All fake-readiness commands exit `0`.
- `node scripts/verify-release.cjs` without live variables exits `2` before running `verify:95`.
- Working tree is clean after scoped commits.

Live verification is performed only after five sessions are manually opened and paired in the isolated worktree:

```powershell
$env:ORCA_REAL_E2E = "1"
$env:ORCA_LIVE_WORKTREE = (Resolve-Path .).Path
pnpm.cmd run verify:release
```

## Completion Criteria

- The live objective is accepted by `MissionIngress`.
- The test uses the same `.orca/orca.db` written by `swarmctl pair`.
- The live test never pairs sessions or changes models.
- Builder—not the test harness—creates the sentinel.
- Every worker receives sufficient persisted mission context.
- All negative prerequisite and failure-path tests pass.
- `verify:95` remains green.
- Live success is claimed only after an observed five-session mission completes with current review/test gates and explicit Session 1 completion.

---

## Starting state (recorded before any edits)

- Repository root: `C:\Users\micha\Desktop\Antigravity Applications Created\opencodeOrka`
- Active checkout branch: `codex/fix-node24-sqlite`
- Active checkout commit: `03b0290498b775f61c32e51280db8a1c0004ba13`
- Active checkout status: clean (no uncommitted files except `.opencode/goals/`)
- Implementation worktree: `.worktrees/live-readiness-remediation` on branch `codex/live-readiness-remediation`
- Implementation worktree commit: `bc13cf7 docs+test: gate live acceptance, refresh architecture and runbook`
- Implementation worktree status: clean
- Baseline tests: `pnpm.cmd run typecheck` exits 0; `pnpm.cmd run test:unit` reports 171/171 passing
- Source register: every changed file will be listed in the commit message

## Acceptance IDs

- AC-1 Session 1 approval produces exactly one Builder dispatch
- AC-2 Polling + SSE duplicate observation consume the action once
- AC-3 No task envelope, dispatch key, prompt ID, approval, snapshot, or persistence record uses `"bootstrap"` or a synthetic mission ID
- AC-4 Fake E2E drives Planner → Builder → Reviewer → Tester → Final → explicit completion
- AC-5 Real E2E is a gated live acceptance test, not a deliberately failing placeholder
- AC-6 Live validation runs only in the isolated worktree with sentinel diff preserved
- AC-7 Documentation, scripts, and CLI commands agree with the source

## Summary

Make the current ORCA controller genuinely ready for live five-session validation. This plan fixes the verified runtime blockers first, proves the complete workflow through the production controller and fake adapter, then replaces the intentionally failing real-E2E placeholder with a gated acceptance run in an isolated worktree.

The implementation agent must preserve the active checkout and use the isolated worktree `.worktrees/live-readiness-remediation` for all code changes and validation.

## Implementation Changes

### 1. Restore Session 1 action consumption

- In `src/controller/event-runtime.ts`, invoke `missionContext.orchestratorActionIntake.observeEvent(event)` for eligible message events inside the existing reconciliation mutex.
- Invoke the action intake's polling/reconciliation method during the periodic reconciliation cycle so a missed SSE event cannot stall an approval.
- Preserve current authorization and correlation rules: only a stable assistant message in paired Session 1, parented by the pending controller decision prompt, may advance a gate.
- Add regression tests proving a Planner result produces a decision prompt, a correlated Session 1 approval produces exactly one Builder dispatch, and duplicate SSE/poll observations consume the action once.

### 2. Remove the fixed `"bootstrap"` mission identity

- Change `createMissionBindings()` and its task/decision factories so each dispatched task receives the actual `missionId` at creation time.
- Remove `"bootstrap"` from `startController()` composition; no task envelope, dispatch key, prompt ID, approval, snapshot, or persistence record may use a synthetic mission ID.
- Add tests for Planner → Builder → Reviewer → Tester proving every task/result/dispatch references the same mission and that two separate missions cannot share task IDs or dispatch keys.

### 3. Make the fake acceptance test complete and meaningful

- Expand `tests/e2e/fake-complete-mission.test.ts` to drive the actual `startController()` composition through:
  `Session 1 objective → Planner → plan approval → Builder → builder approval → Reviewer → review approval → controller checks → Tester → test approval → explicit completion`.
- Add fake cases for review correction, test correction, stale approval rejection, duplicate event delivery, restart recovery, model preservation, and premature completion.
- Do not accept a test that only checks prompt creation. Each stage must assert the target session, paired model, correlated parent prompt, durable mission state, and absence of direct worker-to-worker dispatch.
- If these tests expose defects in existing quality gates, completion handling, or recovery, repair only the minimal code required and add a regression test before proceeding.

### 4. Replace the fake real-E2E placeholder

- Replace `tests/e2e-real/real.test.ts` with an opt-in live acceptance test; it must not intentionally throw merely because `ORCA_REAL_E2E=1`.
- The test must fail fast unless all prerequisites are true: reachable authenticated OpenCode server, exactly five current paired sessions for the isolated worktree, heterogeneous models preserved from pairing, no active mission, valid role profiles, and controller health.
- It must never create sessions, choose/change models, use browser/terminal automation, or communicate directly between workers.
- Use one controlled sentinel documentation change in the isolated worktree only. The test leaves its resulting diff and `.orca` evidence intact for inspection; it must not auto-commit, push, reset, or delete user files.
- Bound each role wait and the whole mission timeout. On failure, report the durable mission state, redacted failure code, current task, and missing gate—not raw prompts, credentials, or model output.
- Change `verify:release` so it fails when live validation is not explicitly enabled; `verify:95` remains the fake-only gate.

### 5. Correct evidence and operations documentation

- Replace the obsolete claims in `docs/architecture.md` with the current implementation and explicitly list any remaining live-validation limitations.
- Correct `docs/operations.md` to use `swarmctl controller start`, not `swarmctl start`.
- Reconcile `planning.md` references to `verify:live` with the actual chosen command (`verify:release`, unless a `verify:live` alias is deliberately added and tested).
- Update `README.md` and `docs/test-evidence.md` only with fresh, commit-pinned command output. Do not retain "95% ready" claims if the full fake acceptance path is not passing.

## Execution and Review Loop

For every task:

1. Record the starting commit, clean-worktree status, source register entry, and acceptance IDs in `planning.md`.
2. Run GitNexus impact analysis before editing shared runtime, persistence, or public CLI symbols.
3. Write one failing focused test that proves the defect.
4. Implement the smallest change that makes it pass.
5. Run focused tests, then lint, typecheck, build, and affected integration/E2E lanes.
6. Have a different agent review the diff for workflow bypass, model mutation, direct worker communication, idempotency, and stale approvals.
7. Run GitNexus `detect_changes()` before each scoped commit.
8. Commit one reviewed task at a time; do not commit `.opencode/goals/`, credentials, generated indexes, or unrelated artifacts.

## Required Verification

Run from the isolated implementation worktree:

```powershell
pnpm.cmd run lint
pnpm.cmd run typecheck
pnpm.cmd run build
pnpm.cmd run test:unit
pnpm.cmd run test:integration
pnpm.cmd run test:contract
pnpm.cmd run test:e2e:fake
pnpm.cmd run test:coverage
pnpm.cmd run verify:95
git diff --check
git status --short --branch
```

Live acceptance runs only after the above passes and the five sessions are manually opened in the isolated worktree:

```powershell
$env:ORCA_REAL_E2E = "1"
pnpm.cmd run verify:release
```

## Completion Criteria

- A Session 1 approval visibly dispatches the next authorized role exactly once.
- No generated task uses `"bootstrap"` or another incorrect mission ID.
- Fake E2E proves the complete five-role sequence, correction loops, restart safety, stale-gate rejection, and model preservation.
- Real E2E is a real test, not a deliberately failing placeholder.
- Live validation runs only in the isolated worktree and preserves evidence for review.
- Documentation, scripts, and CLI commands agree with the source.
- The only allowed remaining blocker is external availability of a real OpenCode server and five manually paired sessions.

## Assumptions

- Live validation will use an isolated ORCA worktree, as selected.
- The user manually opens the five sessions and chooses their models before pairing.
- ORCA remains an external controller; it does not modify OpenCode source, models, or desktop UI.

Status: PLAN READY
Plan owner: lead build agent
