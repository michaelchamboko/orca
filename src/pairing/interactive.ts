import type { OpenCodeSession } from "../integrations/opencode/types.js";
import { roleProfiles } from "../roles/profiles.js";

export type Prompt = (message: string) => Promise<string | undefined>;
export type Output = (line: string) => void;

export async function selectFiveSessions(candidates: readonly OpenCodeSession[], projectRoot: string, prompt: Prompt, output: Output): Promise<OpenCodeSession[]> {
  if (candidates.length < roleProfiles.length) throw new Error("at least five OpenCode sessions are required");
  const sessions = candidates.map(copySession);
  const uniqueIds = new Set(sessions.map((session) => session.id));
  if (uniqueIds.size !== sessions.length) throw new Error("candidate session IDs must be unique");

  output("Available OpenCode sessions:");
  sessions.forEach((session, index) => output(formatCandidate(index + 1, session)));
  const selected: OpenCodeSession[] = [];
  for (const profile of roleProfiles) {
    const answer = await prompt(`Session ${profile.position} (${profile.role}) [1-${sessions.length}] (or cancel): `);
    if (!answer || answer.trim().toLowerCase() === "cancel") throw new Error("pairing cancelled");
    const choice = Number(answer.trim());
    if (!Number.isInteger(choice) || choice < 1 || choice > sessions.length) throw new Error(`choose a session number from 1 to ${sessions.length}`);
    const session = sessions[choice - 1];
    if (selected.some((chosen) => chosen.id === session.id)) throw new Error("the same session cannot fill more than one role");
    assertSelectable(session, projectRoot);
    selected.push(session);
  }
  return selected;
}

export function formatCandidate(position: number, session: OpenCodeSession): string {
  const activity = session.lastActivity ?? "unknown activity";
  return `${position}. ${session.title || "Untitled"} | ${shortId(session.id)} | ${session.model.providerId}/${session.model.modelId} | ${activity}`;
}

function assertSelectable(session: OpenCodeSession, projectRoot: string): void {
  if (session.projectRoot !== projectRoot) throw new Error("selected session belongs to another repository");
  if (session.status === "closed" || session.status === "inactive") throw new Error("selected session is closed or inactive");
  if (!session.model.providerId || !session.model.modelId || session.model.providerId === "unknown" || session.model.modelId === "unknown") throw new Error("selected session has no model");
}

function shortId(id: string): string { return id.slice(0, 8); }

function copySession(session: OpenCodeSession): OpenCodeSession { return { ...session, model: { ...session.model } }; }
