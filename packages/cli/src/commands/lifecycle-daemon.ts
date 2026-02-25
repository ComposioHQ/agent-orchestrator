/**
 * `ao lifecycle-daemon` — standalone entry-point for the lifecycle manager.
 *
 * Designed to be run by systemd as a long-lived process.
 * Polls all sessions periodically, detects state transitions,
 * triggers reactions & notifications.
 */

import type { Command } from "commander";
import {
  loadConfig,
  createSessionManager,
  createLifecycleManager,
} from "@composio/ao-core";
import { getRegistry } from "../lib/create-session-manager.js";

export function registerLifecycleDaemon(program: Command): void {
  program
    .command("lifecycle-daemon")
    .description("Run the lifecycle manager as a long-lived daemon (used by systemd)")
    .option("--interval <ms>", "Poll interval in milliseconds", "30000")
    .action(async (opts: { interval: string }) => {
      const intervalMs = parseInt(opts.interval, 10) || 30_000;

      const config = loadConfig();
      const registry = await getRegistry(config);
      const sm = createSessionManager({ config, registry });
      const lm = createLifecycleManager({ config, registry, sessionManager: sm });

      lm.start(intervalMs);
      console.log(`Lifecycle daemon started (poll interval: ${intervalMs}ms)`);

      const shutdown = () => {
        console.log("Lifecycle daemon stopping…");
        lm.stop();
        process.exit(0);
      };

      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
    });
}
