#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const projectRoot = path.resolve(__dirname, "..");
const scripts = {
  lint: { cmd: "pnpm.cmd", args: ["run", "lint"] },
  typecheck: { cmd: "pnpm.cmd", args: ["run", "typecheck"] },
  build: { cmd: "pnpm.cmd", args: ["run", "build"] },
  "test:unit": { cmd: "pnpm.cmd", args: ["run", "test:unit"] },
  "test:integration": { cmd: "pnpm.cmd", args: ["run", "test:integration"] },
  "test:contract": { cmd: "pnpm.cmd", args: ["run", "test:contract"] },
  "test:e2e:fake": { cmd: "pnpm.cmd", args: ["run", "test:e2e:fake"] },
  "test:coverage": { cmd: "pnpm.cmd", args: ["run", "test:coverage"] }
};

function run(label, command) {
  const fullCommand = `${command.cmd} ${command.args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ")}`;
  process.stdout.write(`\n[verify:release] ${label}: ${fullCommand}\n`);
  const result = spawnSync(command.cmd, command.args, { cwd: projectRoot, stdio: "inherit", shell: true });
  if (result.status !== 0) {
    process.stderr.write(`\n[verify:release] ${label} failed with exit code ${result.status ?? "unknown"}.\n`);
    process.exit(result.status ?? 1);
  }
}

function assertLiveEnabled() {
  if (process.env.ORCA_REAL_E2E !== "1") {
    process.stderr.write("\n[verify:release] ORCA_REAL_E2E is not set to \"1\". The live acceptance suite must be explicitly enabled.\n");
    process.stderr.write("Set the variable, ensure the five OpenCode sessions are paired in the isolated worktree, then re-run:\n");
    process.stderr.write("  $env:ORCA_REAL_E2E = \"1\"; pnpm.cmd run verify:release\n");
    process.stderr.write("See planning.md (Acceptance IDs AC-5 and AC-6) for the prerequisites.\n");
    process.exit(2);
  }
  const worktreeHint = process.env.ORCA_LIVE_WORKTREE;
  if (!worktreeHint) {
    process.stderr.write("\n[verify:release] ORCA_LIVE_WORKTREE must point to the isolated worktree (e.g. .worktrees/live-readiness-remediation).\n");
    process.exit(2);
  }
  if (!fs.existsSync(path.join(worktreeHint, "package.json"))) {
    process.stderr.write(`\n[verify:release] ORCA_LIVE_WORKTREE=${worktreeHint} does not contain a package.json. Refusing to run live validation.\n`);
    process.exit(2);
  }
}

for (const [label, command] of Object.entries(scripts)) run(label, command);
assertLiveEnabled();
run("test:e2e:real", { cmd: "pnpm.cmd", args: ["run", "test:e2e:real"] });
process.stdout.write("\n[verify:release] fake + live acceptance suites passed.\n");
