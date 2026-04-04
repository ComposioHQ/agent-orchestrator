import type { Command } from "commander";

/**
 * Kept for backward compatibility. The lifecycle manager now runs in-process
 * inside `ao start` and no longer needs a separate command. Any processes
 * spawned by older versions are safe to ignore; they will exit on their own
 * or can be cleaned up with `pkill -f "ao lifecycle-worker"`.
 */
export function registerLifecycleWorker(program: Command): void {
  program
    .command("lifecycle-worker [project]")
    .description("(Deprecated) Lifecycle worker now runs in-process inside `ao start`")
    .action(() => {
      console.log("The lifecycle worker now runs in-process inside `ao start`.");
      console.log("This command is no longer needed and has no effect.");
    });
}
