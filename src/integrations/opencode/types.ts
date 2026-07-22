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
  lastActivity?: string;
}

export interface SessionStatus {
  idle: boolean;
  inFlightToolCalls: number;
}

export interface SessionPrompt {
  messageId: string;
  sessionId: string;
  content: string;
  agent: string;
  model: ModelRef;
}

export interface DeliveredTask {
  taskId: string;
  content: string;
}

export interface OpenCodeEvent {
  directory?: string;
  sessionId?: string;
  messageId?: string;
  type: string;
  payload?: unknown;
}

export interface OpenCodeMessagePart {
  id: string;
  type: string;
  text?: string;
  toolStatus?: "pending" | "running" | "completed" | "error";
}

export interface OpenCodeMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  parentId?: string;
  createdAt: string;
  completedAt?: string;
  parts: OpenCodeMessagePart[];
}
