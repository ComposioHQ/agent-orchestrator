import type { Session, SessionManager } from "./types.js";

export interface PredecessorQueryOps {
  resume(sessionId: string): Promise<void>;
  send(sessionId: string, message: string): Promise<void>;
  capture(sessionId: string): Promise<string>;
  suspend(sessionId: string): Promise<void>;
}

export interface PredecessorQueryRequest {
  currentSession: Session;
  question: string;
  role?: string;
}

export interface PredecessorQueryResult {
  predecessorSessionId: string;
  response: string;
}

function isSuspendedSession(session: Session): boolean {
  return session.metadata["suspended"] === "true";
}

export class PredecessorQueryService {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly ops: PredecessorQueryOps,
  ) {}

  async query(request: PredecessorQueryRequest): Promise<PredecessorQueryResult | null> {
    const sessions = await this.sessionManager.list(request.currentSession.projectId);
    const predecessor = sessions
      .filter((session) => session.id !== request.currentSession.id)
      .filter(isSuspendedSession)
      .filter((session) => !request.role || session.metadata["role"] === request.role)
      .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime())[0];

    if (!predecessor) return null;

    await this.ops.resume(predecessor.id);
    try {
      await this.ops.send(predecessor.id, request.question);
      const response = await this.ops.capture(predecessor.id);
      return { predecessorSessionId: predecessor.id, response };
    } finally {
      await this.ops.suspend(predecessor.id);
    }
  }
}

