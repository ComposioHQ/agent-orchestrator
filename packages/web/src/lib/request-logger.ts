/**
 * Structured API request logging with performance timing.
 *
 * Logs each API request to {logDir}/api.jsonl with timing breakdowns.
 * Provides getRequestStats() for aggregated analysis used by CLI and dashboard.
 */

import { getLogsDir, LogWriter, loadConfig, readLogsFromDir, percentile, normalizeRoutePath } from "@composio/ao-core";

export interface RequestLog {
  ts: string;
  method: string;
  path: string;
  sessionId: string | null;
  statusCode: number;
  durationMs: number;
  error?: string;
  timings?: {
    serviceInit?: number;
    sessionList?: number;
    prEnrichment?: number;
    issueEnrichment?: number;
    serialization?: number;
  };
  cacheStats?: {
    hits: number;
    misses: number;
    hitRate: number;
    size: number;
  };
}

export interface RouteStats {
  count: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  errors: number;
}

export interface RequestStatsResult {
  routes: Record<string, RouteStats>;
  slowest: RequestLog[];
}

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
export function logApiRequest(log: RequestLog): void {
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
): RequestStatsResult {
  const entries = readLogsFromDir(logDir, "api", {
    source: "api",
    since: opts?.since,
  });

  // Parse request logs from entries
  const requestLogs: RequestLog[] = [];
  for (const entry of entries) {
    const data = entry.data ?? {};
    if (!data["method"] || !data["path"]) continue;

    const log: RequestLog = {
      ts: entry.ts,
      method: String(data["method"]),
      path: String(data["path"]),
      sessionId: entry.sessionId,
      statusCode: Number(data["statusCode"]) || 0,
      durationMs: Number(data["durationMs"]) || 0,
      error: data["error"] ? String(data["error"]) : undefined,
      timings: data["timings"] as RequestLog["timings"],
      cacheStats: data["cacheStats"] as RequestLog["cacheStats"],
    };

    if (opts?.route && !log.path.includes(opts.route)) continue;
    requestLogs.push(log);
  }

  // Group by route (normalize path params)
  const byRoute = new Map<string, RequestLog[]>();
  for (const log of requestLogs) {
    const normalizedPath = normalizeRoutePath(log.path);
    const key = `${log.method} ${normalizedPath}`;
    const existing = byRoute.get(key) ?? [];
    existing.push(log);
    byRoute.set(key, existing);
  }

  // Compute per-route stats
  const routes: Record<string, RouteStats> = {};
  for (const [route, logs] of byRoute) {
    const durations = logs.map((l) => l.durationMs).sort((a, b) => a - b);
    routes[route] = {
      count: logs.length,
      avgMs: Math.round(durations.reduce((sum, d) => sum + d, 0) / durations.length),
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
      p99Ms: percentile(durations, 99),
      errors: logs.filter((l) => l.error || l.statusCode >= 400).length,
    };
  }

  // Find slowest requests
  const slowest = requestLogs
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 10);

  return { routes, slowest };
}

