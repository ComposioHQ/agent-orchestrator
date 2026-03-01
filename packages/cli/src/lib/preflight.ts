/**
 * Pre-flight checks for `ao start` and `ao spawn`.
 *
 * Validates runtime prerequisites before entering the main command flow,
 * giving clear errors instead of cryptic failures.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import { isPortAvailable, findWebDir } from "./web-dir.js";
import { exec } from "./shell.js";

/**
 * Check that the dashboard port is free.
 * Exits with a clear message if it's already in use.
 */
async function checkPort(port: number): Promise<void> {
  const free = await isPortAvailable(port);
  if (!free) {
    console.error(
      chalk.red(
        `Port ${port} is already in use. Free it or change 'port' in agent-orchestrator.yaml.`,
      ),
    );
    process.exit(1);
  }
}

/**
 * Check that packages have been built (the web .next directory exists).
 * Exits with a clear message if not.
 */
async function checkBuilt(): Promise<void> {
  const webDir = findWebDir();
  const buildId = resolve(webDir, ".next", "BUILD_ID");
  if (!existsSync(buildId)) {
    console.error(chalk.red("Packages not built. Run: pnpm build"));
    process.exit(1);
  }
}

/**
 * Check that tmux is installed (required for the default runtime).
 * Throws with a clear message if not.
 */
async function checkTmux(): Promise<void> {
  try {
    await exec("tmux", ["-V"]);
  } catch {
    throw new Error("tmux is not installed. Install it: brew install tmux");
  }
}

/**
 * Check that the GitHub CLI is authenticated.
 * Only relevant when the project uses the github tracker plugin.
 * Throws with a clear message if not authenticated.
 */
async function checkGhAuth(): Promise<void> {
  try {
    await exec("gh", ["auth", "status"]);
  } catch {
    throw new Error("GitHub CLI is not authenticated. Run: gh auth login");
  }
}

export const preflight = {
  checkPort,
  checkBuilt,
  checkTmux,
  checkGhAuth,
};
