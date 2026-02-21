/**
 * `ao lifecycle` command — manage lifecycle polling and reactions.
 *
 * Subcommands:
 *   start  — run lifecycle polling loop in foreground
 *   check  — run a single check for one session
 */

import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig, createLifecycleManager } from "@composio/ao-core";
import { getSessionManager, getRegistry } from "../lib/create-session-manager.js";

export function registerLifecycle(program: Command): void {
  const lifecycle = program
    .command("lifecycle")
    .description("Manage lifecycle polling and reactions");

  lifecycle
    .command("start")
    .description("Start lifecycle polling loop (runs in foreground)")
    .option("-i, --interval <ms>", "Polling interval in milliseconds", "30000")
    .action(async (opts: { interval: string }) => {
      const config = loadConfig();
      const intervalMs = parseInt(opts.interval, 10);

      if (isNaN(intervalMs) || intervalMs < 1000) {
        console.error(chalk.red("Invalid interval. Must be >= 1000ms"));
        process.exit(1);
      }

      const registry = await getRegistry(config);
      const sessionManager = await getSessionManager(config);
      const lifecycleManager = createLifecycleManager({
        config,
        registry,
        sessionManager,
      });

      console.log(chalk.bold(`Starting lifecycle polling (interval: ${intervalMs}ms)\n`));
      console.log(chalk.dim("Press Ctrl-C to stop\n"));

      lifecycleManager.start(intervalMs);

      process.on("SIGINT", () => {
        console.log(chalk.yellow("\nStopping lifecycle manager..."));
        lifecycleManager.stop();
        process.exit(0);
      });
    });

  lifecycle
    .command("check")
    .description("Run a single lifecycle check for a session")
    .argument("<sessionId>", "Session ID to check")
    .action(async (sessionId: string) => {
      const config = loadConfig();
      const registry = await getRegistry(config);
      const sessionManager = await getSessionManager(config);
      const lifecycleManager = createLifecycleManager({
        config,
        registry,
        sessionManager,
      });

      await lifecycleManager.check(sessionId);
      console.log(chalk.green(`Done: checked session ${sessionId}`));
    });
}
