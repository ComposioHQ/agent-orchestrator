import type { Command } from "commander";
import { executeScriptCommand } from "../lib/script-runner.js";

export function registerUpdate(program: Command): void {
  program
    .command("update")
    .description(
      "Fast-forward the local install repo, rebuild critical packages, and run smoke tests",
    )
    .option("--skip-smoke", "Skip smoke tests after rebuilding")
    .option("--smoke-only", "Run smoke tests without fetching or rebuilding")
    .action(async (opts: { skipSmoke?: boolean; smokeOnly?: boolean }) => {
      const args: string[] = [];
      if (opts.skipSmoke) {
        args.push("--skip-smoke");
      }
      if (opts.smokeOnly) {
        args.push("--smoke-only");
      }

      await executeScriptCommand("ao-update.sh", args);
    });
}
