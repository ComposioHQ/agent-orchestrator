import { createAoCliRunner, type AoCliRunner } from "./ao-cli.js";
import type { AoAutoReplyMetrics, AoSessionInfo } from "./commands.js";
import { classifySessionState } from "./session-classification.js";

export interface AoHealthSummary {
  timestamp: string;
  total: number;
  active: number;
  degraded: number;
  dead: number;
  stale: number;
  staleSessions: string[];
  failedSendCommands: number;
  failedSpawnCommands: number;
  source: "ao-cli" | "error";
  errorCode?: string;
  errorMessage?: string;
}

export interface AoHealthPollOptions {
  staleAfterMinutes?: number;
  runner?: AoCliRunner;
  metrics?: AoAutoReplyMetrics;
}

export interface AoHealthServiceOptions extends AoHealthPollOptions {
  pollIntervalMs?: number;
  onSummary: (summary: AoHealthSummary) => void | Promise<void>;
}

function parseAgeToMinutes(age: string): number {
  const trimmed = age.trim();
  if (!trimmed || trimmed === "-") return Number.POSITIVE_INFINITY;

  const match = /^(\d+)([smhd])$/.exec(trimmed);
  if (!match) return Number.POSITIVE_INFINITY;

  const value = Number.parseInt(match[1], 10);
  const unit = match[2];

  if (unit === "s") return value / 60;
  if (unit === "m") return value;
  if (unit === "h") return value * 60;
  return value * 60 * 24;
}

function classify(sessions: AoSessionInfo[], staleAfterMinutes: number): Omit<AoHealthSummary, "timestamp" | "source" | "failedSendCommands" | "failedSpawnCommands"> {
  let active = 0;
  let degraded = 0;
  let dead = 0;
  let stale = 0;
  const staleSessions: string[] = [];

  for (const session of sessions) {
    const sessionState = classifySessionState(session);
    if (sessionState === "active") {
      active += 1;
    } else if (sessionState === "dead") {
      dead += 1;
    } else if (sessionState === "degraded") {
      degraded += 1;
    }

    if (parseAgeToMinutes(session.lastActivity) >= staleAfterMinutes) {
      stale += 1;
      staleSessions.push(session.name);
    }
  }

  return {
    total: sessions.length,
    active,
    degraded,
    dead,
    stale,
    staleSessions,
  };
}

export async function collectAoHealthSummary(options?: AoHealthPollOptions): Promise<AoHealthSummary> {
  const runner = options?.runner ?? createAoCliRunner();
  const staleAfterMinutes = options?.staleAfterMinutes ?? 15;
  const metrics = options?.metrics;

  const response = await runner(["status", "--json"]);
  const base = {
    timestamp: new Date().toISOString(),
    failedSendCommands: metrics?.failedSendCommands ?? 0,
    failedSpawnCommands: metrics?.failedSpawnCommands ?? 0,
  };

  if (!response.ok) {
    return {
      ...base,
      total: 0,
      active: 0,
      degraded: 0,
      dead: 0,
      stale: 0,
      staleSessions: [],
      source: "error",
      errorCode: response.errorCode === "ENOENT" ? "ao_unavailable" : "ao_command_failed",
      errorMessage: response.errorCode === "ENOENT" ? "AO CLI unavailable" : "AO CLI command failed",
    };
  }

  try {
    const rows = JSON.parse(response.stdout) as Array<Record<string, unknown>>;
    const sessions: AoSessionInfo[] = rows.map((row) => ({
      name: String(row.name ?? ""),
      status: (row.status as string | null | undefined) ?? null,
      activity: (row.activity as string | null | undefined) ?? null,
      lastActivity: String(row.lastActivity ?? "-"),
    }));

    return {
      ...base,
      ...classify(sessions, staleAfterMinutes),
      source: "ao-cli",
    };
  } catch {
    return {
      ...base,
      total: 0,
      active: 0,
      degraded: 0,
      dead: 0,
      stale: 0,
      staleSessions: [],
      source: "error",
      errorCode: "ao_invalid_json",
      errorMessage: "AO CLI returned invalid JSON",
    };
  }
}

export class AoHealthPollingService {
  private readonly onSummary: (summary: AoHealthSummary) => void | Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly options: AoHealthPollOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(options: AoHealthServiceOptions) {
    this.onSummary = options.onSummary;
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;
    this.options = options;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.pollOnce().catch((error) => {
        console.error("[notifier-openclaw] AO health polling failed:", error);
      });
    }, this.pollIntervalMs);
    this.pollOnce().catch((error) => {
      console.error("[notifier-openclaw] AO health polling failed:", error);
    });
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async pollOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const summary = await collectAoHealthSummary(this.options);
      await this.onSummary(summary);
    } finally {
      this.running = false;
    }
  }
}
