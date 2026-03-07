#!/usr/bin/env node
/**
 * ao-bus-cli — Command-line interface for the agent toolkit.
 *
 * Agents call this binary as simple commands. It handles serialization,
 * validation, atomic writes, path encoding, locking, and sequencing.
 *
 * Usage:
 *   ao-bus-cli status done
 *   ao-bus-cli status working --file src/auth.ts
 *   ao-bus-cli msg reviewer "ready for review"
 *   ao-bus-cli inbox
 *   ao-bus-cli context
 *   ao-bus-cli lock src/auth.ts
 *   ao-bus-cli unlock src/auth.ts
 *   ao-bus-cli artifact write review-report.md
 *   ao-bus-cli artifact read test-results.json
 *   ao-bus-cli plan init "summary"
 *   ao-bus-cli plan add-unit --id wu-1 ...
 *   ao-bus-cli plan finalize
 *   ao-bus-cli learn convention "description"
 *   ao-bus-cli refine add convention "description"
 *
 * Environment variables (set by bootstrap.sh):
 *   AO_AGENT_NAME  - current agent name
 *   AO_PHASE       - current phase
 *   AO_WORKTREE    - worktree path
 *   AO_AGENTS_DIR  - .agents/ directory path
 *   AO_FILE_SCOPE  - comma-separated assigned files
 *   AO_SHARED_FILES - comma-separated shared files
 *
 * CLI flags --agent and --phase override env vars (for fallback path).
 */

import { AgentBus, createLearningEntry } from "./agent-bus.js";
import type { Phase, LearningCategory, MessageType, MessagePriority, Plan, WorkUnit } from "@composio/ao-core";

function getAgentsDir(args: string[]): string {
  const flagIdx = args.indexOf("--agents-dir");
  if (flagIdx !== -1 && args[flagIdx + 1]) {
    return args[flagIdx + 1];
  }
  return process.env["AO_AGENTS_DIR"] ?? `${process.cwd()}/.agents`;
}

function getAgentName(args: string[]): string {
  const flagIdx = args.indexOf("--agent");
  if (flagIdx !== -1 && args[flagIdx + 1]) {
    return args[flagIdx + 1];
  }
  return process.env["AO_AGENT_NAME"] ?? "unknown";
}

function getPhase(args: string[]): Phase {
  const flagIdx = args.indexOf("--phase");
  if (flagIdx !== -1 && args[flagIdx + 1]) {
    return args[flagIdx + 1] as Phase;
  }
  return (process.env["AO_PHASE"] ?? "implement") as Phase;
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1];
  }
  return undefined;
}

function main(): void {
  const args = process.argv.slice(2);
  const command = args[0];
  const subcommand = args[1];

  const bus = new AgentBus({ agentsDir: getAgentsDir(args) });
  const agentName = getAgentName(args);
  const phase = getPhase(args);

  switch (command) {
    case "status": {
      handleStatus(bus, agentName, phase, subcommand, args);
      break;
    }
    case "msg": {
      handleMsg(bus, agentName, phase, args);
      break;
    }
    case "inbox": {
      handleInbox(bus, agentName, args);
      break;
    }
    case "context": {
      handleContext(bus, args);
      break;
    }
    case "lock": {
      handleLock(bus, subcommand);
      break;
    }
    case "unlock": {
      handleUnlock(bus, subcommand);
      break;
    }
    case "artifact": {
      handleArtifact(bus, subcommand, args);
      break;
    }
    case "plan": {
      handlePlan(bus, subcommand, args);
      break;
    }
    case "learn": {
      handleLearn(bus, agentName, phase, subcommand, args);
      break;
    }
    case "refine": {
      handleRefine(bus, subcommand, args);
      break;
    }
    default: {
      console.error(`Unknown command: ${command}`);
      console.error("Usage: ao-bus-cli <command> [options]");
      console.error("Commands: status, msg, inbox, context, lock, unlock, artifact, plan, learn, refine");
      process.exit(1);
    }
  }
}

function handleStatus(
  bus: AgentBus,
  agentName: string,
  phase: Phase,
  subcommand: string | undefined,
  args: string[],
): void {
  switch (subcommand) {
    case "done": {
      bus.setDone(agentName);
      console.log(`Status: ${agentName} -> done`);
      break;
    }
    case "working": {
      const file = getFlag(args, "--file");
      bus.setWorking(agentName, file);
      console.log(`Status: ${agentName} -> working${file ? ` on ${file}` : ""}`);
      break;
    }
    default: {
      // Show current status
      const status = bus.readStatus(agentName);
      if (status) {
        console.log(JSON.stringify(status, null, 2));
      } else {
        console.error(`No status found for agent: ${agentName}`);
        process.exit(1);
      }
    }
  }
}

function handleMsg(bus: AgentBus, agentName: string, phase: Phase, args: string[]): void {
  const to = args[1];
  const content = args[2];

  if (!to || !content) {
    console.error("Usage: ao-bus-cli msg <to> <content> [--type <type>] [--priority <priority>]");
    process.exit(1);
  }

  const type = (getFlag(args, "--type") ?? "system") as MessageType;
  const priority = getFlag(args, "--priority") as MessagePriority | undefined;

  const msg = bus.sendMessage(agentName, to, phase, content, { type, priority });
  console.log(`Message sent: seq=${msg.seq} from=${agentName} to=${to}`);
}

function handleInbox(bus: AgentBus, agentName: string, args: string[]): void {
  const from = getFlag(args, "--from");
  const sinceStr = getFlag(args, "--since");
  const since = sinceStr ? parseInt(sinceStr, 10) : undefined;

  const messages = bus.readMessagesFor(agentName, { from, since });

  if (messages.length === 0) {
    console.log("No messages.");
    return;
  }

  for (const msg of messages) {
    console.log(`[${msg.seq}] ${msg.from} -> ${msg.to} (${msg.type}): ${msg.content}`);
  }
}

function handleContext(_bus: AgentBus, args: string[]): void {
  const subFlag = args[1];

  const ctx = {
    agentName: getAgentName(args),
    phase: getPhase(args),
    worktree: process.env["AO_WORKTREE"] ?? process.cwd(),
    fileScope: (process.env["AO_FILE_SCOPE"] ?? "").split(",").filter(Boolean),
    sharedFiles: (process.env["AO_SHARED_FILES"] ?? "").split(",").filter(Boolean),
  };

  switch (subFlag) {
    case "--files":
      console.log(ctx.fileScope.join("\n"));
      break;
    case "--shared":
      console.log(ctx.sharedFiles.join("\n"));
      break;
    case "--criteria": {
      // Read plan and find criteria for this agent
      const bus = new AgentBus({ agentsDir: getAgentsDir(args) });
      const plan = bus.readPlan();
      if (plan) {
        const units = plan.workUnits.filter((wu) => wu.assignedTo === ctx.agentName);
        for (const wu of units) {
          console.log(`[${wu.id}] ${wu.criteria}`);
        }
      } else {
        console.log("No plan found.");
      }
      break;
    }
    default:
      console.log(JSON.stringify(ctx, null, 2));
  }
}

function handleLock(bus: AgentBus, filePath: string | undefined): void {
  if (!filePath) {
    console.error("Usage: ao-bus-cli lock <file-path>");
    process.exit(1);
  }

  const acquired = bus.acquireLock(filePath);
  if (acquired) {
    console.log(`Lock acquired: ${filePath}`);
  } else {
    console.error(`Lock already held: ${filePath}`);
    process.exit(1);
  }
}

function handleUnlock(bus: AgentBus, filePath: string | undefined): void {
  if (!filePath) {
    console.error("Usage: ao-bus-cli unlock <file-path>");
    process.exit(1);
  }

  bus.releaseLock(filePath);
  console.log(`Lock released: ${filePath}`);
}

function handleArtifact(bus: AgentBus, subcommand: string | undefined, args: string[]): void {
  const name = args[2];

  if (!subcommand || !name) {
    console.error("Usage: ao-bus-cli artifact <write|read> <name>");
    process.exit(1);
  }

  switch (subcommand) {
    case "write": {
      // Read from stdin
      const chunks: Buffer[] = [];
      process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
      process.stdin.on("end", () => {
        const content = Buffer.concat(chunks).toString("utf-8");
        bus.writeArtifact(name, content);
        console.log(`Artifact written: ${name}`);
      });
      break;
    }
    case "read": {
      const content = bus.readArtifact(name);
      if (content !== null) {
        process.stdout.write(content);
      } else {
        console.error(`Artifact not found: ${name}`);
        process.exit(1);
      }
      break;
    }
    default:
      console.error("Usage: ao-bus-cli artifact <write|read> <name>");
      process.exit(1);
  }
}

function handlePlan(bus: AgentBus, subcommand: string | undefined, args: string[]): void {
  switch (subcommand) {
    case "init": {
      const summary = args[2];
      if (!summary) {
        console.error("Usage: ao-bus-cli plan init <summary>");
        process.exit(1);
      }
      const plan: Plan = {
        summary,
        workUnits: [],
        sharedFiles: [],
        integrateOrder: [],
      };
      bus.writePlan(plan);
      console.log("Plan initialized.");
      break;
    }
    case "add-unit": {
      const plan = bus.readPlan();
      if (!plan) {
        console.error("No plan initialized. Run: ao-bus-cli plan init <summary>");
        process.exit(1);
      }

      const id = getFlag(args, "--id");
      const desc = getFlag(args, "--desc");
      const assignedTo = getFlag(args, "--assigned-to");
      const filesStr = getFlag(args, "--files");
      const criteria = getFlag(args, "--criteria");
      const sharedReadsStr = getFlag(args, "--shared-reads");

      if (!id || !desc || !assignedTo || !filesStr || !criteria) {
        console.error(
          "Usage: ao-bus-cli plan add-unit --id <id> --desc <desc> --assigned-to <agent> --files <f1,f2> --criteria <criteria>",
        );
        process.exit(1);
      }

      const unit: WorkUnit = {
        id,
        description: desc,
        assignedTo,
        files: filesStr.split(","),
        criteria,
        sharedReads: sharedReadsStr ? sharedReadsStr.split(",") : undefined,
      };

      plan.workUnits.push(unit);
      bus.writePlan(plan);
      console.log(`Work unit added: ${id}`);
      break;
    }
    case "shared-files": {
      const plan = bus.readPlan();
      if (!plan) {
        console.error("No plan initialized.");
        process.exit(1);
      }

      const files = args.slice(2).filter((a) => !a.startsWith("--"));
      plan.sharedFiles.push(...files);
      bus.writePlan(plan);
      console.log(`Shared files added: ${files.join(", ")}`);
      break;
    }
    case "finalize": {
      const plan = bus.readPlan();
      if (!plan) {
        console.error("No plan initialized.");
        process.exit(1);
      }

      // Build integrate order from work units
      const agents = [...new Set(plan.workUnits.map((wu) => wu.assignedTo))];
      plan.integrateOrder = agents;
      bus.writePlan(plan);
      console.log("Plan finalized.");
      console.log(JSON.stringify(plan, null, 2));
      break;
    }
    case "show": {
      const plan = bus.readPlan();
      if (plan) {
        console.log(JSON.stringify(plan, null, 2));
      } else {
        console.log("No plan found.");
      }
      break;
    }
    default:
      console.error("Usage: ao-bus-cli plan <init|add-unit|shared-files|finalize|show>");
      process.exit(1);
  }
}

function handleLearn(
  bus: AgentBus,
  agentName: string,
  phase: Phase,
  category: string | undefined,
  args: string[],
): void {
  const description = args[2];

  if (!category || !description) {
    console.error("Usage: ao-bus-cli learn <convention|pitfall|decision> <description>");
    process.exit(1);
  }

  const validCategories = ["convention", "pitfall", "decision"];
  if (!validCategories.includes(category)) {
    console.error(`Invalid category: ${category}. Must be one of: ${validCategories.join(", ")}`);
    process.exit(1);
  }

  const entry = createLearningEntry(category as LearningCategory, description, agentName, phase);
  bus.bufferLearning(entry);
  console.log(`Learning buffered: [${category}] ${description}`);
}

function handleRefine(bus: AgentBus, action: string | undefined, args: string[]): void {
  const category = args[2];
  const description = args[3];

  if (!action || !category || !description) {
    console.error("Usage: ao-bus-cli refine <add|remove|update|confirm> <category> <description>");
    process.exit(1);
  }

  const reason = getFlag(args, "--reason");
  const append = getFlag(args, "--append");

  // Write refine command to artifacts
  const refineCmd = {
    action,
    category,
    description,
    reason,
    append,
    ts: new Date().toISOString(),
  };

  const bufferPath = "refine-commands.jsonl";
  const existing = bus.readArtifact(bufferPath) ?? "";
  bus.writeArtifact(bufferPath, existing + JSON.stringify(refineCmd) + "\n");
  console.log(`Refine command queued: ${action} ${category} "${description}"`);
}

main();
