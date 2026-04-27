import chalk from "chalk";
import type { Command } from "commander";
import {
  queryActivityEvents,
  searchActivityEvents,
  getActivityEventStats,
  loadConfig,
  findConfigFile,
  type ActivityEvent,
  type ActivityEventKind,
} from "@aoagents/ao-core";

function parseSinceDuration(raw: string): Date | undefined {
  const match = raw.match(/^(\d+)(m|h|d)$/);
  if (!match) return undefined;
  const value = parseInt(match[1], 10);
  const unit = match[2];
  const ms = unit === "m" ? value * 60_000 : unit === "h" ? value * 3_600_000 : value * 86_400_000;
  return new Date(Date.now() - ms);
}

function formatRow(ev: ActivityEvent): string {
  const ts = new Date(ev.tsEpoch).toLocaleTimeString();
  const session = ev.sessionId ? ev.sessionId.slice(0, 12) : "—";
  const kind = chalk.cyan(ev.kind.padEnd(22));
  const level =
    ev.level === "error"
      ? chalk.red(ev.level)
      : ev.level === "warn"
        ? chalk.yellow(ev.level)
        : chalk.gray(ev.level);
  return `${chalk.dim(ts)}  ${kind}  ${level.padEnd(9)}  ${chalk.dim(session)}  ${ev.summary}`;
}

async function loadCfg() {
  const cfgPath = findConfigFile();
  if (!cfgPath) return null;
  try {
    return await loadConfig(cfgPath);
  } catch {
    return null;
  }
}

export function registerEvents(program: Command): void {
  const events = program
    .command("events")
    .description("Query activity event log (session spawns, transitions, CI failures)");

  events
    .command("list")
    .description("List recent activity events")
    .option("-p, --project <id>", "Filter by project ID")
    .option("-s, --session <id>", "Filter by session ID")
    .option("-t, --type <kind>", "Filter by event kind (e.g. session.spawned, lifecycle.transition)")
    .option("--since <duration>", "Show events from last N minutes/hours/days (e.g. 30m, 2h, 1d)")
    .option("-n, --limit <n>", "Max results", "50")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, string | undefined>) => {
      await loadCfg(); // warm up config (optional, events DB is global)

      const since = opts["since"] ? parseSinceDuration(opts["since"]) : undefined;
      const limit = parseInt(opts["limit"] ?? "50", 10);

      const results = queryActivityEvents({
        projectId: opts["project"],
        sessionId: opts["session"],
        kind: opts["type"] as ActivityEventKind,
        since,
        limit,
      });

      if (opts["json"]) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }

      if (results.length === 0) {
        console.log(chalk.dim("No events found."));
        return;
      }

      console.log(
        chalk.dim(
          `${"TIME".padEnd(10)}  ${"KIND".padEnd(22)}  ${"LEVEL".padEnd(9)}  ${"SESSION".padEnd(12)}  SUMMARY`,
        ),
      );
      for (const ev of results) {
        console.log(formatRow(ev));
      }
      console.log(chalk.dim(`\n${results.length} event(s)`));
    });

  events
    .command("search <query>")
    .description("Full-text search across event summaries and data")
    .option("-p, --project <id>", "Filter by project ID")
    .option("--json", "Output as JSON")
    .action(async (query: string, opts: Record<string, string | undefined>) => {
      const results = searchActivityEvents(query);
      const filtered = opts["project"]
        ? results.filter((e) => e.projectId === opts["project"])
        : results;

      if (opts["json"]) {
        console.log(JSON.stringify(filtered, null, 2));
        return;
      }

      if (filtered.length === 0) {
        console.log(chalk.dim("No events found."));
        return;
      }

      console.log(
        chalk.dim(
          `${"TIME".padEnd(10)}  ${"KIND".padEnd(22)}  ${"LEVEL".padEnd(9)}  ${"SESSION".padEnd(12)}  SUMMARY`,
        ),
      );
      for (const ev of filtered) {
        console.log(formatRow(ev));
      }
      console.log(chalk.dim(`\n${filtered.length} event(s)`));
    });

  events
    .command("stats")
    .description("Show event log statistics")
    .action(async () => {
      const stats = getActivityEventStats();
      if (!stats) {
        console.log(chalk.yellow("Event log unavailable (better-sqlite3 not loaded)."));
        return;
      }

      console.log(chalk.bold("Event Log Stats"));
      console.log(`  Total events:      ${stats.total}`);
      console.log(`  Dropped (process): ${stats.droppedThisProcess}`);
      if (stats.oldestTs) console.log(`  Oldest event:      ${stats.oldestTs}`);
      if (stats.newestTs) console.log(`  Newest event:      ${stats.newestTs}`);

      if (Object.keys(stats.byKind).length > 0) {
        console.log(chalk.bold("\nBy kind:"));
        for (const [kind, count] of Object.entries(stats.byKind).sort((a, b) => b[1] - a[1])) {
          console.log(`  ${kind.padEnd(30)} ${count}`);
        }
      }

      if (Object.keys(stats.bySource).length > 0) {
        console.log(chalk.bold("\nBy source:"));
        for (const [source, count] of Object.entries(stats.bySource).sort((a, b) => b[1] - a[1])) {
          console.log(`  ${source.padEnd(30)} ${count}`);
        }
      }
    });
}
