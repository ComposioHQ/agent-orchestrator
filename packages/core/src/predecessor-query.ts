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

function toTimestamp(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

async function suspendWithRetry(
  ops: PredecessorQueryOps,
  sessionId: string,
  attempts = 2,
): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await ops.suspend(sessionId);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
  throw new Error(
    `Failed to suspend predecessor session '${sessionId}' after ${attempts} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
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
      .sort((a, b) => toTimestamp(b.lastActivityAt) - toTimestamp(a.lastActivityAt))[0];

    if (!predecessor) return null;

    let primaryError: unknown = null;
    let suspendError: unknown = null;
    let response: string | null = null;
    await this.ops.resume(predecessor.id);
    try {
      await this.ops.send(predecessor.id, request.question);
      response = await this.ops.capture(predecessor.id);
    } catch (error) {
      primaryError = error;
    } finally {
      try {
        await suspendWithRetry(this.ops, predecessor.id);
      } catch (error) {
        suspendError = error;
      }
    }

    if (primaryError) throw primaryError;
    if (suspendError) throw suspendError;
    return {
      predecessorSessionId: predecessor.id,
      response: response ?? "",
    };
  }
}
