import type { Command } from "commander";

export function registerHello(program: Command): void {
  program
    .command("hello")
    .description("Print hello world")
    .action(() => {
      console.log("hello world");
    });
}
