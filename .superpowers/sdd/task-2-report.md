# Task 2 evidence: OpenCode message and event adapter

## Outcome

Implemented the Task 2 adapter contract only. The live adapter now lists and retrieves normalized session messages, posts correlated async prompts with the caller-provided agent and model pair, and unwraps documented global SSE envelopes. The fake adapter now supports normalized messages, correlated prompt inspection, and normalized event emission.

## Files changed

- `src/integrations/opencode/types.ts`
- `src/integrations/opencode/adapter.ts`
- `src/integrations/opencode/real.ts`
- `src/integrations/opencode/fake.ts`
- `tests/contract/opencode-live-adapter.test.ts`
- `tests/contract/opencode-adapter.test.ts`
- `tests/contract/controller-start.test.ts` (interface fixture stubs only)

## TDD evidence

RED was run before production changes:

```text
pnpm.cmd exec vitest run tests/contract/opencode-live-adapter.test.ts
exit 1: 5 failures / 11 tests
- listMessages is not a function
- correlated prompt omitted messageID
- SSE envelope remained unwrapped
- malformed SSE surfaced SyntaxError instead of a controlled adapter error
- message-list authentication path was unavailable
```

GREEN focused adapter verification:

```text
pnpm.cmd exec vitest run tests/contract/opencode-live-adapter.test.ts tests/contract/opencode-adapter.test.ts
exit 0: 2 files passed, 15 tests passed
```

The contract tests cover documented message GET routes, limit forwarding, message/part normalization, all required tool states, correlated async prompt body, no configuration transport call, global SSE envelope identity extraction, malformed SSE data, 401 handling, request timeout handling, and fake-adapter support.

## Required verification

| Command | Result |
| --- | --- |
| `pnpm.cmd run test:contract` | PASS — 3 files, 25 tests |
| `pnpm.cmd run test:unit` | PASS — 12 files, 57 tests |
| `pnpm.cmd run typecheck` | PASS |
| `pnpm.cmd run lint` | PASS |
| `pnpm.cmd run build` | PASS |

`test:unit` prints the expected `unknown command 'missing-command'` line from its CLI negative-case test; the suite exits 0. PowerShell prints PSReadLine terminal-capability warnings before commands; they are host-profile noise and all required commands exit successfully.

## Scope and limitations

No controller, persistence, mission, worker, or completion behavior was added. The adapter preserves absent optional message and event fields as `undefined` through optional normalized properties. The documented global envelope is validated; malformed data raises `OpenCodeEventError` rather than yielding a blank event.
