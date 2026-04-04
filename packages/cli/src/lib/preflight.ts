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
 * Locates @composio/ao-core by walking up from webDir, handling both pnpm
 * workspaces (symlinked deps in webDir/node_modules) and npm/yarn global
 * installs (hoisted to a parent node_modules).
 */
async function checkBuilt(webDir: string): Promise<void> {
  const corePkgDir = findPackageUp(webDir, "@composio", "ao-core");
  if (!corePkgDir) {
    const hint = webDir.includes("node_modules")
      ? "Run: npm install -g @composio/ao@latest"
      : "Run: pnpm install && pnpm build";
    throw new Error(`Dependencies not installed. ${hint}`);
  }
  const coreEntry = resolve(corePkgDir, "dist", "index.js");
  if (!existsSync(coreEntry)) {
    const hint = webDir.includes("node_modules")
      ? "Run: npm install -g @composio/ao@latest"
      : "Run: pnpm build";
    throw new Error(`Packages not built. ${hint}`);
  }

  const webBuildId = resolve(webDir, ".next", "BUILD_ID");
  const startAllEntry = resolve(webDir, "dist-server", "start-all.js");
  if (!existsSync(webBuildId) || !existsSync(startAllEntry)) {
    const hint = webDir.includes("node_modules")
      ? "Run: npm install -g @composio/ao@latest"
      : "Run: pnpm build";
    throw new Error(`Packages not built. ${hint}`);
  }
}

/**
 * Walk up from startDir looking for node_modules/<segments>.
 * Mirrors Node's module resolution: checks each ancestor directory until
 * the package is found or the filesystem root is reached.
 */
function findPackageUp(startDir: string, ...segments: string[]): string | null {
  let dir = resolve(startDir);
  while (true) {
    const candidate = resolve(dir, "node_modules", ...segments);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Check that tmux is installed.
 * Throws with platform-appropriate manual install instructions when missing.
 */
async function checkTmux(): Promise<void> {
  try {
    await exec("tmux", ["-V"]);
    return;
  } catch {
    // tmux not found
  }

  const hint =
    process.platform === "darwin"
      ? "brew install tmux"
      : process.platform === "win32"
        ? "tmux is not available on Windows. Use WSL: wsl --install, then: sudo apt install tmux"
        : "sudo apt install tmux (Debian/Ubuntu) or sudo dnf install tmux (Fedora)";
  throw new Error(`tmux is not installed. Install it: ${hint}`);
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
