import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export interface ProvisionalDispatchBaseline {
  baseCommit: string;
  sourceWorkspaceFingerprint: string;
  payload: Record<string, unknown>;
}

export function captureProvisionalDispatchBaseline(projectRoot: string): ProvisionalDispatchBaseline {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, shell: false, encoding: "buffer", windowsHide: true });
  const status = execFileSync("git", ["status", "--porcelain=v1", "-z"], { cwd: projectRoot, shell: false, encoding: "buffer", windowsHide: true });
  const sourceWorkspaceFingerprint = createHash("sha256").update(head).update(status).digest("hex");
  return {
    baseCommit: head.toString("utf8").trim(),
    sourceWorkspaceFingerprint,
    payload: {
      kind: "provisional_dispatch_baseline",
      approvalQuality: false,
      gitHeadRaw: head.toString("utf8"),
      gitStatusPorcelainV1ZRaw: status.toString("base64")
    }
  };
}
