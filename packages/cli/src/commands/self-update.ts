/**
 * `ao self-update` — pull latest changes from origin/main, rebuild, and restart.
 *
 * Performs preflight checks (dirty tree, pending commits), then spawns a
 * detached bash script that outlives the Node process. The script handles:
 * stop → git pull → pnpm install → pnpm build → optional restart.
 *
 * Detached script is necessary because `ao self-update` may be invoked from
 * a tmux session or dashboard terminal managed by ao itself.
 */

import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig } from "@composio/ao-core";
import { exec } from "../lib/shell.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Repo root — four levels up from packages/cli/src/commands/ */
const REPO_DIR = resolve(__dirname, "../../../..");

function resolveProject(
  config: { projects: Record<string, { name: string; sessionPrefix: string }> },
  projectArg?: string,
): string | undefined {
  const ids = Object.keys(config.projects);
  if (projectArg) {
    if (!config.projects[projectArg]) {
      throw new Error(
        `Project "${projectArg}" not found. Available: ${ids.join(", ")}`,
      );
    }
    return projectArg;
  }
  return ids.length === 1 ? ids[0] : undefined;
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(question, (answer) => {
      rl.close();
      res(answer.trim().toLowerCase().startsWith("y"));
    });
  });
}

export function registerSelfUpdate(program: Command): void {
  program
    .command("self-update [project]")
    .description("Pull latest changes, rebuild, and restart the orchestrator")
    .option("--no-restart", "Pull and rebuild only — do not restart")
    .option("--force", "Skip confirmation prompt")
    .option("--dry-run", "Show what would be updated without doing it")
    .action(
      async (
        projectArg?: string,
        opts?: { restart?: boolean; force?: boolean; dryRun?: boolean },
      ) => {
        try {
          // ── Load config ──────────────────────────────────────────
          const config = loadConfig();
          const projectId = resolveProject(config, projectArg);
          const port = config.port ?? 3000;

          // ── Preflight: verify git repo ───────────────────────────
          try {
            await exec("git", ["rev-parse", "--git-dir"], { cwd: REPO_DIR });
          } catch {
            console.error(chalk.red("Not a git repository:"), REPO_DIR);
            process.exit(1);
          }

          // ── Preflight: check for uncommitted changes ─────────────
          const { stdout: status } = await exec("git", ["status", "--porcelain"], {
            cwd: REPO_DIR,
          });
          if (status.length > 0) {
            console.error(chalk.red("Uncommitted changes detected. Commit or stash first.\n"));
            console.error(status);
            process.exit(1);
          }

          // ── Preflight: fetch and compare ─────────────────────────
          await exec("git", ["fetch", "origin", "main"], { cwd: REPO_DIR });

          const { stdout: countStr } = await exec(
            "git",
            ["rev-list", "--count", "HEAD..origin/main"],
            { cwd: REPO_DIR },
          );
          const behindCount = parseInt(countStr, 10);

          if (behindCount === 0) {
            console.log(chalk.green("Already up-to-date with origin/main."));
            process.exit(0);
          }

          // ── Show pending commits ─────────────────────────────────
          const { stdout: log } = await exec(
            "git",
            ["log", "--oneline", "HEAD..origin/main"],
            { cwd: REPO_DIR },
          );
          console.log(
            chalk.bold(`\n${behindCount} new commit${behindCount > 1 ? "s" : ""} from origin/main:\n`),
          );
          console.log(chalk.dim(log));
          console.log();

          // ── Dry run: stop here ───────────────────────────────────
          if (opts?.dryRun) {
            console.log(chalk.yellow("Dry run — no changes made."));
            process.exit(0);
          }

          // ── Confirmation ─────────────────────────────────────────
          if (!opts?.force) {
            const restart = opts?.restart !== false;
            const action = restart ? "stop, update, rebuild, and restart" : "stop, update, and rebuild";
            const ok = await confirm(
              chalk.bold(`Proceed to ${action}? [y/N] `),
            );
            if (!ok) {
              console.log("Aborted.");
              process.exit(0);
            }
          }

          // ── Spawn detached update script ─────────────────────────
          const scriptPath = resolve(REPO_DIR, "scripts/ao-self-update");

          const child = spawn("bash", [scriptPath], {
            cwd: REPO_DIR,
            detached: true,
            stdio: "ignore",
            env: {
              ...process.env,
              AO_REPO_DIR: REPO_DIR,
              AO_PORT: String(port),
              AO_PROJECT: projectId ?? "",
              AO_RESTART: opts?.restart !== false ? "true" : "false",
            },
          });
          child.unref();

          console.log(chalk.bold.green("\nUpdate started in background."));
          console.log(
            chalk.dim("Log: ~/.agent-orchestrator/self-update.log"),
          );
          process.exit(0);
        } catch (err) {
          console.error(
            chalk.red("\nError:"),
            err instanceof Error ? err.message : String(err),
          );
          process.exit(1);
        }
      },
    );
}
