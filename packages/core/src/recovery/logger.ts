import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionId, SessionStatus } from "../types.js";
import type { RecoveryLogEntry, RecoveryReport } from "./types.js";

export function writeRecoveryLog(logPath: string, entry: RecoveryLogEntry): void {
  const dir = dirname(logPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const line = JSON.stringify(entry) + "\n";
  appendFileSync(logPath, line, "utf-8");
}

export function createLogEntry(
  sessionId: SessionId,
  action: RecoveryLogEntry["action"],
  options?: {
    previousStatus?: SessionStatus;
    reason?: string;
    error?: string;
    details?: Record<string, unknown>;
  },
): RecoveryLogEntry {
  return {
    timestamp: new Date().toISOString(),
    sessionId,
    action,
    ...options,
  };
}

export function formatRecoveryReport(report: RecoveryReport): string {
  const lines: string[] = [
    `Recovery Report - ${report.timestamp.toISOString()}`,
    `Duration: ${report.durationMs}ms`,
    `Sessions scanned: ${report.totalScanned}`,
    "",
  ];

  if (report.recovered.length > 0) {
    lines.push(`Recovered (${report.recovered.length}): ${report.recovered.join(", ")}`);
  }

  if (report.cleanedUp.length > 0) {
    lines.push(`Cleaned up (${report.cleanedUp.length}): ${report.cleanedUp.join(", ")}`);
  }

  if (report.escalated.length > 0) {
    lines.push(`Escalated (${report.escalated.length}): ${report.escalated.join(", ")}`);
  }

  if (report.skipped.length > 0) {
    lines.push(`Skipped (${report.skipped.length}): ${report.skipped.join(", ")}`);
  }

  if (report.errors.length > 0) {
    lines.push("", "Errors:");
    for (const { sessionId, error } of report.errors) {
      lines.push(`  ${sessionId}: ${error}`);
    }
  }

  return lines.join("\n");
}

export function createEmptyReport(): RecoveryReport {
  return {
    timestamp: new Date(),
    totalScanned: 0,
    recovered: [],
    cleanedUp: [],
    escalated: [],
    skipped: [],
    errors: [],
    durationMs: 0,
  };
}
