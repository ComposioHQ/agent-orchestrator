import chalk from "chalk";
import type { Command } from "commander";

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("[deprecated] Use 'ao start' instead — it auto-creates config on first run")
    .action(async () => {
      console.log(
        chalk.yellow(
          "⚠ 'ao init' is deprecated. Use 'ao start' instead.\n" +
            "  'ao start' auto-detects your project and creates the config.\n",
        ),
      );
      const { createConfigOnly } = await import("./start.js");
      await createConfigOnly();
    });
}
