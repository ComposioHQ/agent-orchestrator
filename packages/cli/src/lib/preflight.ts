/**
 * Pre-flight checks for `ao start` and `ao spawn`.
 *
 * Validates runtime prerequisites before entering the main command flow,
 * giving clear errors instead of cryptic failures.
 *
 * All checks throw on failure so callers can catch and handle uniformly.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { isPortAvailable } from "./web-dir.js";
import { exec } from "./shell.js";

/**
 * Check that the dashboard port is free.
 * Throws if the port is already in use.
 */
async function checkPort(port: number): Promise<void> {
  const free = await isPortAvailable(port);
  if (!free) {
    throw new Error(
      `Port ${port} is already in use. Free it or change 'port' in agent-orchestrator.yaml.`,
    );
  }
}

/**
 * Check that workspace packages have been compiled (TypeScript → JavaScript).
 * Verifies @composio/ao-core dist output exists from the web package's
 * node_modules, since a missing dist/ causes module resolution errors when
 * starting the dashboard. Works with both `next dev` and `next build`.
 */
async function checkBuilt(webDir: string): Promise<void> {
  const coreEntry = resolve(webDir, "node_modules", "@composio", "ao-core", "dist", "index.js");
  if (!existsSync(coreEntry)) {
    throw new Error("Packages not built. Run: pnpm build");
  }
}

/**
 * Check that tmux is installed (required for the default runtime).
 * Throws if not installed.
 */
async function checkTmux(): Promise<void> {
  try {
    await exec("tmux", ["-V"]);
  } catch {
    throw new Error("tmux is not installed. Install it: brew install tmux");
  }
}

/**
 * Check that the GitHub CLI is installed and authenticated.
 * Distinguishes between "not installed" and "not authenticated"
 * so the user gets the right troubleshooting guidance.
 */
async function checkGhAuth(): Promise<void> {
  try {
    await exec("gh", ["--version"]);
  } catch {
    throw new Error("GitHub CLI (gh) is not installed. Install it: https://cli.github.com/");
  }

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
