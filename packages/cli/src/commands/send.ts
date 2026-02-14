import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { type Agent, loadConfig } from "@agent-orchestrator/core";
import { exec, tmux } from "../lib/shell.js";
import { getAgent, getAgentByName } from "../lib/plugins.js";
import { findProjectForSession } from "../lib/session-utils.js";

async function sessionExists(session: string): Promise<boolean> {
  const result = await tmux("has-session", "-t", session);
  return result !== null;
}

async function captureOutput(session: string, lines: number): Promise<string> {
  const output = await tmux("capture-pane", "-t", session, "-p", "-S", String(-lines));
  return output || "";
}

function isActive(agent: Agent, terminalOutput: string): boolean {
  return agent.detectActivity(terminalOutput) === "active";
}

function hasQueuedMessage(terminalOutput: string): boolean {
  return terminalOutput.includes("Press up to edit queued messages");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveAgent(sessionName: string): Agent {
  try {
    const config = loadConfig();
    const projectId = findProjectForSession(config, sessionName);
    if (projectId) {
      return getAgent(config, projectId);
    }
  } catch {
    // No config or project — fall back to default
  }
  return getAgentByName("claude-code");
}

export function registerSend(program: Command): void {
  program
    .command("send")
    .description("Send a message to a session with busy detection and retry")
    .argument("<session>", "Session name")
    .argument("[message...]", "Message to send")
    .option("-f, --file <path>", "Send contents of a file instead")
    .option("--no-wait", "Don't wait for session to become idle before sending")
    .option("--timeout <seconds>", "Max seconds to wait for idle", "600")
    .action(
      async (
        session: string,
        messageParts: string[],
        opts: { file?: string; wait?: boolean; timeout?: string },
      ) => {
        if (!(await sessionExists(session))) {
          console.error(chalk.red(`Session '${session}' does not exist`));
          process.exit(1);
        }

        const agent = resolveAgent(session);

        const parsedTimeout = parseInt(opts.timeout || "600", 10);
        const timeoutMs = (isNaN(parsedTimeout) || parsedTimeout <= 0 ? 600 : parsedTimeout) * 1000;

        // Wait for idle
        if (opts.wait !== false) {
          const start = Date.now();
          let warned = false;
          while (isActive(agent, await captureOutput(session, 5))) {
            if (!warned) {
              console.log(chalk.dim(`Waiting for ${session} to become idle...`));
              warned = true;
            }
            if (Date.now() - start > timeoutMs) {
              console.log(chalk.yellow("Timeout waiting for idle. Sending anyway."));
              break;
            }
            await sleep(5000);
          }
        }

        // Clear partial input (tmux interprets "C-u" as Ctrl-U, which clears the line)
        await exec("tmux", ["send-keys", "-t", session, "C-u"]);
        await sleep(200);

        // Send the message
        if (opts.file) {
          const content = readFileSync(opts.file, "utf-8");
          const tmpFile = join(tmpdir(), `ao-send-${Date.now()}.txt`);
          writeFileSync(tmpFile, content);
          try {
            await exec("tmux", ["load-buffer", tmpFile]);
            await exec("tmux", ["paste-buffer", "-t", session]);
          } finally {
            try {
              unlinkSync(tmpFile);
            } catch {
              // ignore cleanup failure
            }
          }
        } else {
          const msg = messageParts.join(" ");
          if (!msg) {
            console.error(chalk.red("No message provided"));
            process.exit(1);
          }
          if (msg.includes("\n") || msg.length > 200) {
            const tmpFile = join(tmpdir(), `ao-send-${Date.now()}.txt`);
            writeFileSync(tmpFile, msg);
            try {
              await exec("tmux", ["load-buffer", tmpFile]);
              await exec("tmux", ["paste-buffer", "-t", session]);
            } finally {
              try {
                unlinkSync(tmpFile);
              } catch {
                // ignore cleanup failure
              }
            }
          } else {
            await exec("tmux", ["send-keys", "-t", session, "-l", msg]);
          }
        }

        await sleep(300);
        await exec("tmux", ["send-keys", "-t", session, "Enter"]);

        // Verify delivery with retries
        for (let attempt = 1; attempt <= 3; attempt++) {
          await sleep(2000);
          const output = await captureOutput(session, 10);
          if (isActive(agent, output)) {
            console.log(chalk.green("Message sent and processing"));
            return;
          }
          if (hasQueuedMessage(output)) {
            console.log(chalk.green("Message queued (session finishing previous task)"));
            return;
          }
          if (attempt < 3) {
            await tmux("send-keys", "-t", session, "Enter");
            await sleep(1000);
          }
        }

        console.log(chalk.yellow("Message sent — could not confirm it was received"));
      },
    );
}
