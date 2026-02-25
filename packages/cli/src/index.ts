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
import { registerCheckIssues } from "./commands/check-issues.js";
import { registerSelfUpdate } from "./commands/self-update.js";
import { registerSetupSystemd } from "./commands/setup-systemd.js";
import { registerLifecycleDaemon } from "./commands/lifecycle-daemon.js";

const program = new Command();

program
  .name("ao")
  .description("Agent Orchestrator — manage parallel AI coding agents")
  .version("0.1.0");

registerInit(program);
registerStart(program);
registerStop(program);
registerCheckIssues(program);
registerStatus(program);
registerSpawn(program);
registerBatchSpawn(program);
registerSession(program);
registerSend(program);
registerReviewCheck(program);
registerDashboard(program);
registerOpen(program);
registerSelfUpdate(program);
registerSetupSystemd(program);
registerLifecycleDaemon(program);

program.parse();
