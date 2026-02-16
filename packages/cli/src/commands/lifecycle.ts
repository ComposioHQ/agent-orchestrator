import chalk from "chalk";
import type { Command } from "commander";
import {
  loadConfig,
  createPluginRegistry,
  createSessionManager,
  createLifecycleManager,
} from "@composio/ao-core";

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

      const registry = createPluginRegistry();
      await registry.loadBuiltins(config);

      const sessionManager = createSessionManager({ config, registry });
      const lifecycleManager = createLifecycleManager({
        config,
        registry,
        sessionManager,
      });

      console.log(
        chalk.bold(`Starting lifecycle polling (interval: ${intervalMs}ms)\n`),
      );
      console.log(chalk.dim("Press Ctrl-C to stop\n"));

      lifecycleManager.start(intervalMs);

      process.on("SIGINT", () => {
        console.log(chalk.yellow("\nStopping lifecycle manager..."));
        lifecycleManager.stop();
        process.exit(0);
      });

      process.on("SIGTERM", () => {
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
      const registry = createPluginRegistry();
      await registry.loadBuiltins(config);

      const sessionManager = createSessionManager({ config, registry });
      const lifecycleManager = createLifecycleManager({
        config,
        registry,
        sessionManager,
      });

      try {
        await lifecycleManager.check(sessionId);
        console.log(chalk.green(`✓ Checked session ${sessionId}`));
      } catch (err) {
        console.error(
          chalk.red(
            `Failed to check session: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        process.exit(1);
      }
    });
}
