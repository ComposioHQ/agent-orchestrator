import { Command } from "commander";
import { registerInit } from "./commands/init.js";
import { registerStatus } from "./commands/status.js";
import { registerSpawn, registerBatchSpawn } from "./commands/spawn.js";
import { registerSession } from "./commands/session.js";
import { registerSend } from "./commands/send.js";
import { registerReviewCheck } from "./commands/review-check.js";
import { registerDashboard } from "./commands/dashboard.js";
import { registerOpen } from "./commands/open.js";
import { registerStart, registerStop } from "./commands/start.js";
import { registerVerify } from "./commands/verify.js";
import { registerDoctor } from "./commands/doctor.js";
import { registerUpdate } from "./commands/update.js";
import { registerSetup } from "./commands/setup.js";
import { registerPlugin } from "./commands/plugin.js";
import { registerProjectCommand } from "./commands/project.js";
import { getConfigInstruction } from "./lib/config-instruction.js";
import { getCliVersion } from "./options/version.js";

export function createProgram(): Command {
  const program = new Command();

  program
    .name("ao")
    .description("Agent Orchestrator — manage parallel AI coding agents")
    .version(getCliVersion());

  registerInit(program);
  registerStart(program);
  registerStop(program);
  registerStatus(program);
  registerSpawn(program);
  registerBatchSpawn(program);
  registerSession(program);
  registerSend(program);
  registerReviewCheck(program);
  registerDashboard(program);
  registerOpen(program);
  registerProjectCommand(program);
  registerVerify(program);
  registerDoctor(program);
  registerUpdate(program);
  registerSetup(program);
  registerPlugin(program);

  // Deprecated: lifecycle-worker was removed in multi-project mode.
  // Keep a stub so scripts/completions referencing `ao lifecycle-worker`
  // get a clear deprecation message instead of an unknown-command error.
  program
    .command("lifecycle-worker")
    .description("[deprecated] This command has been removed. Use `ao start` instead.")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .action(() => {
      console.error(
        "[deprecated] `ao lifecycle-worker` has been removed. " +
          "The lifecycle worker is now started automatically by `ao start`.",
      );
      process.exit(1);
    });

  program
    .command("config-help")
    .description("Show config schema and guide for creating agent-orchestrator.yaml")
    .action(() => {
      console.log(getConfigInstruction());
    });

  return program;
}
