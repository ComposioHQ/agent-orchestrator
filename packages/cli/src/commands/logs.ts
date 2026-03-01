/**
 * `ao logs` — query structured logs from the orchestrator.
 *
 * Subcommands:
 *   ao logs dashboard  — dashboard process stdout/stderr
 *   ao logs events     — lifecycle state transitions
 *   ao logs session <id> — events for a specific session
 */

import { join } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import {
  readLogs,
  readLogsFromDir,
  tailLogs,
  type LogEntry,
  type LogQueryOptions,
} from "@composio/ao-core";
import { formatLogEntry, parseSinceArg } from "../lib/format.js";
import { resolveLogDir } from "../lib/perf-utils.js";

export function registerLogs(program: Command): void {
  const logsCmd = program
    .command("logs")
    .description("Query structured logs from the orchestrator");

  logsCmd
    .command("dashboard")
    .description("Show dashboard process logs")
    .option("--since <time>", "Show logs since (e.g., 5m, 1h, 2024-01-01)")
    .option("--level <level>", "Filter by level (stdout, stderr, info, warn, error)")
    .option("--tail <n>", "Show last N entries", "50")
    .option("--json", "Output as JSON")
    .action((opts: { since?: string; level?: string; tail?: string; json?: boolean }) => {
      try {
        const logDir = resolveLogDir();
        const logPath = join(logDir, "dashboard.jsonl");

        if (opts.since) {
          const queryOpts: LogQueryOptions = {
            since: parseSinceArg(opts.since),
            level: opts.level ? [opts.level as LogEntry["level"]] : undefined,
          };
          const entries = readLogs(logPath, queryOpts);
          printEntries(entries, opts.json);
        } else {
          const n = parseInt(opts.tail ?? "50", 10);
          let entries = tailLogs(logPath, n);
          if (opts.level) {
            entries = entries.filter((e) => e.level === opts.level);
          }
          printEntries(entries, opts.json);
        }
      } catch (err) {
        console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  logsCmd
    .command("events")
    .description("Show lifecycle event logs (state transitions)")
    .option("--since <time>", "Show events since (e.g., 5m, 1h)")
    .option("--session <id>", "Filter by session ID")
    .option("--type <type>", "Filter by event type pattern")
    .option("--json", "Output as JSON")
    .action((opts: { since?: string; session?: string; type?: string; json?: boolean }) => {
      try {
        const logDir = resolveLogDir();

        const queryOpts: LogQueryOptions = {
          source: "lifecycle",
          ...(opts.since && { since: parseSinceArg(opts.since) }),
          ...(opts.session && { sessionId: opts.session }),
          ...(opts.type && { pattern: opts.type }),
        };
        const entries = readLogsFromDir(logDir, "events", queryOpts);
        printEntries(entries, opts.json);
      } catch (err) {
        console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  logsCmd
    .command("session <id>")
    .description("Show all events for a specific session")
    .option("--json", "Output as JSON")
    .action((sessionId: string, opts: { json?: boolean }) => {
      try {
        const logDir = resolveLogDir();
        const entries = readLogsFromDir(logDir, "events", { sessionId });
        printEntries(entries, opts.json);
      } catch (err) {
        console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}

function printEntries(entries: LogEntry[], json?: boolean): void {
  if (json) {
    console.log(JSON.stringify(entries, null, 2));
  } else if (entries.length === 0) {
    console.log(chalk.dim("No log entries found."));
  } else {
    for (const entry of entries) {
      console.log(formatLogEntry(entry));
    }
    console.log(chalk.dim(`\n${entries.length} entries`));
  }
}
