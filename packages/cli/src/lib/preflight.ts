import { exec } from "./shell.js";
import { isPortAvailable } from "./web-dir.js";

/**
 * Check that a port is available.
 * Throws if the port is already in use.
 */
async function checkPort(port: number): Promise<void> {
  const available = await isPortAvailable(port);
  if (!available) {
    throw new Error(
      `Port ${port} is already in use. Kill the process using it or set a different 'port' in agent-orchestrator.yaml.`,
    );
  }
}

/**
 * Check that the web dashboard is built.
 * Throws if the 'dist' directory is missing in the web package.
 */
async function checkBuilt(webDir: string): Promise<void> {
  const { existsSync } = await import("node:fs");
  const { resolve } = await import("node:path");

  // In the monorepo, we check for 'server/index.ts' source.
  // In published npm packages, we check for 'dist-server/start-all.js'.
  const isDevMode = existsSync(resolve(webDir, "server"));
  const distDir = isDevMode ? resolve(webDir, ".next") : resolve(webDir, "dist-server");

  if (!existsSync(distDir)) {
    const buildCmd = isDevMode ? "pnpm build" : "npm run build";
    throw new Error(
      `Web dashboard is not built. Run '${buildCmd}' in '${webDir}' before starting.`,
    );
  }
}

/**
 * Check that tmux is installed.
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
 * Check that the GitHub CLI (gh) is authenticated.
 * Throws if not authenticated.
 */
async function checkGhAuth(): Promise<void> {
  try {
    await exec("gh", ["auth", "status"]);
  } catch {
    throw new Error("GitHub CLI is not authenticated. Run: gh auth login");
  }
}

/**
 * Check that git is installed.
 * Throws if not installed.
 */
async function checkGit(): Promise<void> {
  try {
    await exec("git", ["--version"]);
  } catch {
    throw new Error("git is not installed. Install it: brew install git");
  }
}

/**
 * Check that ttyd is installed.
 * Throws if not installed.
 */
async function checkTtyd(): Promise<void> {
  try {
    await exec("ttyd", ["--version"]);
  } catch {
    throw new Error(
      "ttyd is not installed. Required for terminal sessions. Install it: brew install ttyd",
    );
  }
}

export const preflight = {
  checkPort,
  checkBuilt,
  checkTmux,
  checkGhAuth,
  checkGit,
  checkTtyd,
};
