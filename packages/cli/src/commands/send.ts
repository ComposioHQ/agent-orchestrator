import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { type Agent, type Session, loadConfig } from "@composio/ao-core";
import { exec, tmux } from "../lib/shell.js";
import { getAgentByName } from "../lib/plugins.js";
import { getSessionManager } from "../lib/create-session-manager.js";

/**
 * Resolve session context: tmux target name and Agent plugin.
 * Loads config and looks up the session once, avoiding duplicate work.
 */
async function resolveSessionContext(
  sessionName: string,
): Promise<{ tmuxTarget: string; agent: Agent; session: Session | null }> {
  try {
    const config = loadConfig();
    const sm = await getSessionManager(config);
    const session = await sm.get(sessionName);
    if (session) {
      const tmuxTarget = session.runtimeHandle?.id ?? sessionName;
      const project = config.projects[session.projectId];
      const agentName = project?.agent ?? config.defaults.agent;
      return { tmuxTarget, agent: getAgentByName(agentName), session };
    }
  } catch {
    // No config or session not found — fall back to defaults
  }
  return { tmuxTarget: sessionName, agent: getAgentByName("claude-code"), session: null };
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
        // Resolve session context once: tmux target, agent plugin, session data
        const { tmuxTarget, agent } = await resolveSessionContext(session);

        const exists = await tmux("has-session", "-t", tmuxTarget);
        if (exists === null) {
          console.error(chalk.red(`Session '${session}' does not exist`));
          process.exit(1);
        }

        // Validate message input before any side effects
        const msg = opts.file ? null : messageParts.join(" ");
        if (!opts.file && !msg) {
          console.error(chalk.red("No message provided"));
          process.exit(1);
        }

        const parsedTimeout = parseInt(opts.timeout || "600", 10);
        const timeoutMs = (isNaN(parsedTimeout) || parsedTimeout <= 0 ? 600 : parsedTimeout) * 1000;

        // Helper to capture output from the resolved tmux target
        async function captureOutput(lines: number): Promise<string> {
          const output = await tmux("capture-pane", "-t", tmuxTarget, "-p", "-S", String(-lines));
          return output || "";
        }

        // Wait for idle
        if (opts.wait !== false) {
          const start = Date.now();
          let warned = false;
          while (isActive(agent, await captureOutput(5))) {
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

        // Clear partial input
        await exec("tmux", ["send-keys", "-t", tmuxTarget, "C-u"]);
        await sleep(200);

        // Send the message
        if (opts.file) {
          let content: string;
          try {
            content = readFileSync(opts.file, "utf-8");
          } catch (err) {
            console.error(chalk.red(`Cannot read file: ${opts.file} (${err})`));
            process.exit(1);
          }
          const tmpFile = join(tmpdir(), `ao-send-${Date.now()}.txt`);
          writeFileSync(tmpFile, content);
          try {
            await exec("tmux", ["load-buffer", tmpFile]);
            await exec("tmux", ["paste-buffer", "-t", tmuxTarget]);
          } finally {
            try {
              unlinkSync(tmpFile);
            } catch {
              // ignore cleanup failure
            }
          }
        } else if (msg) {
          if (msg.includes("\n") || msg.length > 200) {
            const tmpFile = join(tmpdir(), `ao-send-${Date.now()}.txt`);
            writeFileSync(tmpFile, msg);
            try {
              await exec("tmux", ["load-buffer", tmpFile]);
              await exec("tmux", ["paste-buffer", "-t", tmuxTarget]);
            } finally {
              try {
                unlinkSync(tmpFile);
              } catch {
                // ignore cleanup failure
              }
            }
          } else {
            await exec("tmux", ["send-keys", "-t", tmuxTarget, "-l", msg]);
          }
        }

        await sleep(300);
        await exec("tmux", ["send-keys", "-t", tmuxTarget, "Enter"]);

        // Verify delivery with retries
        for (let attempt = 1; attempt <= 3; attempt++) {
          await sleep(2000);
          const output = await captureOutput(10);
          if (isActive(agent, output)) {
            console.log(chalk.green("Message sent and processing"));
            return;
          }
          if (hasQueuedMessage(output)) {
            console.log(chalk.green("Message queued (session finishing previous task)"));
            return;
          }
          if (attempt < 3) {
            await tmux("send-keys", "-t", tmuxTarget, "Enter");
            await sleep(1000);
          }
        }

        console.log(chalk.yellow("Message sent — could not confirm it was received"));
      },
    );
}
