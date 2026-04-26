import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import {
  type OpenCodeSessionManager,
  type Session,
  loadConfig,
} from "@aoagents/ao-core";
import { exec, tmux } from "../lib/shell.js";
import { getSessionManager } from "../lib/create-session-manager.js";

/**
 * Resolve session context: tmux target name and session data.
 * Loads config and looks up the session once, avoiding duplicate work.
 */
async function resolveSessionContext(sessionName: string): Promise<{
  tmuxTarget: string;
  runtimeName?: string;
  session: Session | null;
  sessionManager: OpenCodeSessionManager | null;
}> {
  try {
    const config = loadConfig();
    const sm = await getSessionManager(config);
    const session = await sm.get(sessionName);
    if (session) {
      const tmuxTarget = session.runtimeHandle?.id ?? sessionName;
      const project = config.projects[session.projectId];
      const runtimeName =
        session.runtimeHandle?.runtimeName ?? project?.runtime ?? config.defaults.runtime;
      return {
        tmuxTarget,
        runtimeName,
        session,
        sessionManager: sm,
      };
    }
  } catch {
    // No config or session not found — fall back to defaults
  }
  return {
    tmuxTarget: sessionName,
    runtimeName: "tmux",
    session: null,
    sessionManager: null,
  };
}

function hasQueuedMessage(terminalOutput: string): boolean {
  return terminalOutput.includes("Press up to edit queued messages");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readMessageInput(opts: { file?: string }, messageParts: string[]): Promise<string> {
  const inlineMessage = messageParts.join(" ");
  if (!opts.file && !inlineMessage) {
    console.error(chalk.red("No message provided"));
    process.exit(1);
  }

  if (!opts.file) {
    return inlineMessage;
  }

  try {
    return readFileSync(opts.file, "utf-8");
  } catch (err) {
    console.error(chalk.red(`Cannot read file: ${opts.file} (${err})`));
    process.exit(1);
  }
}

async function sendViaTmux(tmuxTarget: string, message: string): Promise<void> {
  await exec("tmux", ["send-keys", "-t", tmuxTarget, "C-u"]);
  await sleep(200);

  if (message.includes("\n") || message.length > 200) {
    const tmpFile = join(tmpdir(), `ao-send-${Date.now()}.txt`);
    writeFileSync(tmpFile, message);
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
    await exec("tmux", ["send-keys", "-t", tmuxTarget, "-l", message]);
  }

  await sleep(300);
  await exec("tmux", ["send-keys", "-t", tmuxTarget, "Enter"]);
}

export function registerSend(program: Command): void {
  program
    .command("send")
    .description("Send a message to a session with busy detection and retry")
    .argument("<session>", "Session name")
    .argument("[message...]", "Message to send")
    .option("-f, --file <path>", "Send contents of a file instead")
    .action(
      async (session: string, messageParts: string[], opts: { file?: string }) => {
        // Resolve session context once: tmux target, session data
        const {
          tmuxTarget,
          runtimeName,
          session: existingSession,
          sessionManager,
        } = await resolveSessionContext(session);

        const message = await readMessageInput(opts, messageParts);

        const canUseTmux = runtimeName === "tmux";

        if (!existingSession) {
          const exists = await tmux("has-session", "-t", tmuxTarget);
          if (exists === null) {
            console.error(chalk.red(`Session '${session}' does not exist`));
            process.exit(1);
          }
        }

        // Helper to capture output from the resolved tmux target
        async function captureOutput(lines: number): Promise<string> {
          if (!canUseTmux) return "";
          const output = await tmux("capture-pane", "-t", tmuxTarget, "-p", "-S", String(-lines));
          return output || "";
        }

        const delegatesToSessionManager = Boolean(existingSession && sessionManager);

        if (!canUseTmux && !delegatesToSessionManager) {
          console.error(
            chalk.red(
              `Session '${session}' is not tmux-backed and cannot be sent without lifecycle routing`,
            ),
          );
          process.exit(1);
        }

        if (existingSession && sessionManager) {
          try {
            await sessionManager.send(session, message);
            console.log(chalk.green("Message sent and processing"));
          } catch (err) {
            console.error(chalk.red(err instanceof Error ? err.message : String(err)));
            process.exit(1);
          }
          return;
        }

        const baselineOutput = await captureOutput(10);
        await sendViaTmux(tmuxTarget, message);

        // Verify delivery with retries — look for output change or queued marker.
        for (let attempt = 1; attempt <= 3; attempt++) {
          await sleep(2000);
          const output = await captureOutput(10);
          if (hasQueuedMessage(output)) {
            console.log(chalk.green("Message queued (session finishing previous task)"));
            return;
          }
          if (output.length > 0 && output !== baselineOutput) {
            console.log(chalk.green("Message sent and processing"));
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
