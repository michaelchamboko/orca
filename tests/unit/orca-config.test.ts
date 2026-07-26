import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadOrcaConfig, ORCA_CONFIG_FILENAME, OrcaConfigError, resolveExecutable } from "../../src/config/orca-config.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "orca-config-"));
  roots.push(root);
  return root;
}

function writeConfig(root: string, body: unknown): void {
  writeFileSync(join(root, ORCA_CONFIG_FILENAME), JSON.stringify(body));
}

describe("loadOrcaConfig", () => {
  it("loads a valid ORCA configuration", () => {
    const root = makeRoot();
    writeConfig(root, {
      schemaVersion: "1.0",
      checks: [
        { name: "lint", executable: "eslint", args: ["."], timeoutMs: 60_000 },
        { name: "typecheck", executable: "tsc", args: ["--noEmit"], timeoutMs: 60_000 }
      ]
    });
    const result = loadOrcaConfig(root);
    expect(result.config.checks.map((check) => check.name)).toEqual(["lint", "typecheck"]);
    expect(result.hash).toMatch(/^[a-f0-9]+$/);
  });

  it("rejects duplicate check names", () => {
    const root = makeRoot();
    writeConfig(root, {
      schemaVersion: "1.0",
      checks: [
        { name: "lint", executable: "eslint", args: ["."], timeoutMs: 60_000 },
        { name: "lint", executable: "tsc", args: ["--noEmit"], timeoutMs: 60_000 }
      ]
    });
    expect(() => loadOrcaConfig(root)).toThrow(OrcaConfigError);
  });

  it("rejects unknown executables", () => {
    const root = makeRoot();
    writeConfig(root, {
      schemaVersion: "1.0",
      checks: [{ name: "shell", executable: "bash", args: ["-c", "echo"], timeoutMs: 60_000 }]
    });
    expect(() => loadOrcaConfig(root)).toThrow(/unsupported executable/);
  });

  it("rejects shell operators in arguments", () => {
    const root = makeRoot();
    writeConfig(root, {
      schemaVersion: "1.0",
      checks: [{ name: "shell", executable: "eslint", args: ["./src && rm -rf /"], timeoutMs: 60_000 }]
    });
    expect(() => loadOrcaConfig(root)).toThrow(/shell operator/);
  });

  it("rejects NUL/newline control characters in arguments", () => {
    const root = makeRoot();
    writeConfig(root, {
      schemaVersion: "1.0",
      checks: [{ name: "ctrl", executable: "eslint", args: ["src\n"], timeoutMs: 60_000 }]
    });
    expect(() => loadOrcaConfig(root)).toThrow(/NUL or newline/);
  });

  it("rejects oversized arguments", () => {
    const root = makeRoot();
    writeConfig(root, {
      schemaVersion: "1.0",
      checks: [{ name: "huge", executable: "eslint", args: ["a".repeat(2049)], timeoutMs: 60_000 }]
    });
    expect(() => loadOrcaConfig(root)).toThrow(/exceeds/);
  });

  it("rejects missing or unknown fields", () => {
    const root = makeRoot();
    writeConfig(root, { schemaVersion: "1.0", checks: [], mystery: true });
    expect(() => loadOrcaConfig(root)).toThrow(OrcaConfigError);
  });

  it("rejects a missing configuration file", () => {
    const root = makeRoot();
    expect(() => loadOrcaConfig(root)).toThrow(/orca.config.json not found/);
  });

  it("rejects invalid JSON", () => {
    const root = makeRoot();
    writeFileSync(join(root, ORCA_CONFIG_FILENAME), "{ not json");
    expect(() => loadOrcaConfig(root)).toThrow(/not valid JSON/);
  });
});

describe("resolveExecutable", () => {
  it("returns pnpm.cmd on Windows", () => {
    expect(resolveExecutable("pnpm", "win32")).toBe("pnpm.cmd");
  });

  it("returns pnpm unchanged on POSIX", () => {
    expect(resolveExecutable("pnpm", "linux")).toBe("pnpm");
    expect(resolveExecutable("pnpm", "darwin")).toBe("pnpm");
  });

  it("returns other executables unchanged", () => {
    expect(resolveExecutable("eslint", "win32")).toBe("eslint");
  });
});

describe("ORCA_CONFIG_FILENAME", () => {
  it("is orca.config.json", () => {
    expect(ORCA_CONFIG_FILENAME).toBe("orca.config.json");
  });
});