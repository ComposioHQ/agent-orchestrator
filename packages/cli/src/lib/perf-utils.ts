/**
 * Shared helpers for performance analysis commands.
 * Used by `ao perf` and potentially other CLI commands that read API logs.
 */

import { loadConfig, resolveProjectLogDir, parseApiLogs } from "@composio/ao-core";
export type { ApiLogEntry as ParsedRequest } from "@composio/ao-core";

/** Resolve the log directory from config. Throws if no projects configured. */
export function resolveLogDir(): string {
  const config = loadConfig();
  const dir = resolveProjectLogDir(config);
  if (!dir) throw new Error("No projects configured. Run `ao init` first.");
  return dir;
}

/** Parse API log entries into typed request objects. */
export function loadRequests(logDir: string, opts?: { since?: Date; route?: string }) {
  return parseApiLogs(logDir, opts);
}
