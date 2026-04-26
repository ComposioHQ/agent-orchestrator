/**
 * `ao logs` — inspect the project-level event stream.
 *
 * Examples:
 *   ao logs                              # last 50 events for current project
 *   ao logs <session-id>                 # filter by session
 *   ao logs --project <project-id>       # filter by project (multi-project configs)
 *   ao logs --follow                     # tail the log
 *   ao logs --kind probe,transition      # filter kinds
 *   ao logs --limit 200                  # cap output
 *   ao logs --since 10m                  # only entries within the last 10 minutes
 *   ao logs --json                       # raw JSONL pass-through
 */

import type { Command } from "commander";
import chalk from "chalk";
import {
  followEventLog,
  getEventLogPath,
  loadConfig,
  readEventLog,
  type EventLogEntry,
  type EventLogKind,
  type EventLogLevel,
  type ReadEventLogOptions,
} from "@aoagents/ao-core";

const ALLOWED_KINDS: readonly EventLogKind[] = [
  "probe",
  "transition",
  "reaction",
  "api",
  "agent",
  "notify",
  "lifecycle",
  "session",
];

interface LogsOptions {
  project?: string;
  follow?: boolean;
  kind?: string;
  limit?: string;
  since?: string;
  correlationId?: string;
  json?: boolean;
  path?: boolean;
}

function parseDuration(input: string): number | null {
  const match = input.trim().match(/^(\d+)(ms|s|m|h|d)?$/);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  if (!Number.isFinite(value)) return null;
  switch (match[2]) {
    case "ms":
      return value;
    case "s":
    case undefined:
      return value * 1_000;
    case "m":
      return value * 60_000;
    case "h":
      return value * 3_600_000;
    case "d":
      return value * 86_400_000;
    default:
      return null;
  }
}

function parseKinds(raw: string | undefined): EventLogKind[] | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const unknown = parts.filter((p) => !ALLOWED_KINDS.includes(p as EventLogKind));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown --kind value(s): ${unknown.join(", ")}. Allowed: ${ALLOWED_KINDS.join(", ")}`,
    );
  }
  return parts as EventLogKind[];
}

function colorForLevel(level: EventLogLevel): (text: string) => string {
  switch (level) {
    case "error":
      return chalk.red;
    case "warn":
      return chalk.yellow;
    case "debug":
      return chalk.dim;
    default:
      return chalk.cyan;
  }
}

function formatEntry(entry: EventLogEntry): string {
  const time = entry.ts.replace(/\.\d{3}Z$/, "Z");
  const levelColor = colorForLevel(entry.level);
  const kind = levelColor(`[${entry.kind}]`);
  const op = chalk.bold(entry.operation);
  const scope: string[] = [];
  if (entry.projectId) scope.push(`project=${entry.projectId}`);
  if (entry.sessionId) scope.push(`session=${entry.sessionId}`);
  if (entry.fromStatus && entry.toStatus) {
    scope.push(`${entry.fromStatus}→${entry.toStatus}`);
  } else if (entry.toStatus) {
    scope.push(entry.toStatus);
  }
  const scopeStr = scope.length > 0 ? ` ${chalk.dim(scope.join(" "))}` : "";
  const reason = entry.reason ? ` ${chalk.dim("reason=")}${entry.reason}` : "";
  const corr = chalk.dim(`(${entry.correlationId})`);

  const parts = [`${chalk.dim(time)} ${kind} ${op}${scopeStr}${reason} ${corr}`];

  const probeBits: string[] = [];
  if (entry.runtimeProbe?.state || entry.runtimeProbe?.reason) {
    probeBits.push(
      `runtime=${entry.runtimeProbe.state ?? "?"}${
        entry.runtimeProbe.reason ? `(${entry.runtimeProbe.reason})` : ""
      }`,
    );
  }
  if (entry.processProbe?.state || entry.processProbe?.reason) {
    probeBits.push(
      `process=${entry.processProbe.state ?? "?"}${
        entry.processProbe.reason ? `(${entry.processProbe.reason})` : ""
      }`,
    );
  }
  if (entry.activityProbe?.state || entry.activityProbe?.reason) {
    probeBits.push(
      `activity=${entry.activityProbe.state ?? "?"}${
        entry.activityProbe.reason ? `(${entry.activityProbe.reason})` : ""
      }`,
    );
  }
  if (probeBits.length > 0) {
    parts.push(`    ${chalk.dim(probeBits.join(" "))}`);
  }
  return parts.join("\n");
}

function print(entry: EventLogEntry, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  } else {
    console.log(formatEntry(entry));
  }
}

function resolveScope(
  rawTarget: string | undefined,
  sessions: Set<string>,
  projects: Set<string>,
): { sessionId?: string; projectId?: string; ambiguous?: boolean; unknown?: boolean } {
  if (!rawTarget) return {};
  if (projects.has(rawTarget) && sessions.has(rawTarget)) {
    return { ambiguous: true };
  }
  if (projects.has(rawTarget)) return { projectId: rawTarget };
  if (sessions.has(rawTarget)) return { sessionId: rawTarget };
  // Heuristic: session ids look like `<prefix>-<n>` (with optional orchestrator suffix)
  // Project ids usually don't. Fall back to treating as a session id since that's
  // the common case for this command.
  if (/^[a-z][a-z0-9_-]*-\d+(-orchestrator.*)?$/i.test(rawTarget)) {
    return { sessionId: rawTarget, unknown: true };
  }
  return { projectId: rawTarget, unknown: true };
}

export function registerLogs(program: Command): void {
  program
    .command("logs [target]")
    .description(
      "Inspect the project event stream (probes, transitions, reactions). Target is a session-id or project-id.",
    )
    .option("--project <id>", "Filter by project id (overrides target)")
    .option("-f, --follow", "Tail the log")
    .option("--kind <kinds>", `Filter by event kind(s), comma-separated: ${ALLOWED_KINDS.join(",")}`)
    .option("-n, --limit <n>", "Return the last N matching entries (default: 50)")
    .option("--since <duration>", "Only entries newer than this (e.g. 5m, 30s, 2h)")
    .option("--correlation-id <id>", "Filter by correlation id")
    .option("--json", "Emit raw JSONL instead of a formatted view")
    .option("--path", "Print the event log file path and exit")
    .action(async (target: string | undefined, opts: LogsOptions) => {
      let config: ReturnType<typeof loadConfig>;
      try {
        config = loadConfig();
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        console.error(chalk.dim("Run `ao init` to create a config, or `cd` into a project."));
        process.exit(1);
      }

      if (opts.path) {
        console.log(getEventLogPath(config));
        return;
      }

      const projectIds = new Set(Object.keys(config.projects));
      // Session set is best-effort: we peek at the event log to enumerate ids.
      // This avoids a full session-manager load just to disambiguate.
      const peek = readEventLog(config, { limit: 500 });
      const sessionIds = new Set(peek.map((e) => e.sessionId).filter((v): v is string => !!v));

      const scope = resolveScope(target, sessionIds, projectIds);
      if (scope.ambiguous) {
        console.error(chalk.red(`"${target}" is both a project and session id. Use --project to disambiguate.`));
        process.exit(1);
      }

      let kinds: EventLogKind[] | undefined;
      try {
        kinds = parseKinds(opts.kind);
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      const projectFilter = opts.project ?? scope.projectId;
      if (projectFilter && !projectIds.has(projectFilter)) {
        console.error(chalk.yellow(`Note: project "${projectFilter}" is not in the current config.`));
      }

      const since = opts.since ? parseDuration(opts.since) : null;
      if (opts.since && since === null) {
        console.error(chalk.red(`Invalid --since value: "${opts.since}". Use Ns/Nm/Nh/Nd.`));
        process.exit(1);
      }

      const limit = opts.limit ? parseInt(opts.limit, 10) : 50;
      if (opts.limit && (!Number.isFinite(limit) || limit <= 0)) {
        console.error(chalk.red(`Invalid --limit: "${opts.limit}"`));
        process.exit(1);
      }

      const readOpts: ReadEventLogOptions = {
        projectId: projectFilter,
        sessionId: scope.sessionId,
        kinds,
        correlationId: opts.correlationId,
        sinceEpochMs: since !== null ? Date.now() - since : undefined,
        limit,
      };

      if (!opts.follow) {
        const entries = readEventLog(config, readOpts);
        if (entries.length === 0) {
          if (!opts.json) {
            console.log(chalk.dim(`No events found at ${getEventLogPath(config)}`));
            console.log(
              chalk.dim(
                "  Events are written when the lifecycle worker runs. If no worker is active, try `ao start` or trigger an ao command.",
              ),
            );
          }
          return;
        }
        for (const entry of entries) {
          print(entry, opts.json === true);
        }
        return;
      }

      // Follow mode — streams until user Ctrl-C'd.
      const handle = followEventLog(
        config,
        (entry) => print(entry, opts.json === true),
        readOpts,
      );
      const cleanup = (): void => {
        handle.stop();
        process.exit(0);
      };
      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);

      // Keep the process alive until signal.
      await new Promise<void>(() => {
        /* wait forever */
      });
    });
}
