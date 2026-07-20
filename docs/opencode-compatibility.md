# OpenCode Compatibility

## 2026-07-20 spike notes

- Confirmed integration entrypoint can be built by TypeScript/tsup.
- Confirmed integration entrypoint returns metadata for an OpenCode command registration.
- Added a compatibility test covering runtime command registration using a host-agnostic runtime abstraction.

### Evidence

- Unit test added: `tests/unit/opencode-compatibility.test.ts`
- Verified metadata output:
  - name: `opencode-orchestration`
  - version: from `package.json`
  - commands: `swarmctl`
- Verified command registration path using a stub runtime in test mode.

### Open question

- Determine whether OpenCode expects any additional entrypoint contract fields (for example, provider/permission registration hooks) before Task 3 implementation continues.
