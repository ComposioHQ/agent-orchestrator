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
import { registerLogs } from "./commands/logs.js";
import { registerRetrospective } from "./commands/retrospective.js";
import { registerPerf } from "./commands/perf.js";

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
registerLogs(program);
registerRetrospective(program);
registerPerf(program);

program.parse();
