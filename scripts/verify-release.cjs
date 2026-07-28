#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");

function assertLiveEnabledOrSkip() {
  if (process.env.ORCA_REAL_E2E !== "1") {
    process.stderr.write("\n[verify:release] ORCA_REAL_E2E is not set to \"1\". The live acceptance suite must be explicitly enabled.\n");
    process.stderr.write("Set the variable, ensure the five OpenCode sessions are paired in the isolated worktree, then re-run:\n");
    process.stderr.write("  $env:ORCA_REAL_E2E = \"1\"; $env:ORCA_LIVE_WORKTREE = (Resolve-Path .).Path; pnpm.cmd run verify:release\n");
    process.stderr.write("See planning.md (Acceptance IDs CAC-8..CAC-13) for the prerequisites.\n");
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
  const normalized = path.resolve(worktreeHint).replace(/\\/g, "/");
  if (!/\.worktrees\/[^/]+$/i.test(normalized)) {
    process.stderr.write(`\n[verify:release] ORCA_LIVE_WORKTREE=${worktreeHint} is not inside .worktrees/<name>. Live acceptance must run in an isolated worktree.\n`);
    process.exit(2);
  }
  let gitHead;
  try {
    gitHead = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreeHint, encoding: "utf8" }).trim();
  } catch (error) {
    process.stderr.write(`\n[verify:release] failed to resolve git branch for ORCA_LIVE_WORKTREE=${worktreeHint}: ${error.message}\n`);
    process.exit(2);
  }
  if (gitHead === "main" || gitHead === "master") {
    process.stderr.write(`\n[verify:release] ORCA_LIVE_WORKTREE=${worktreeHint} is on protected branch ${gitHead}. Live acceptance must run on an isolated worktree branch.\n`);
    process.exit(2);
  }
  const expectedRoot = (() => {
    try { return path.resolve(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: worktreeHint, encoding: "utf8" }).trim()); }
    catch { return worktreeHint; }
  })();
  if (expectedRoot.replace(/\\/g, "/") !== normalized) {
    process.stderr.write(`\n[verify:release] ORCA_LIVE_WORKTREE=${worktreeHint} does not match the git worktree root ${expectedRoot}.\n`);
    process.exit(2);
  }
}

assertLiveEnabledOrSkip();

function run(label, command) {
  const fullCommand = `${command.cmd} ${command.args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ")}`;
  process.stdout.write(`\n[verify:release] ${label}: ${fullCommand}\n`);
  const result = spawnSync(command.cmd, command.args, { cwd: projectRoot, stdio: "inherit", shell: true });
  if (result.status !== 0) {
    process.stderr.write(`\n[verify:release] ${label} failed with exit code ${result.status ?? "unknown"}.\n`);
    process.exit(result.status ?? 1);
  }
}

run("verify:95", { cmd: "pnpm.cmd", args: ["run", "verify:95"] });
run("test:e2e:real", { cmd: "pnpm.cmd", args: ["run", "test:e2e:real"] });
process.stdout.write("\n[verify:release] fake + live acceptance suites passed.\n");