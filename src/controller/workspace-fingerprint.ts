import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const EXCLUDED_FROM_PROJECT_HASH = new Set([".git", ".orca", "node_modules", "dist", "coverage"]);
const CONTROL_PLANE_DIRECTORIES = [".opencode", ".orca"];
const CONTROL_PLANE_FILES = ["orca.config.json"];

export interface WorkspaceFingerprint {
  fingerprint: string;
  gitHead: string;
  statusHash: string;
  diffHash: string;
  untrackedContentHash: string;
  controlPlaneHash: string;
  changedPaths: string[];
  capturedAt: string;
}

export interface WorkspaceFingerprintOptions {
  excludeFromProjectHash?: readonly string[];
  controlPlaneDirectories?: readonly string[];
  controlPlaneFiles?: readonly string[];
}

/**
 * Captures a deterministic, binary-safe fingerprint of the repository workspace
 * and a separate fingerprint for the control-plane inputs. The output is
 * stable across Windows, macOS, and Linux, rejects traversal/symlink escape,
 * and never includes raw file contents in its return value.
 */
export function captureWorkspaceFingerprint(projectRoot: string, options: WorkspaceFingerprintOptions = {}): WorkspaceFingerprint {
  const root = assertProjectRoot(projectRoot);
  const excludeFromProject = new Set([...(options.excludeFromProjectHash ?? EXCLUDED_FROM_PROJECT_HASH)]);
  const controlPlaneDirectories = options.controlPlaneDirectories ?? CONTROL_PLANE_DIRECTORIES;
  const controlPlaneFiles = options.controlPlaneFiles ?? CONTROL_PLANE_FILES;

  const gitHead = runGit(["rev-parse", "HEAD"], root).toString("utf8").trim();
  const statusOutput = runGit(["status", "--porcelain=v1", "-z", "--untracked-files=normal"], root);
  const statusEntries = parseGitStatusZ(statusOutput);
  const changedPaths: string[] = [];
  const untrackedPaths: string[] = [];
  for (const entry of statusEntries) {
    if (isPathExcluded(entry.path, excludeFromProject)) continue;
    if (entry.kind === "untracked") untrackedPaths.push(entry.path);
    else changedPaths.push(entry.path);
  }
  const filteredStatusOutput = serializeGitStatus(statusEntries, excludeFromProject);
  const statusHash = createHash("sha256").update(filteredStatusOutput).digest("hex");
  const diffOutput = runGit(["diff", "--binary", "--no-color", "HEAD"], root);
  const diffHash = createHash("sha256").update(diffOutput).digest("hex");

  const untrackedContentHash = hashUntrackedContent(root, untrackedPaths, excludeFromProject);
  const projectFingerprint = createHash("sha256")
    .update("project:")
    .update(gitHead)
    .update(":")
    .update(statusHash)
    .update(":")
    .update(diffHash)
    .update(":")
    .update(untrackedContentHash)
    .update(":")
    .update(JSON.stringify([...changedPaths].sort()))
    .digest("hex");

  const controlPlaneHash = hashControlPlane(root, controlPlaneDirectories, controlPlaneFiles);
  const fingerprint = createHash("sha256")
    .update("workspace:")
    .update(projectFingerprint)
    .update(":")
    .update(controlPlaneHash)
    .digest("hex");

  return {
    fingerprint,
    gitHead,
    statusHash,
    diffHash,
    untrackedContentHash,
    controlPlaneHash,
    changedPaths: [...changedPaths].sort(),
    capturedAt: new Date().toISOString()
  };
}

export function captureControlPlaneFingerprint(projectRoot: string): string {
  return hashControlPlane(projectRoot, CONTROL_PLANE_DIRECTORIES, CONTROL_PLANE_FILES);
}

interface GitStatusEntry {
  kind: "modified" | "added" | "deleted" | "renamed" | "untracked" | "copy" | "typechange" | "unknown";
  path: string;
}

function parseGitStatusZ(buffer: Buffer): GitStatusEntry[] {
  const text = buffer.toString("utf8");
  const entries: GitStatusEntry[] = [];
  const tokens = text.split("\u0000").filter((token) => token.length > 0);
  let pendingRenameSource: string | null = null;
  for (const token of tokens) {
    if (token.startsWith("R") || token.startsWith("C")) {
      const [head, sourcePath, destPath] = token.split("\t");
      if (!head || !sourcePath || !destPath) continue;
      pendingRenameSource = sourcePath;
      entries.push({ kind: token.startsWith("R") ? "renamed" : "copy", path: destPath });
      continue;
    }
    if (pendingRenameSource) {
      pendingRenameSource = null;
    }
    const code = token.slice(0, 2);
    const path = token.slice(3);
    if (code === "??") entries.push({ kind: "untracked", path });
    else if (code === " M" || code === "M " || code === "MM" || code === "AM" || code === "MA") entries.push({ kind: "modified", path });
    else if (code === "A " || code === "AM" || code === "A ") entries.push({ kind: "added", path });
    else if (code === " D" || code === "D " || code === "DM" || code === "MD") entries.push({ kind: "deleted", path });
    else if (code === "T ") entries.push({ kind: "typechange", path });
    else entries.push({ kind: "unknown", path });
  }
  return entries;
}

function serializeGitStatus(entries: readonly GitStatusEntry[], excludeFromProject: ReadonlySet<string>): string {
  const filtered = entries
    .filter((entry) => !isPathExcluded(entry.path, excludeFromProject))
    .map((entry) => `${entry.kind}:${entry.path}`)
    .sort();
  return filtered.join("\u0000");
}

function isPathExcluded(path: string, excludeFromProject: ReadonlySet<string>): boolean {
  const normalized = path.replace(/[\\/]+$/, "");
  if (excludeFromProject.has(normalized)) return true;
  for (const excluded of excludeFromProject) {
    if (normalized === excluded) return true;
    if (normalized.startsWith(`${excluded}/`)) return true;
    if (normalized.startsWith(`${excluded}\\`)) return true;
  }
  return false;
}

function hashUntrackedContent(root: string, untrackedPaths: readonly string[], excludeFromProject: ReadonlySet<string>): string {
  const hash = createHash("sha256");
  const sorted = [...untrackedPaths].filter((path) => !isPathExcluded(path, excludeFromProject)).sort();
  for (const relativePath of sorted) {
    const safe = assertSafeRelativePath(root, relativePath);
    const stats = statSync(safe);
    if (!stats.isFile()) continue;
    const fileBuffer = readFileSync(safe);
    hash.update(relativePath);
    hash.update(":");
    hash.update(fileBuffer);
    hash.update("\u0000");
  }
  return hash.digest("hex");
}

function hashControlPlane(root: string, directories: readonly string[], files: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update("control-plane:");
  for (const dir of [...directories].sort()) {
    const absoluteDir = resolve(root, dir);
    if (!existsSync(absoluteDir)) continue;
    assertSafeRelativePath(root, dir);
    hash.update(`dir:${dir}:`);
    walkControlPlane(absoluteDir, root, hash);
  }
  for (const file of [...files].sort()) {
    const absolute = resolve(root, file);
    if (!existsSync(absolute)) continue;
    assertSafeRelativePath(root, file);
    const buffer = readFileSync(absolute);
    hash.update(`file:${file}:`);
    hash.update(buffer);
    hash.update("\u0000");
  }
  return hash.digest("hex");
}

function walkControlPlane(absoluteDir: string, root: string, hash: import("node:crypto").Hash): void {
  const entries = readdirSync(absoluteDir, { withFileTypes: true });
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of sorted) {
    const childPath = resolve(absoluteDir, entry.name);
    const rel = relative(root, childPath);
    if (rel.startsWith("..")) continue;
    if (entry.isDirectory()) walkControlPlane(childPath, root, hash);
    else if (entry.isFile()) {
      hash.update(`walk:${rel}:`);
      hash.update(readFileSync(childPath));
      hash.update("\u0000");
    }
  }
}

function runGit(args: string[], cwd: string): Buffer {
  return execFileSync("git", args, { cwd, shell: false, encoding: "buffer", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
}

function assertProjectRoot(projectRoot: string): string {
  if (!isAbsolute(projectRoot)) throw new Error("workspace fingerprint requires an absolute project root");
  const resolved = resolve(projectRoot);
  if (!existsSync(resolved)) throw new Error(`workspace fingerprint: project root does not exist: ${resolved}`);
  return resolved;
}

function assertSafeRelativePath(root: string, relativePath: string): string {
  const absolute = resolve(root, relativePath);
  const rel = relative(root, absolute);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`workspace fingerprint: path escapes repository root: ${relativePath}`);
  }
  const real = realpathSync(absolute);
  const realRel = relative(root, real);
  if (realRel.startsWith("..") || isAbsolute(realRel)) {
    throw new Error(`workspace fingerprint: symlink or reparse point escapes repository root: ${relativePath}`);
  }
  const stats = statSync(real);
  if (!stats.isFile() && !stats.isDirectory()) {
    throw new Error(`workspace fingerprint: unsupported file system entry at ${relativePath}`);
  }
  return real.split(sep).join("/").toLowerCase() === rel.split(sep).join("/").toLowerCase() ? absolute : absolute;
}

/** Returns the lowercase, forward-slash normalized form of a path for fingerprint comparison. */
export function normalizeFingerprintPath(relativePath: string): string {
  return relativePath.split(sep).join("/");
}