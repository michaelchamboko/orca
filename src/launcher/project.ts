import { realpathSync } from "node:fs";
import { normalize, resolve } from "node:path";

import { execa } from "execa";

import { LauncherError } from "./contracts.js";

export async function resolveCanonicalProjectRoot(cwd = process.cwd()): Promise<string> {
  const canonicalCwd = canonicalPath(cwd);
  const gitRoot = await execa("git", ["rev-parse", "--show-toplevel"], { cwd: canonicalCwd })
    .then((result) => canonicalPath(result.stdout.trim()))
    .catch(() => {
      throw new LauncherError("INVALID_REQUEST", "swarmctl ui must be run from a Git worktree root.", 400);
    });
  if (canonicalCwd !== gitRoot) {
    throw new LauncherError("INVALID_REQUEST", "swarmctl ui must be run from the Git worktree root selected in OpenCode.", 400);
  }
  return canonicalCwd;
}

export function canonicalPath(path: string): string {
  return normalize(realpathSync.native(resolve(path)));
}

export function validateLoopbackOpenCodeOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LauncherError("INVALID_REQUEST", "OpenCode server must be http://127.0.0.1:<port>.", 400);
  }
  if (
    url.protocol !== "http:"
    || url.hostname !== "127.0.0.1"
    || !url.port
    || url.username
    || url.password
    || (url.pathname !== "/" && url.pathname !== "")
    || url.search
    || url.hash
  ) {
    throw new LauncherError("INVALID_REQUEST", "OpenCode server must be http://127.0.0.1:<port>.", 400);
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new LauncherError("INVALID_REQUEST", "OpenCode server must include a valid loopback port.", 400);
  }
  return url.origin;
}
