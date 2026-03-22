/**
 * Pre-flight checks for `ao start` and `ao spawn`.
 *
 * Validates runtime prerequisites before entering the main command flow,
 * giving clear errors instead of cryptic failures.
 *
 * All checks throw on failure so callers can catch and handle uniformly.
 */

import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
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
  // Walk up from webDir checking node_modules/@composio/ao-core at each level.
  // This handles both pnpm (symlinked in webDir/node_modules) and npm global
  // installs (hoisted to a parent node_modules).
  const corePkgDir = findPackageUp(webDir, "@composio", "ao-core");
  if (!corePkgDir) {
    throw new Error("Dependencies not installed. Run: pnpm install && pnpm build");
  }
  const coreEntry = resolve(corePkgDir, "dist", "index.js");
  if (!existsSync(coreEntry)) {
    throw new Error("Packages not built. Run: pnpm build");
  }
}

/** Walk up from `startDir` looking for `node_modules/<segments>`. */
function findPackageUp(startDir: string, ...segments: string[]): string | null {
  let dir = resolve(startDir);
  const root = dirname(dir) === dir ? dir : undefined; // filesystem root guard
  while (true) {
    const candidate = resolve(dir, "node_modules", ...segments);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir || parent === root) break;
    dir = parent;
  }
  return null;
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
