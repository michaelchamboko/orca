import type {
  DeliveredTask,
  OpenCodeEvent,
  OpenCodeSession,
  SessionStatus
} from "./types.js";

export type {
  DeliveredTask,
  OpenCodeEvent,
  OpenCodeSession,
  SessionStatus
} from "./types.js";

export interface OpenCodeAdapter {
  listSessions(): Promise<OpenCodeSession[]>;
  deliverTask(sessionId: string, task: DeliveredTask): Promise<void>;
  getSessionStatus(sessionId: string): Promise<SessionStatus>;
  subscribe(listener: (event: OpenCodeEvent) => void): () => void;
}
