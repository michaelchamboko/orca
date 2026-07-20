# Live Task 2 Report — OpenCode diagnostics

## Outcome

Implemented the credential-safe live OpenCode adapter and `doctor` diagnostics.

## Files

- `src/config/opencode-auth.ts` — environment-first credential resolution; masked interactive password entry; noninteractive failure.
- `src/integrations/opencode/real.ts` — native-fetch Basic Auth client, bounded requests, health/session/model/status/prompt/SSE translation.
- `src/cli/doctor.ts` and `src/cli/main.ts` — live diagnostics and actionable authentication error.
- `src/integrations/opencode/{adapter,fake,types}.ts` — live adapter contract and test-compatible fake support.
- `tests/contract/opencode-live-adapter.test.ts` — HTTP fixture coverage for authorization, health, sessions, model lookup, async prompts, SSE, errors, and timeouts.
- `tests/unit/{opencode-auth,doctor}.test.ts` — credential and redacted diagnostics coverage.

## Test evidence

| Command | Exit | Result |
| --- | ---: | --- |
| `pnpm vitest run tests/unit/opencode-auth.test.ts tests/unit/doctor.test.ts tests/contract/opencode-live-adapter.test.ts` | 0 | 10 focused tests passed. |
| `pnpm run typecheck` | 0 | Passed. |
| `pnpm run lint` | 0 | Passed. |
| `pnpm run test:unit` | 0 | 43 passed; 4 existing SQLite tests skipped. |
| `pnpm run test:contract` | 0 | 8 passed. |
| `pnpm run build` | 0 | Passed. |
| unauthenticated `GET http://127.0.0.1:4096/global/health` | 0 | Observed HTTP 401 safely; no credentials supplied. |

The focused tests were first run in RED: missing `opencode-auth.ts`, `real.ts`, and `doctor.ts` modules prevented collection as expected. They passed after implementation.

## Live gate

The server at `127.0.0.1:4096` is reachable and correctly challenges unauthenticated requests with HTTP 401. No live authenticated request was attempted because no user credential was supplied. Therefore the acceptance gate for actual authentication and real session count remains pending the user supplying `OPENCODE_SERVER_PASSWORD` or entering it at the secure interactive prompt.

## Commit

`feat: connect ORCA diagnostics to live OpenCode`

## Concerns

- The contract fixture tracks the published OpenCode server routes; exact session wire fields and real session count still need authenticated verification against the local OpenCode 1.18.3 server.
- The existing persistence suite continues to skip four SQLite-native tests in this environment; `doctor` independently checks whether the native binding loads.
