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
import { isInstalledUnderNodeModules } from "./dashboard-rebuild.js";

type RuntimeConfig = Record<string, unknown>;
type KnownRuntimes = Iterable<string> | undefined;

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
  const isNpmInstall = isInstalledUnderNodeModules(webDir);
  const corePkgDir = findPackageUp(webDir, "@composio", "ao-core");
  if (!corePkgDir) {
    const hint = isNpmInstall
      ? "Run: npm install -g @composio/ao@latest"
      : "Run: pnpm install && pnpm build";
    throw new Error(`Dependencies not installed. ${hint}`);
  }
  const coreEntry = resolve(corePkgDir, "dist", "index.js");
  if (!existsSync(coreEntry)) {
    const hint = isNpmInstall
      ? "Run: npm install -g @composio/ao@latest"
      : "Run: pnpm build";
    throw new Error(`Packages not built. ${hint}`);
  }

  const webBuildId = resolve(webDir, ".next", "BUILD_ID");
  const startAllEntry = resolve(webDir, "dist-server", "start-all.js");
  if (!existsSync(webBuildId) || !existsSync(startAllEntry)) {
    const hint = isNpmInstall
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

async function checkDocker(runtimeConfig?: RuntimeConfig): Promise<void> {
  try {
    await exec("docker", ["--version"]);
  } catch {
    throw new Error("Docker is not installed. Install it: https://docs.docker.com/get-docker/");
  }

  try {
    await exec("docker", ["info"]);
  } catch {
    throw new Error(
      "Docker is installed but the daemon is unavailable. Start Docker Desktop or the Docker service.",
    );
  }

  const image = runtimeConfig?.["image"];
  if (typeof image !== "string" || image.trim().length === 0) {
    throw new Error(
      "Docker runtime requires an image. Set project.runtimeConfig.image or pass --runtime-image / --runtime-config with an image override.",
    );
  }

  const readOnlyRoot = runtimeConfig?.["readOnlyRoot"] === true;
  const tmpfs = Array.isArray(runtimeConfig?.["tmpfs"])
    ? runtimeConfig?.["tmpfs"].filter((value): value is string => typeof value === "string")
    : [];
  const hasTmpfsTmp = tmpfs.some((mount) => mount.split(":")[0]?.trim() === "/tmp");
  if (readOnlyRoot && !hasTmpfsTmp) {
    throw new Error(
      "Docker runtime with readOnlyRoot=true also needs tmpfs to include /tmp. Add project.runtimeConfig.tmpfs: ['/tmp'] or pass --runtime-tmpfs /tmp.",
    );
  }
}

async function checkRuntime(
  runtime: string,
  runtimeConfig?: RuntimeConfig,
  knownRuntimes?: KnownRuntimes,
): Promise<void> {
  if (runtime === "tmux") {
    await checkTmux();
    return;
  }
  if (runtime === "docker") {
    await checkDocker(runtimeConfig);
    return;
  }
  if (runtime === "process") {
    return;
  }

  if (knownRuntimes) {
    const known = new Set([...knownRuntimes].filter(Boolean));
    if (known.has(runtime)) {
      return;
    }
  }

  throw new Error(
    `Unknown runtime "${runtime}". Configure a supported runtime plugin (tmux, docker, process) or check for typos in your config/flags.`,
  );
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
  checkRuntime,
  checkTmux,
  checkDocker,
  checkGhAuth,
};
