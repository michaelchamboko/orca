import { createHash } from "node:crypto";

import type { PairedRoster, SessionBinding } from "../domain/types.js";
import type { OpenCodeAdapter } from "../integrations/opencode/adapter.js";
import type { OpenCodeSession } from "../integrations/opencode/types.js";
import { roleProfiles } from "../roles/profiles.js";

export interface RosterPersistence {
  saveRoster(roster: PairedRoster): void;
  getCurrentRoster(): PairedRoster | null;
}

export class RosterService {
  constructor(private readonly adapter: OpenCodeAdapter, private readonly persistence: RosterPersistence) {}

  public async pair(): Promise<PairedRoster> {
    const orderedSessions = validateSessions(await this.adapter.listSessions());
    const pairedAt = new Date().toISOString();
    const fingerprint = fingerprintFor(orderedSessions);
    const roster: PairedRoster = {
      rosterId: fingerprint,
      fingerprint,
      serverBaseUrl: orderedSessions[0].serverBaseUrl,
      projectRoot: orderedSessions[0].projectRoot,
      pairedAt,
      bindings: orderedSessions.map((session, index) => bindingFor(session, index, pairedAt))
    };
    this.persistence.saveRoster(roster);
    return copyRoster(roster);
  }

  public async assertCurrent(): Promise<PairedRoster> {
    const roster = this.persistence.getCurrentRoster();
    if (!roster) throw new Error("no paired roster");
    try {
      if (fingerprintFor(validateSessions(await this.adapter.listSessions())) !== roster.fingerprint) {
        throw new Error("fingerprint differs");
      }
    } catch {
      throw new Error("roster drift");
    }
    return copyRoster(roster);
  }
}

function validateSessions(sessions: readonly OpenCodeSession[]): OpenCodeSession[] {
  const ids = new Set(sessions.map((session) => session.id));
  const positions = new Set(sessions.map((session) => session.position));
  const roots = new Set(sessions.map((session) => session.projectRoot));
  const servers = new Set(sessions.map((session) => session.serverBaseUrl));
  if (!sessions.every(isActiveSession)) {
    throw new Error("exactly five active sessions are required");
  }
  if (sessions.length !== 5 || ids.size !== 5 || positions.size !== 5 || roots.size !== 1 || servers.size !== 1 || !roleProfiles.every((profile) => positions.has(profile.position))) {
    throw new Error("exactly five unique sessions are required");
  }
  return [...sessions].sort((left, right) => left.position - right.position);
}

function isActiveSession(session: OpenCodeSession): boolean {
  return session.status !== "closed" && session.status !== "inactive";
}

function bindingFor(session: OpenCodeSession, index: number, pairedAt: string): SessionBinding {
  const profile = roleProfiles[index];
  return {
    sessionId: session.id,
    position: profile.position,
    role: profile.role,
    model: { ...session.model },
    agentName: session.title,
    projectRoot: session.projectRoot,
    projectFingerprint: sha256(JSON.stringify({ projectRoot: session.projectRoot })),
    serverBaseUrl: session.serverBaseUrl,
    sessionCreatedAt: pairedAt,
    pairedAt,
    rolePromptHash: sha256(JSON.stringify(profile.capabilities)),
    expectedTitle: session.title
  };
}

function fingerprintFor(sessions: readonly OpenCodeSession[]): string {
  const ordered = [...sessions].sort((left, right) => left.position - right.position);
  return sha256(JSON.stringify({
    serverBaseUrl: ordered[0]?.serverBaseUrl,
    projectRoot: ordered[0]?.projectRoot,
    sessions: ordered.map((session) => ({ id: session.id, title: session.title, providerId: session.model.providerId, modelId: session.model.modelId }))
  }));
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function copyRoster(roster: PairedRoster): PairedRoster {
  return { ...roster, bindings: roster.bindings.map((binding) => ({ ...binding, model: { ...binding.model } })) };
}
