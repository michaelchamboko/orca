import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { captureWorkspaceFingerprint, normalizeFingerprintPath } from "../../src/controller/workspace-fingerprint.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "orca-fingerprint-"));
  roots.push(root);
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: root, shell: false });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root, shell: false });
  execFileSync("git", ["config", "user.name", "ORCA test"], { cwd: root, shell: false });
  writeFileSync(join(root, "README.md"), "test\n");
  execFileSync("git", ["add", "README.md"], { cwd: root, shell: false });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, shell: false });
  return root;
}

describe("captureWorkspaceFingerprint", () => {
  it("produces a stable hash for an unchanged repository", () => {
    const root = makeRepo();
    const first = captureWorkspaceFingerprint(root);
    const second = captureWorkspaceFingerprint(root);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.gitHead).toMatch(/^[a-f0-9]+$/);
    expect(first.changedPaths).toEqual([]);
    expect(first.controlPlaneHash).toMatch(/^[a-f0-9]+$/);
  });

  it("changes when a tracked file is modified", () => {
    const root = makeRepo();
    const before = captureWorkspaceFingerprint(root);
    writeFileSync(join(root, "README.md"), "updated\n");
    const after = captureWorkspaceFingerprint(root);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(after.changedPaths).toContain("README.md");
  });

  it("changes when an untracked file is added", () => {
    const root = makeRepo();
    const before = captureWorkspaceFingerprint(root);
    writeFileSync(join(root, "draft.txt"), "new content\n");
    const after = captureWorkspaceFingerprint(root);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(after.untrackedContentHash).not.toBe(before.untrackedContentHash);
  });

  it("excludes node_modules, dist, and coverage from the project hash", () => {
    const root = makeRepo();
    const before = captureWorkspaceFingerprint(root);
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "node_modules", "package.json"), "{}");
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "bundle.js"), "var a=1;");
    mkdirSync(join(root, "coverage"));
    writeFileSync(join(root, "coverage", "out.json"), "{}");
    const after = captureWorkspaceFingerprint(root);
    expect(after.fingerprint).toBe(before.fingerprint);
  });

  it("changes when control-plane assets change", () => {
    const root = makeRepo();
    const before = captureWorkspaceFingerprint(root);
    mkdirSync(join(root, ".opencode", "agents"), { recursive: true });
    writeFileSync(join(root, ".opencode", "agents", "orca-orchestrator.md"), "---\nmode: primary\n---\n");
    const after = captureWorkspaceFingerprint(root);
    expect(after.controlPlaneHash).not.toBe(before.controlPlaneHash);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it("rejects traversal paths in the workspace", () => {
    const root = makeRepo();
    expect(() => captureWorkspaceFingerprint(join(root, "..", "evil"))).toThrow(/absolute project root|does not exist/);
  });

  it("rejects symlink escape from the repository", () => {
    if (process.platform === "win32") {
      const root = makeRepo();
      // Skip on Windows because creating symlinks requires elevated privileges.
      // The realpath traversal defense is exercised on POSIX runners.
      expect(captureWorkspaceFingerprint(root).fingerprint).toMatch(/^[a-f0-9]+$/);
      return;
    }
    const root = makeRepo();
    const outside = mkdtempSync(join(tmpdir(), "orca-escape-"));
    roots.push(outside);
    writeFileSync(join(outside, "secret.txt"), "secret\n");
    try {
      symlinkSync(join(outside, "secret.txt"), join(root, "linked-secret.txt"), "file");
      expect(() => captureWorkspaceFingerprint(root)).toThrow(/symlink or reparse point escapes/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("normalizes Windows path casing for fingerprint comparison", () => {
    const input = "Folder\\Subfolder\\file.txt";
    expect(normalizeFingerprintPath(input)).toBe("Folder/Subfolder/file.txt");
  });
});