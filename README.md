# OpenCode Five-Session Orchestration

This repository is the foundation for a controller that coordinates five
manually opened OpenCode sessions:

- Orchestrator
- Planner
- Builder
- Reviewer
- Tester

See the task plan in `docs/superpowers/plans/2026-07-20-opencode-five-session-orchestration.md`.

## Readiness gates

The project is currently at **95% functional readiness** through a
production-composed fake OpenCode harness. Run:

```
pnpm.cmd run verify:95
```

to execute the full fake-readiness gate (lint + typecheck + build + unit +
integration + contract + fake E2E + coverage).

`verify:release` additionally runs the real OpenCode E2E suite and is the path
to **100% readiness**. Real OpenCode 1.18.3 is required and the harness must be
reachable via `OPENCODE_SERVER_URL`.

Documentation:

- `planning.md` — single active execution plan.
- `docs/architecture.md` — controller-first architecture.
- `docs/operations.md` — operational commands and shutdown.
- `docs/test-evidence.md` — empirical test evidence per task.
- `docs/threat-model.md` — security and reliability model.
- `docs/opencode-compatibility.md` — OpenCode 1.18.3 contract map.
