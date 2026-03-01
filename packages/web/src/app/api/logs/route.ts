import { NextResponse } from "next/server";
import {
  resolveProjectLogDir,
  readLogsFromDir,
  tailLogs,
  loadConfig,
  type LogQueryOptions,
  type LogEntry,
} from "@composio/ao-core";

function resolveLogDir(): string {
  const dir = resolveProjectLogDir(loadConfig());
  if (!dir) throw new Error("No projects configured.");
  return dir;
}

/**
 * GET /api/logs — Query structured logs.
 *
 * Query params:
 *   source     — "dashboard" | "events" | "api" | "browser"
 *   since      — ISO 8601 timestamp
 *   level      — comma-separated levels
 *   sessionId  — filter by session
 *   limit      — max entries (default 200)
 *   tail       — return last N entries instead of filtering
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const source = searchParams.get("source") ?? "events";
    const since = searchParams.get("since");
    const level = searchParams.get("level");
    const sessionId = searchParams.get("sessionId");
    const limit = parseInt(searchParams.get("limit") ?? "200", 10);
    const tail = searchParams.get("tail");

    const logDir = resolveLogDir();

    // Map source to file prefix
    const prefixMap: Record<string, string> = {
      dashboard: "dashboard",
      events: "events",
      api: "api",
      browser: "browser",
    };
    const prefix = prefixMap[source] ?? "events";
    const filePath = `${logDir}/${prefix}.jsonl`;

    let entries: LogEntry[];

    if (tail) {
      entries = tailLogs(filePath, parseInt(tail, 10));
    } else {
      const opts: LogQueryOptions = {
        ...(since && { since: new Date(since) }),
        ...(level && { level: level.split(",") as LogEntry["level"][] }),
        ...(sessionId && { sessionId }),
        limit,
      };
      entries = readLogsFromDir(logDir, prefix, opts);
    }

    return NextResponse.json({ entries, count: entries.length });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read logs" },
      { status: 500 },
    );
  }
}
