import type { Command } from "commander";

export function registerPing(program: Command): void {
  program
    .command("ping")
    .description("Print the word ping")
    .action(() => {
      console.log("ping");
    });
}
