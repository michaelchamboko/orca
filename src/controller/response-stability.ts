import { createHash } from "node:crypto";

export interface StableResponseSnapshot {
  readonly outputMessageId: string | null;
  readonly outputHash: string | null;
  readonly completionAt: string | null;
}

export interface StableResponseCheckpoint {
  readonly snapshotHash: string | null;
  readonly stableSince: number | null;
  readonly stagnantPolls: number;
  readonly pollFailures: number;
  readonly contractRepairs: number;
  readonly acknowledgedAt: string | null;
  readonly outputMessageId?: string | null;
  readonly outputHash?: string | null;
  readonly completionAt?: string | null;
}

export const initialStableResponseCheckpoint: StableResponseCheckpoint = {
  snapshotHash: null,
  stableSince: null,
  stagnantPolls: 0,
  pollFailures: 0,
  contractRepairs: 0,
  acknowledgedAt: null
};

export function hashStableResponse(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Captures and verifies the durable shape of a worker's last assistant output.
 * The tracker never inspects the assistant text body; it relies on the caller to
 * provide the JSON string from the worker so that hash-based stability can be
 * compared without leaking the prompt body into logs.
 */
export class StableResponseTracker {
  private checkpoint: StableResponseCheckpoint;

  constructor(initial: StableResponseCheckpoint = initialStableResponseCheckpoint) {
    this.checkpoint = { ...initial };
  }

  snapshot(): StableResponseCheckpoint {
    return { ...this.checkpoint };
  }

  /** Returns the prior snapshot so callers can detect new vs repeated input. */
  observe(snapshot: StableResponseSnapshot, hash: string, now: number): { prior: StableResponseCheckpoint; advanced: boolean } {
    const prior = this.snapshot();
    const advanced = prior.outputMessageId !== snapshot.outputMessageId
      || prior.outputHash !== snapshot.outputHash
      || prior.completionAt !== snapshot.completionAt;
    const stagnantPolls = prior.snapshotHash === hash ? prior.stagnantPolls + 1 : 0;
    this.checkpoint = {
      ...prior,
      snapshotHash: hash,
      stagnantPolls,
      outputMessageId: snapshot.outputMessageId,
      outputHash: snapshot.outputHash,
      completionAt: snapshot.completionAt,
      stableSince: advanced ? now : prior.stableSince
    };
    return { prior, advanced };
  }

  recordAcknowledgement(timestamp: string | null): void {
    this.checkpoint = { ...this.checkpoint, acknowledgedAt: timestamp };
  }

  recordPollFailure(): number {
    const pollFailures = this.checkpoint.pollFailures + 1;
    this.checkpoint = { ...this.checkpoint, pollFailures };
    return pollFailures;
  }

  recordContractRepair(): number {
    const contractRepairs = this.checkpoint.contractRepairs + 1;
    this.checkpoint = { ...this.checkpoint, contractRepairs };
    return contractRepairs;
  }

  hasQuietWindowElapsed(now: number, quietWindowMs: number): boolean {
    const stableSince = this.checkpoint.stableSince;
    if (stableSince === null) return false;
    return now - stableSince >= quietWindowMs;
  }

  hasStagnated(maxStagnantPolls: number): boolean {
    return this.checkpoint.stagnantPolls >= maxStagnantPolls;
  }
}