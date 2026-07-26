# ORCA Threat Model

## Trust boundaries

| Boundary | Allowed | Prohibited |
|---|---|---|
| Operator → Session 1 | Open sessions, choose models, pair, message Session 1, intervene in blocked missions | Manual worker hand-offs are not required |
| Session 1 orchestrator | Submit correlated approvals, rejections, completion request | Write files, dispatch directly to workers, override controller gates |
| Session 2 Planner | Analyze the repository and return a plan | Write files, approve work, contact workers |
| Session 3 Builder | Modify project files and return evidence | Approve its own result, dispatch work, touch control-plane paths |
| Session 4 Reviewer | Inspect the workspace and return findings | Modify files, execute arbitrary commands |
| Session 5 Tester | Diagnose controller-produced evidence | Modify files, introduce commands, execute arbitrary shell |
| Controller | Authorize, transition, dispatch, test, persist, recover, complete | Change models, create sessions, automate UI, commit/push/reset |
| SQLite | Durable workflow source of truth | Store raw secrets or unbounded model output |

## Authorization boundaries

- Paired Session 1 identity is enforced by `RoleProfileReloadRequiredError` and
  the `RosterService.assertCurrent()` validator.
- Decision prompts carry a stable `decisionPromptMessageId` derived from the
  controller-side outbox, never from user input.
- Stable correlated Session 1 actions require a 1.5 second quiet window after
  the last assistant message mutation; the timer is reset on every content or
  tool-state change.
- The action's `parentId` must equal the active decision prompt id; mismatches
  are recorded as `rejected` and never advance the mission.

## Persistent invariant guarantees

- One active mission per roster is enforced by the `idx_mission_metadata_active_roster`
  partial unique index.
- `dispatch_outbox.prompt_message_id` is unique; duplicate enqueues throw.
- `dispatch_outbox` lease `attempt` increments on every claim; deliveries past
  `MAX_DELIVERY_ATTEMPTS` (3) block the mission.
- `task_execution_metadata` is updated together with `tasks.state` and
  `tasks.consumed_at` in a single transaction, so a crash anywhere inside
  `completeTaskExecutionAtomically` rolls the entire record back.
- Action intake records are durable (`orchestrator_action_messages` unique on
  `message_id`); repeated observation of the same stable response is a no-op.
- Permission requests persist in `permission_requests` and block completion
  while `state = 'open'`.
- Approval ledger rows are never deleted; superseded approvals gain
  `superseded_at`.

## Bounded evidence

- Controller subprocesses run via `spawn` with `shell: false`, fixed argv,
  bounded environment, and an explicit timeout.
- Each controlled-check stream (stdout, stderr) is capped at 64 KiB and
  records a `truncated` flag.
- Action intake persists only the validated action envelope, never raw
  message bodies.
- Worker completion trackers hash message parts and persist only hash
  representations, never the underlying text.

## Repository integrity

- Workspace fingerprint hashes `git rev-parse HEAD`, NUL-delimited
  `--porcelain=v1 -z` status, `--binary --no-color` diff, untracked bytes, and
  control-plane assets; excluded paths (`node_modules`, `dist`, `coverage`,
  `.git`, `.orca`) are stripped before hashing.
- Symlink and traversal escapes are rejected by `assertSafeRelativePath`
  via `realpathSync` containment checks.
- The control-plane hash covers `.opencode/**` and `orca.config.json` and is
  compared to a recorded baseline during readiness evaluation.

## Prompt neutrality

- `RoleProfile.tools` never contains `model`; model selection is exclusively
  paired at `RosterService.pair()` and frozen by `binding.rolePromptHash`.
- Role prompt bodies are advisory. The controller is the only authorization
  path.
- Only the Builder role is granted `bash` and `edit`; other roles are read-only.
- Skills are installed from `.opencode/skills/**` and never embedded into
  runtime decisions.

## Redaction policy

- Logs use identifiers, hashes, role names, state names, and timestamps only.
- The `/status` endpoint exposes only IDs, states, counts, connection state,
  polling fallback flag, and redacted failure codes. Prompts, rationales,
  credentials, and check output streams are not exposed.
- The `/health` endpoint is identical in policy; it never includes raw model
  output.

## Known residual risks

- Live OpenCode SSE is best-effort; the controller drops to polling when SSE
  is unavailable. The reconciliation mutex keeps state consistent under
  polling fallback but adds latency.
- Real OpenCode five-session acceptance is not yet automated; the 5% gap
  remains until `ORCA_REAL_E2E=1` is wired with a real OpenCode backend.
- Worker contract violations after the first repair attempt immediately
  block the task. Repeated contract violations across gates indicate either a
  role profile drift or a model capability regression.