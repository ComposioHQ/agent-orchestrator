/**
 * Install helpers — interactive "ensure X is present, offer to install" flows.
 *
 * Shared by `ao start` (ensures tmux/git/gh before launch) and config bootstrap
 * (offers to install git when a URL clone is about to run).
 */

import { spawn } from "node:child_process";
import chalk from "chalk";
import { execSilent } from "./shell.js";
import { isHumanCaller } from "./caller-context.js";
import { promptConfirm } from "./prompts.js";
import { formatCommandError } from "./cli-errors.js";

export interface InstallAttempt {
  cmd: string;
  args: string[];
  label: string;
}

export function canPromptForInstall(): boolean {
  return isHumanCaller() && Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function genericInstallHints(command: string): string[] {
  switch (command) {
    case "node":
    case "npm":
      return ["Install Node.js/npm from https://nodejs.org/"];
    case "pnpm":
      return [
        "corepack enable && corepack prepare pnpm@latest --activate",
        "npm install -g pnpm",
      ];
    case "pipx":
      return [
        "python3 -m pip install --user pipx",
        "python3 -m pipx ensurepath",
      ];
    default:
      return [];
  }
}

export async function askYesNo(
  question: string,
  defaultYes = true,
  nonInteractiveDefault = defaultYes,
): Promise<boolean> {
  if (!canPromptForInstall()) return nonInteractiveDefault;
  return await promptConfirm(question, defaultYes);
}

export async function runInteractiveCommand(cmd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.once("error", (err) => {
      reject(
        formatCommandError(err, {
          cmd,
          args,
          action: "run an interactive installer",
          installHints: genericInstallHints(cmd),
        }),
      );
    });
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Command failed (${code ?? "unknown"}): ${cmd} ${args.join(" ")}`));
    });
  });
}

export async function tryInstallWithAttempts(
  attempts: InstallAttempt[],
  verify: () => Promise<boolean>,
): Promise<boolean> {
  for (const attempt of attempts) {
    try {
      console.log(chalk.dim(`  Running: ${attempt.label}`));
      await runInteractiveCommand(attempt.cmd, attempt.args);
      if (await verify()) return true;
    } catch {
      // Try next installer
    }
  }
  return verify();
}

// ── git ───────────────────────────────────────────────────────────────────

export function gitInstallAttempts(): InstallAttempt[] {
  if (process.platform === "darwin") {
    return [{ cmd: "brew", args: ["install", "git"], label: "brew install git" }];
  }
  if (process.platform === "linux") {
    return [
      { cmd: "sudo", args: ["apt-get", "install", "-y", "git"], label: "sudo apt-get install -y git" },
      { cmd: "sudo", args: ["dnf", "install", "-y", "git"], label: "sudo dnf install -y git" },
    ];
  }
  if (process.platform === "win32") {
    return [
      {
        cmd: "winget",
        args: ["install", "--id", "Git.Git", "-e", "--source", "winget"],
        label: "winget install --id Git.Git -e --source winget",
      },
    ];
  }
  return [];
}

export function gitInstallHints(): string[] {
  if (process.platform === "darwin") return ["brew install git"];
  if (process.platform === "win32") return ["winget install --id Git.Git -e --source winget"];
  return [
    "sudo apt install git      # Debian/Ubuntu",
    "sudo dnf install git      # Fedora/RHEL",
  ];
}

export async function ensureGit(context: string): Promise<void> {
  const hasGit = (await execSilent("git", ["--version"])) !== null;
  if (hasGit) return;

  console.log(chalk.yellow(`⚠ Git is required for ${context}.`));
  const shouldInstall = await askYesNo("Install Git now?", true, false);
  if (shouldInstall) {
    const installed = await tryInstallWithAttempts(
      gitInstallAttempts(),
      async () => (await execSilent("git", ["--version"])) !== null,
    );
    if (installed) {
      console.log(chalk.green("  ✓ Git installed successfully"));
      return;
    }
  }

  console.error(chalk.red("\n✗ Git is required but is not installed.\n"));
  console.log(chalk.bold("  Install Git manually, then re-run ao start:\n"));
  for (const hint of gitInstallHints()) {
    console.log(chalk.cyan(`    ${hint}`));
  }
  console.log();
  process.exit(1);
}

// ── gh ────────────────────────────────────────────────────────────────────

export function ghInstallAttempts(): InstallAttempt[] {
  if (process.platform === "darwin") {
    return [{ cmd: "brew", args: ["install", "gh"], label: "brew install gh" }];
  }
  if (process.platform === "linux") {
    return [
      { cmd: "sudo", args: ["apt-get", "install", "-y", "gh"], label: "sudo apt-get install -y gh" },
      { cmd: "sudo", args: ["dnf", "install", "-y", "gh"], label: "sudo dnf install -y gh" },
    ];
  }
  if (process.platform === "win32") {
    return [
      {
        cmd: "winget",
        args: ["install", "--id", "GitHub.cli", "-e", "--source", "winget"],
        label: "winget install --id GitHub.cli -e --source winget",
      },
    ];
  }
  return [];
}

// ── tmux ──────────────────────────────────────────────────────────────────

function tmuxInstallAttempts(): InstallAttempt[] {
  if (process.platform === "darwin") {
    return [{ cmd: "brew", args: ["install", "tmux"], label: "brew install tmux" }];
  }
  if (process.platform === "linux") {
    return [
      { cmd: "sudo", args: ["apt-get", "install", "-y", "tmux"], label: "sudo apt-get install -y tmux" },
      { cmd: "sudo", args: ["dnf", "install", "-y", "tmux"], label: "sudo dnf install -y tmux" },
    ];
  }
  return [];
}

function tmuxInstallHints(): string[] {
  if (process.platform === "darwin") return ["brew install tmux"];
  if (process.platform === "win32") return [
    "# Install WSL first, then inside WSL:",
    "sudo apt install tmux",
  ];
  return [
    "sudo apt install tmux      # Debian/Ubuntu",
    "sudo dnf install tmux      # Fedora/RHEL",
  ];
}

/**
 * Ensure tmux is available — interactive install with user consent if missing.
 * Called from the orchestrator bootstrap so ALL `ao start` paths (normal, URL,
 * retry with existing config) are covered.
 */
export async function ensureTmux(): Promise<void> {
  const hasTmux = (await execSilent("tmux", ["-V"])) !== null;
  if (hasTmux) return;

  console.log(chalk.yellow("⚠ tmux is required for runtime \"tmux\"."));
  const shouldInstall = await askYesNo("Install tmux now?", true, false);
  if (shouldInstall) {
    const installed = await tryInstallWithAttempts(
      tmuxInstallAttempts(),
      async () => (await execSilent("tmux", ["-V"])) !== null,
    );
    if (installed) {
      console.log(chalk.green("  ✓ tmux installed successfully"));
      return;
    }
  }

  console.error(chalk.red("\n✗ tmux is required but is not installed.\n"));
  console.log(chalk.bold("  Install tmux manually, then re-run ao start:\n"));
  for (const hint of tmuxInstallHints()) {
    console.log(chalk.cyan(`    ${hint}`));
  }
  console.log();
  process.exit(1);
}
