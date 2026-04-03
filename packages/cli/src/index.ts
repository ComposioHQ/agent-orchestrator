#!/usr/bin/env node

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

const program = new Command();

program
  .name("ao")
  .description("Agent Orchestrator — manage parallel AI coding agents")
  .version("0.1.0");

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
registerVerify(program);
registerDoctor(program);
registerUpdate(program);
registerSetup(program);
registerPlugin(program);
registerProjectCommand(program);

// Kept for backward compatibility — the lifecycle worker now runs in-process
// inside `ao start` and no longer needs a separate command. Any processes
// spawned by older versions of this command are safe to ignore; they will
// exit on their own or can be cleaned up with `pkill -f "ao lifecycle-worker"`.
program
  .command("lifecycle-worker [project]")
  .description("(Deprecated) Lifecycle worker now runs in-process inside `ao start`")
  .action(() => {
    console.log("The lifecycle worker now runs in-process inside `ao start`.");
    console.log("This command is no longer needed and has no effect.");
  });

program
  .command("config-help")
  .description("Show config schema and guide for creating agent-orchestrator.yaml")
  .action(() => {
    console.log(getConfigInstruction());
  });

program.parse();
