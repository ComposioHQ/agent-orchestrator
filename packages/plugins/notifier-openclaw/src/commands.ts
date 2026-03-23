import { createAoCliRunner, type AoCliRunner } from "./ao-cli.js";
import { summarizeSessionStates } from "./session-classification.js";

export type AoAutoReplyCommandType = "status" | "sessions" | "retry" | "kill";

export interface AoAutoReplyCommand {
  type: AoAutoReplyCommandType;
  sessionId?: string;
}

export interface AoSessionInfo {
  name: string;
  status: string | null;
  activity: string | null;
  lastActivity: string;
}

export interface AoAutoReplyResult {
  ok: boolean;
  code: string;
  message: string;
  command: AoAutoReplyCommandType;
}

export interface AoAutoReplyMetrics {
  failedSendCommands: number;
  failedSpawnCommands: number;
}

export interface AoAutoReplyDeps {
  runner?: AoCliRunner;
  retryMessage?: string;
  metrics?: AoAutoReplyMetrics;
}

const DEFAULT_RETRY_MESSAGE = "Please retry your current task and post a brief status update.";

export function parseAoAutoReplyCommand(text: string): AoAutoReplyCommand | null {
  const input = text.trim();
  const parts = input.split(/\s+/).filter(Boolean);
  if (parts[0] !== "/ao") return null;
  if (parts.length < 2) return null;

  const command = parts[1]?.toLowerCase();

  if (command === "sessions") {
    return { type: "sessions" };
  }

  if (command === "status") {
    return { type: "status", sessionId: parts[2] };
  }

  if (command === "retry") {
    const sessionId = parts[2];
    if (!sessionId) return null;
    return { type: "retry", sessionId };
  }

  if (command === "kill") {
    const sessionId = parts[2];
    if (!sessionId) return null;
    return { type: "kill", sessionId };
  }

  return null;
}

async function readSessions(runner: AoCliRunner): Promise<{
  ok: boolean;
  sessions?: AoSessionInfo[];
  errorCode: string;
  errorMessage: string;
}> {
  const result = await runner(["status", "--json"]);

  if (!result.ok) {
    const unavailable = result.errorCode === "ENOENT";
    return {
      ok: false,
      errorCode: unavailable ? "ao_unavailable" : "ao_command_failed",
      errorMessage: unavailable
        ? "AO CLI unavailable"
        : `AO CLI command failed (${result.exitCode})`,
    };
  }

  try {
    const parsed = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    const sessions: AoSessionInfo[] = parsed.map((row) => ({
      name: String(row.name ?? ""),
      status: (row.status as string | null | undefined) ?? null,
      activity: (row.activity as string | null | undefined) ?? null,
      lastActivity: String(row.lastActivity ?? "-"),
    }));

    return { ok: true, sessions, errorCode: "ok", errorMessage: "" };
  } catch {
    return {
      ok: false,
      errorCode: "ao_invalid_json",
      errorMessage: "AO CLI returned invalid JSON",
    };
  }
}

function withMetrics(metrics: AoAutoReplyMetrics | undefined, key: keyof AoAutoReplyMetrics): void {
  if (!metrics) return;
  metrics[key] += 1;
}

export async function executeAoAutoReplyCommand(
  command: AoAutoReplyCommand,
  deps?: AoAutoReplyDeps,
): Promise<AoAutoReplyResult> {
  const runner = deps?.runner ?? createAoCliRunner();

  if (command.type === "sessions") {
    const sessionsResponse = await readSessions(runner);
    if (!sessionsResponse.ok || !sessionsResponse.sessions) {
      return {
        ok: false,
        code: sessionsResponse.errorCode,
        message: sessionsResponse.errorMessage,
        command: command.type,
      };
    }

    const summary = summarizeSessionStates(sessionsResponse.sessions);
    const ids = sessionsResponse.sessions.map((s) => s.name).join(",") || "none";

    return {
      ok: true,
      code: "ok",
      message: `AO sessions total=${summary.total} active=${summary.active} degraded=${summary.degraded} dead=${summary.dead} ids=${ids}`,
      command: command.type,
    };
  }

  if (command.type === "status") {
    const sessionsResponse = await readSessions(runner);
    if (!sessionsResponse.ok || !sessionsResponse.sessions) {
      return {
        ok: false,
        code: sessionsResponse.errorCode,
        message: sessionsResponse.errorMessage,
        command: command.type,
      };
    }

    if (!command.sessionId) {
      const summary = summarizeSessionStates(sessionsResponse.sessions);
      return {
        ok: true,
        code: "ok",
        message: `AO status total=${summary.total} active=${summary.active} degraded=${summary.degraded} dead=${summary.dead}`,
        command: command.type,
      };
    }

    const session = sessionsResponse.sessions.find((s) => s.name === command.sessionId);
    if (!session) {
      return {
        ok: false,
        code: "session_not_found",
        message: `Session not found: ${command.sessionId}`,
        command: command.type,
      };
    }

    return {
      ok: true,
      code: "ok",
      message: `AO status session=${session.name} status=${session.status ?? "unknown"} activity=${session.activity ?? "unknown"} last=${session.lastActivity}`,
      command: command.type,
    };
  }

  if (command.type === "retry") {
    const sessionId = command.sessionId;
    if (!sessionId) {
      return {
        ok: false,
        code: "invalid_command",
        message: "Missing session id",
        command: command.type,
      };
    }

    const message = deps?.retryMessage?.trim() || DEFAULT_RETRY_MESSAGE;
    const result = await runner(["send", sessionId, message]);

    if (!result.ok) {
      withMetrics(deps?.metrics, "failedSendCommands");
      const code = result.errorCode === "ENOENT" ? "ao_unavailable" : "ao_send_failed";
      return {
        ok: false,
        code,
        message: code === "ao_unavailable" ? "AO CLI unavailable" : `ao send failed for ${sessionId}`,
        command: command.type,
      };
    }

    return {
      ok: true,
      code: "ok",
      message: `Retry queued for ${sessionId}`,
      command: command.type,
    };
  }

  const sessionId = command.sessionId;
  if (!sessionId) {
    return {
      ok: false,
      code: "invalid_command",
      message: "Missing session id",
      command: command.type,
    };
  }

  const result = await runner(["session", "kill", sessionId]);
  if (!result.ok) {
    const code = result.errorCode === "ENOENT" ? "ao_unavailable" : "ao_kill_failed";
    return {
      ok: false,
      code,
      message: code === "ao_unavailable" ? "AO CLI unavailable" : `ao session kill failed for ${sessionId}`,
      command: command.type,
    };
  }

  return {
    ok: true,
    code: "ok",
    message: `Session killed: ${sessionId}`,
    command: command.type,
  };
}
