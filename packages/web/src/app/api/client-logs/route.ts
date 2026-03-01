import { NextResponse } from "next/server";
import { resolveProjectLogDir, LogWriter, loadConfig } from "@composio/ao-core";

let logWriter: LogWriter | null = null;

function getLogWriter(): LogWriter | null {
  if (logWriter) return logWriter;

  try {
    const logDir = resolveProjectLogDir(loadConfig());
    if (!logDir) return null;
    logWriter = new LogWriter({ filePath: `${logDir}/browser.jsonl` });
    return logWriter;
  } catch {
    return null;
  }
}

const VALID_LEVELS = new Set(["info", "warn", "error"]);

function isValidEntry(entry: unknown): entry is {
  level: "info" | "warn" | "error";
  message: string;
  url?: string;
  stack?: string;
  timing?: Record<string, number>;
} {
  if (typeof entry !== "object" || entry === null) return false;
  const obj = entry as Record<string, unknown>;
  return (
    typeof obj["message"] === "string" &&
    typeof obj["level"] === "string" &&
    VALID_LEVELS.has(obj["level"])
  );
}

/** POST /api/client-logs — Ingest batched browser-side log entries. */
export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    if (typeof body !== "object" || body === null) {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    const { entries } = body as Record<string, unknown>;
    if (!Array.isArray(entries)) {
      return NextResponse.json({ error: "Missing entries array" }, { status: 400 });
    }

    const writer = getLogWriter();
    if (!writer) {
      return NextResponse.json({ ok: true, logged: 0 });
    }

    let logged = 0;
    for (const entry of entries) {
      if (!isValidEntry(entry)) continue;
      writer.append({
        ts: new Date().toISOString(),
        level: entry.level,
        source: "browser",
        sessionId: null,
        message: entry.message,
        data: {
          ...(entry.url && { url: entry.url }),
          ...(entry.stack && { stack: entry.stack }),
          ...(entry.timing && { timing: entry.timing }),
        },
      });
      logged++;
    }

    return NextResponse.json({ ok: true, logged });
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
