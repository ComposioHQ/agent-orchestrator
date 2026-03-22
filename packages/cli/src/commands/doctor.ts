import type { Command } from "commander";
import { executeScriptCommand } from "../lib/script-runner.js";

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("Run install, environment, and runtime health checks")
    .option("--fix", "Apply safe fixes for launcher and stale temp issues")
    .action(async (opts: { fix?: boolean }) => {
      const args: string[] = [];
      if (opts.fix) {
        args.push("--fix");
      }

      await executeScriptCommand("ao-doctor.sh", args);
    });
}
