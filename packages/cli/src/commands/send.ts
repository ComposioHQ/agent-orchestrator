import { readFileSync } from "node:fs";
import chalk from "chalk";
import type { Command } from "commander";
import {
  type OpenCodeSessionManager,
  type Session,
  loadConfig,
} from "@aoagents/ao-core";
import { tmux } from "../lib/shell.js";
import { getSessionManager } from "../lib/create-session-manager.js";

interface SessionContext {
  tmuxTarget: string;
  session: Session | null;
  sessionManager: OpenCodeSessionManager | null;
}

async function resolveSessionContext(sessionName: string): Promise<SessionContext> {
  try {
    const config = loadConfig();
    const sm = await getSessionManager(config);
    const session = await sm.get(sessionName);
    if (session) {
      return {
        tmuxTarget: session.runtimeHandle?.id ?? sessionName,
        session,
        sessionManager: sm,
      };
    }
  } catch {
    // No config or session not found — fall back below.
  }
  return { tmuxTarget: sessionName, session: null, sessionManager: null };
}

async function readMessageInput(opts: { file?: string }, messageParts: string[]): Promise<string> {
  const inlineMessage = messageParts.join(" ");
  if (!opts.file && !inlineMessage) {
    console.error(chalk.red("No message provided"));
    process.exit(1);
  }

  if (!opts.file) return inlineMessage;

  try {
    return readFileSync(opts.file, "utf-8");
  } catch (err) {
    console.error(chalk.red(`Cannot read file: ${opts.file} (${err})`));
    process.exit(1);
  }
}

export function registerSend(program: Command): void {
  program
    .command("send")
    .description("Send a message to a session via the file-based protocol")
    .argument("<session>", "Session name")
    .argument("[message...]", "Message to send")
    .option("-f, --file <path>", "Send contents of a file instead")
    .action(
      async (
        session: string,
        messageParts: string[],
        opts: { file?: string },
      ) => {
        const { tmuxTarget, session: existingSession, sessionManager } =
          await resolveSessionContext(session);

        const message = await readMessageInput(opts, messageParts);

        if (existingSession && sessionManager) {
          await sessionManager.send(session, message);
          console.log(chalk.green("Message sent and processing"));
          return;
        }

        const exists = await tmux("has-session", "-t", tmuxTarget);
        if (exists === null) {
          console.error(chalk.red(`Session '${session}' does not exist`));
          process.exit(1);
        }

        console.error(
          chalk.red(
            `Session '${session}' exists as a tmux session but no session manager is available.\n` +
              `Run 'ao send' from a directory with an agent-orchestrator.yaml config file.`,
          ),
        );
        process.exit(1);
      },
    );
}
