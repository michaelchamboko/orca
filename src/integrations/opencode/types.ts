import type { ModelRef } from "../../domain/types.js";

export interface OpencodeIntegrationRegistration {
  command: string;
  description: string;
}

export interface OpencodeIntegrationEntry {
  name: string;
  version: string;
  commands: OpencodeIntegrationRegistration[];
}

export interface OpencodeRuntime {
  registerCommand: (registration: OpencodeIntegrationRegistration) => void;
}

export interface OpenCodeSession {
  id: string;
  position: number;
  serverBaseUrl: string;
  projectRoot: string;
  model: ModelRef;
  title: string;
  status: string;
  inFlightToolCalls: number;
}

export interface SessionStatus {
  idle: boolean;
  inFlightToolCalls: number;
}

export interface SessionPrompt {
  sessionId: string;
  content: string;
  agent?: string;
  model?: ModelRef;
}

export interface DeliveredTask {
  taskId: string;
  content: string;
}

export interface OpenCodeEvent {
  sessionId: string;
  type: string;
  payload?: unknown;
}
