import chalk from "chalk";
import type { CIStatus, ReviewDecision, ActivityState, LogEntry } from "@composio/ao-core";

export function header(title: string): string {
  const line = "─".repeat(76);
  return [
    chalk.dim(`┌${line}┐`),
    chalk.dim("│") + chalk.bold(` ${title}`.padEnd(76)) + chalk.dim("│"),
    chalk.dim(`└${line}┘`),
  ].join("\n");
}

export function banner(title: string): string {
  const line = "═".repeat(76);
  return [
    chalk.dim(`╔${line}╗`),
    chalk.dim("║") + chalk.bold.cyan(` ${title}`.padEnd(76)) + chalk.dim("║"),
    chalk.dim(`╚${line}╝`),
  ].join("\n");
}

export function formatAge(epochMs: number): string {
  const diff = Math.floor((Date.now() - epochMs) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function statusColor(status: string): string {
  switch (status) {
    case "working":
      return chalk.green(status);
    case "idle":
      return chalk.yellow(status);
    case "pr_open":
    case "review_pending":
      return chalk.blue(status);
    case "approved":
    case "mergeable":
    case "merged":
      return chalk.green(status);
    case "ci_failed":
    case "errored":
    case "stuck":
      return chalk.red(status);
    case "changes_requested":
    case "needs_input":
      return chalk.magenta(status);
    case "spawning":
      return chalk.cyan(status);
    case "killed":
    case "cleanup":
      return chalk.gray(status);
    default:
      return status;
  }
}

export function ciStatusIcon(status: CIStatus | null): string {
  switch (status) {
    case "passing":
      return chalk.green("pass");
    case "failing":
      return chalk.red("fail");
    case "pending":
      return chalk.yellow("pend");
    case "none":
    case null:
      return chalk.dim("-");
  }
}

export function reviewDecisionIcon(decision: ReviewDecision | null): string {
  switch (decision) {
    case "approved":
      return chalk.green("ok");
    case "changes_requested":
      return chalk.red("chg!");
    case "pending":
      return chalk.yellow("rev?");
    case "none":
    case null:
      return chalk.dim("-");
  }
}

export function activityIcon(activity: ActivityState | null): string {
  switch (activity) {
    case "active":
      return chalk.green("working");
    case "ready":
      return chalk.cyan("ready");
    case "idle":
      return chalk.yellow("idle");
    case "waiting_input":
      return chalk.magenta("waiting");
    case "blocked":
      return chalk.red("blocked");
    case "exited":
      return chalk.dim("exited");
    case null:
      return chalk.dim("unknown");
  }
}

/** Format milliseconds as human-readable duration. */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Parse a relative time string like "5m", "1h", "30s", "2d" into a Date. Also accepts ISO 8601. */
export function parseSinceArg(since: string): Date {
  const match = since.match(/^(\d+)(s|m|h|d)$/);
  if (!match) {
    const d = new Date(since);
    if (!isNaN(d.getTime())) return d;
    throw new Error(`Invalid time format: "${since}". Use "5m", "1h", "30s", or ISO 8601.`);
  }
  const value = parseInt(match[1], 10);
  const unit = match[2];
  const ms =
    unit === "s" ? value * 1000 :
    unit === "m" ? value * 60_000 :
    unit === "h" ? value * 3_600_000 :
    value * 86_400_000;
  return new Date(Date.now() - ms);
}

/** Color-code log level for terminal display. */
export function colorLevel(level: LogEntry["level"]): string {
  switch (level) {
    case "error": return chalk.red("ERR");
    case "warn": return chalk.yellow("WRN");
    case "stderr": return chalk.red("err");
    case "stdout": return chalk.dim("out");
    case "info": return chalk.blue("inf");
  }
}

/** Format a log entry for terminal display. */
export function formatLogEntry(entry: LogEntry): string {
  const ts = new Date(entry.ts).toLocaleTimeString();
  const level = colorLevel(entry.level);
  const session = entry.sessionId ? chalk.cyan(entry.sessionId) + " " : "";
  return `${chalk.dim(ts)} ${level} ${session}${entry.message}`;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*m/g;

/** Pad/truncate a string to exactly `width` visible characters */
export function padCol(str: string, width: number): string {
  // Strip ANSI codes to measure visible length
  const visible = str.replace(ANSI_RE, "");
  if (visible.length > width) {
    // Truncate visible content, re-apply truncation
    const plain = visible.slice(0, width - 1) + "\u2026";
    return plain.padEnd(width);
  }
  // Pad with spaces based on visible length
  const padding = width - visible.length;
  return str + " ".repeat(Math.max(0, padding));
}
