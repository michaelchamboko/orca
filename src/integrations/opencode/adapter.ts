import type {
  DeliveredTask,
  OpenCodeEvent,
  OpenCodeMessage,
  OpenCodeSession,
  SessionPrompt,
  SessionStatus
} from "./types.js";

export type {
  DeliveredTask,
  OpenCodeEvent,
  OpenCodeMessage,
  OpenCodeMessagePart,
  OpenCodeSession,
  SessionPrompt,
  SessionStatus
} from "./types.js";
import type { ModelRef } from "../../domain/types.js";

export interface OpenCodeAdapter {
  listSessions(projectRoot?: string): Promise<OpenCodeSession[]>;
  deliverTask(sessionId: string, task: DeliveredTask): Promise<void>;
  getSessionStatus(sessionId: string): Promise<SessionStatus>;
  subscribe(listener: (event: OpenCodeEvent) => void): () => void;
}

export interface OpenCodeLiveAdapter extends OpenCodeAdapter {
  health(): Promise<{ healthy: boolean; version?: string }>;
  getSessionModel(sessionId: string): Promise<ModelRef>;
  listMessages(sessionId: string, limit?: number): Promise<OpenCodeMessage[]>;
  getMessage(sessionId: string, messageId: string): Promise<OpenCodeMessage>;
  sendPrompt(input: SessionPrompt): Promise<void>;
  subscribeEvents(signal: AbortSignal): AsyncIterable<OpenCodeEvent>;
}
