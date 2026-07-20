# OpenCode Five-Session Orchestration Platform

Status checkboxes are maintained task-by-task as work is completed.

- [x] Inspect repository and conventions
- [x] Task 1: Repository foundation and quality gates
- [x] Task 2: OpenCode compatibility spike
- [x] Task 3: Domain schemas and result validation
- [x] Task 4: Workflow state machine and approval policy
- [ ] Task 5: SQLite persistence and transactional outbox
- [ ] Task 6: Git baseline and workspace fingerprints
- [ ] Task 7: OpenCode adapter and fake implementation
- [ ] Task 8: Pairing, roster fingerprints, and drift detection
- [ ] Task 9: Role definitions, permissions, and installer
- [ ] Task 10: Controlled diff and test execution
- [ ] Task 11: Dispatcher and completion detector
- [ ] Task 12: Controller service, API, and tool authentication
- [ ] Task 13: Mission workflow and approval service
- [ ] Task 14: Recovery and failure handling
- [ ] Task 15: CLI, status, doctor, and operational output
- [ ] Task 16: Full fake end-to-end tests
- [ ] Task 17: Real OpenCode end-to-end and visual acceptance test
- [ ] Task 18: Documentation, packaging, and final verification

## Task 1 progress

- [x] Created repository baseline directories
- [x] Added package and tooling configuration
- [x] Added bootstrap test and CLI version entrypoint
- [x] Run bootstrap test and observe initial failure
- [x] Implement versioned CLI entrypoint
- [x] Configure lint/typecheck/build/test scripts
- [x] Run bootstrap verification commands
- [x] Commit foundation work

## Task 2 progress

- [x] Added integration metadata contract in `integrations/opencode/types.ts`
- [x] Implemented `setupIntegrationEntry` and command registration helper in `integrations/opencode/generated-entry.ts`
- [x] Added compatibility unit test `tests/unit/opencode-compatibility.test.ts`
- [x] Captured compatibility evidence in `docs/opencode-compatibility.md`

## Task matrix reminders

- Pairing requires exactly five sessions in fixed positions.
- Planner/Reviewer/Tester receive read-only tool restrictions.
- Builder is the only role that may modify project files.
- Mission completion is enforced by controller policy in all approval paths.
