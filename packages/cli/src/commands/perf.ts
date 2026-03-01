/**
 * `ao perf` — API performance analysis from request logs.
 *
 * Subcommands:
 *   ao perf              — overview of route performance
 *   ao perf routes       — per-route p50/p95/p99 stats
 *   ao perf slow         — slowest recent requests
 *   ao perf cache        — cache hit rates
 *   ao perf enrichment   — PR enrichment timing breakdown
 */

import chalk from "chalk";
import type { Command } from "commander";
import { percentile, computeApiStats } from "@composio/ao-core";
import { padCol, parseSinceArg, formatMs } from "../lib/format.js";
import { loadRequests, resolveLogDir, type ParsedRequest } from "../lib/perf-utils.js";

export function registerPerf(program: Command): void {
  const perfCmd = program
    .command("perf")
    .description("API performance analysis from request logs");

  perfCmd
    .command("routes")
    .description("Per-route p50/p95/p99 response time stats")
    .option("--since <time>", "Analyze requests since (e.g., 1h, 1d)")
    .option("--route <pattern>", "Filter by route pattern")
    .option("--json", "Output as JSON")
    .action((opts: { since?: string; route?: string; json?: boolean }) => {
      try {
        const logDir = resolveLogDir();
        const since = opts.since ? parseSinceArg(opts.since) : undefined;
        const requests = loadRequests(logDir, { since, route: opts.route });

        if (requests.length === 0) {
          if (opts.json) {
            console.log(JSON.stringify({}, null, 2));
          } else {
            console.log(chalk.dim("No API request logs found."));
          }
          return;
        }

        const { routes } = computeApiStats(requests);

        if (opts.json) {
          console.log(JSON.stringify(routes, null, 2));
          return;
        }

        // Table
        const COL = { route: 32, count: 7, p50: 8, p95: 8, p99: 8, errors: 7 };
        console.log(
          chalk.dim(
            "  " +
            padCol("Route", COL.route) +
            padCol("Count", COL.count) +
            padCol("p50", COL.p50) +
            padCol("p95", COL.p95) +
            padCol("p99", COL.p99) +
            "Errors",
          ),
        );
        console.log(chalk.dim("  " + "─".repeat(70)));

        const sorted = Object.entries(routes).sort((a, b) => b[1].p95Ms - a[1].p95Ms);

        for (const [route, stats] of sorted) {
          console.log(
            "  " +
            padCol(chalk.cyan(route), COL.route) +
            padCol(String(stats.count), COL.count) +
            padCol(formatMs(stats.p50Ms), COL.p50) +
            padCol(formatMs(stats.p95Ms), COL.p95) +
            padCol(formatMs(stats.p99Ms), COL.p99) +
            (stats.errors > 0 ? chalk.red(String(stats.errors)) : chalk.dim("0")),
          );
        }
        console.log(chalk.dim(`\n  ${requests.length} total requests`));
      } catch (err) {
        console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  perfCmd
    .command("slow")
    .description("Show slowest recent requests")
    .option("--limit <n>", "Number of requests to show", "10")
    .option("--since <time>", "Analyze requests since")
    .option("--json", "Output as JSON")
    .action((opts: { limit?: string; since?: string; json?: boolean }) => {
      try {
        const logDir = resolveLogDir();
        const since = opts.since ? parseSinceArg(opts.since) : undefined;
        const requests = loadRequests(logDir, { since });
        const limit = parseInt(opts.limit ?? "10", 10);

        const slowest = requests
          .sort((a, b) => b.durationMs - a.durationMs)
          .slice(0, limit);

        if (opts.json) {
          console.log(JSON.stringify(slowest, null, 2));
          return;
        }

        if (slowest.length === 0) {
          console.log(chalk.dim("No API request logs found."));
          return;
        }

        console.log(chalk.bold("\nSlowest Requests:\n"));
        for (const req of slowest) {
          const time = new Date(req.ts).toLocaleTimeString();
          const timingDetail = req.timings
            ? Object.entries(req.timings)
                .map(([k, v]) => `${k}: ${formatMs(v)}`)
                .join(", ")
            : "";
          console.log(
            `  ${chalk.yellow(formatMs(req.durationMs).padEnd(7))} ` +
            `${req.method} ${chalk.cyan(req.path)}  ` +
            chalk.dim(time),
          );
          if (timingDetail) {
            console.log(`           ${chalk.dim(`(${timingDetail})`)}`);
          }
        }
        console.log();
      } catch (err) {
        console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  perfCmd
    .command("cache")
    .description("Show cache hit rates")
    .option("--json", "Output as JSON")
    .action((opts: { json?: boolean }) => {
      try {
        const logDir = resolveLogDir();
        const requests = loadRequests(logDir);

        // Find the most recent cache stats from request logs
        let latestStats: ParsedRequest["cacheStats"] | undefined;
        for (let i = requests.length - 1; i >= 0; i--) {
          if (requests[i].cacheStats) {
            latestStats = requests[i].cacheStats;
            break;
          }
        }

        if (opts.json) {
          console.log(JSON.stringify(latestStats ?? {}, null, 2));
          return;
        }

        if (!latestStats) {
          console.log(chalk.dim("No cache stats available yet. Hit the dashboard a few times first."));
          return;
        }

        const rate = (latestStats.hitRate * 100).toFixed(1);
        console.log(chalk.bold("\nCache Statistics:\n"));
        console.log(`  Hit rate:   ${chalk.green(rate + "%")} (${latestStats.hits} hits / ${latestStats.misses} misses)`);
        console.log(`  Cache size: ${latestStats.size} entries`);
        console.log();
      } catch (err) {
        console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  perfCmd
    .command("enrichment")
    .description("PR enrichment timing breakdown")
    .option("--since <time>", "Analyze since")
    .option("--json", "Output as JSON")
    .action((opts: { since?: string; json?: boolean }) => {
      try {
        const logDir = resolveLogDir();
        const since = opts.since ? parseSinceArg(opts.since) : undefined;
        const requests = loadRequests(logDir, { since, route: "/api/sessions" });

        // Collect enrichment timings
        const enrichTimes: number[] = [];
        const listTimes: number[] = [];
        for (const req of requests) {
          if (req.timings?.["prEnrichment"]) enrichTimes.push(req.timings["prEnrichment"]);
          if (req.timings?.["sessionList"]) listTimes.push(req.timings["sessionList"]);
        }

        if (opts.json) {
          console.log(JSON.stringify({ enrichTimes, listTimes }, null, 2));
          return;
        }

        if (enrichTimes.length === 0) {
          console.log(chalk.dim("No enrichment timing data found. Hit the dashboard a few times first."));
          return;
        }

        enrichTimes.sort((a, b) => a - b);
        listTimes.sort((a, b) => a - b);

        console.log(chalk.bold("\nPR Enrichment Performance:\n"));
        console.log(`  Samples:    ${enrichTimes.length}`);
        console.log(`  p50:        ${formatMs(percentile(enrichTimes, 50))}`);
        console.log(`  p95:        ${formatMs(percentile(enrichTimes, 95))}`);
        console.log(`  p99:        ${formatMs(percentile(enrichTimes, 99))}`);

        if (listTimes.length > 0) {
          console.log(chalk.bold("\nSession List Performance:\n"));
          console.log(`  Samples:    ${listTimes.length}`);
          console.log(`  p50:        ${formatMs(percentile(listTimes, 50))}`);
          console.log(`  p95:        ${formatMs(percentile(listTimes, 95))}`);
        }
        console.log();
      } catch (err) {
        console.error(chalk.red("Error:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
