/**
 * Structured API request logging with performance timing.
 *
 * Logs each API request to {logDir}/api.jsonl with timing breakdowns.
 * For aggregated stats, use getRequestStats() which delegates to
 * parseApiLogs + computeApiStats from @composio/ao-core.
 */

import {
  getLogsDir,
  LogWriter,
  loadConfig,
  parseApiLogs,
  computeApiStats,
  type ApiLogEntry,
  type ApiPerfResult,
} from "@composio/ao-core";

// Re-export core types so callers don't need to import from two packages.
export type { ApiLogEntry as RequestLog, ApiPerfResult as RequestStatsResult } from "@composio/ao-core";
export type { RouteStats } from "@composio/ao-core";

let logWriter: LogWriter | null = null;

function getLogWriter(): LogWriter | null {
  if (logWriter) return logWriter;

  try {
    const config = loadConfig();
    const projectId = Object.keys(config.projects)[0];
    if (!projectId) return null;
    const project = config.projects[projectId];
    const logDir = getLogsDir(config.configPath, project.path);
    logWriter = new LogWriter({ filePath: `${logDir}/api.jsonl` });
    return logWriter;
  } catch {
    return null;
  }
}

/** Log an API request with timing data. */
export function logApiRequest(log: ApiLogEntry): void {
  const writer = getLogWriter();
  if (!writer) return;

  writer.append({
    ts: log.ts,
    level: log.error ? "error" : "info",
    source: "api",
    sessionId: log.sessionId,
    message: `${log.method} ${log.path} ${log.statusCode} ${log.durationMs}ms`,
    data: {
      method: log.method,
      path: log.path,
      statusCode: log.statusCode,
      durationMs: log.durationMs,
      ...(log.error && { error: log.error }),
      ...(log.timings && { timings: log.timings }),
      ...(log.cacheStats && { cacheStats: log.cacheStats }),
    },
  });
}

/** Compute aggregated request stats from api.jsonl logs. */
export function getRequestStats(
  logDir: string,
  opts?: { since?: Date; route?: string },
): ApiPerfResult {
  const entries = parseApiLogs(logDir, opts);
  return computeApiStats(entries);
}
