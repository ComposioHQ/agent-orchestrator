/**
 * `ao setup-systemd` — generate systemd user-units for the agent orchestrator.
 *
 * Creates:
 *   ~/.config/systemd/user/ao-telegram-bridge.service
 *   ~/.config/systemd/user/ao-lifecycle.service
 *   ~/.config/systemd/user/ao-dashboard.service
 *   ~/.config/systemd/user/ao.target
 *   ~/.config/ao/secrets.env
 *
 * Then runs daemon-reload + enable ao.target.
 *
 * Exports `setupSystemdUnits()` so `ao start` can auto-setup on first run.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig, type OrchestratorConfig } from "@composio/ao-core";
import { exec } from "../lib/shell.js";
import { findWebDir } from "../lib/web-dir.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Check whether systemd is available on this machine. */
export async function isSystemdAvailable(): Promise<boolean> {
  try {
    await exec("systemctl", ["--user", "--version"]);
    return true;
  } catch {
    return false;
  }
}

/** Check whether ao.target is already installed. */
export function hasSystemdUnits(): boolean {
  return existsSync(resolve(homedir(), ".config/systemd/user/ao.target"));
}

/** Resolve repo root from the CLI dist directory. */
function getRepoRoot(): string {
  // packages/cli/dist/commands/ → repo root (4 levels up)
  // packages/cli/src/commands/ → repo root (4 levels up)
  const candidates = [
    resolve(__dirname, "../../../.."),
    resolve(__dirname, "../../../../"),
  ];
  for (const c of candidates) {
    if (existsSync(resolve(c, "package.json")) && existsSync(resolve(c, "packages"))) {
      return c;
    }
  }
  return candidates[0];
}

/** Read existing token from the current telegram-bridge service, if any. */
function readExistingTelegramToken(unitDir: string): { token: string; chatId: string } | null {
  const servicePath = resolve(unitDir, "telegram-bridge.service");
  if (!existsSync(servicePath)) return null;

  const content = readFileSync(servicePath, "utf-8");

  const tokenMatch = content.match(/TELEGRAM_BOT_TOKEN=(\S+)/);
  const chatMatch = content.match(/TELEGRAM_CHAT_ID=(\S+)/);

  if (tokenMatch?.[1] && chatMatch?.[1]) {
    return { token: tokenMatch[1], chatId: chatMatch[1] };
  }
  return null;
}

/** Read existing secrets.env if present. */
function readExistingSecrets(secretsPath: string): { token: string; chatId: string } | null {
  if (!existsSync(secretsPath)) return null;

  const content = readFileSync(secretsPath, "utf-8");
  const tokenMatch = content.match(/TELEGRAM_BOT_TOKEN=(\S+)/);
  const chatMatch = content.match(/TELEGRAM_CHAT_ID=(\S+)/);

  if (tokenMatch?.[1] && chatMatch?.[1]) {
    return { token: tokenMatch[1], chatId: chatMatch[1] };
  }
  return null;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Core setup logic — generates all unit files, secrets, and enables the target.
 * Called by both `ao setup-systemd` (explicit) and `ao start` (auto-setup).
 */
export async function setupSystemdUnits(config: OrchestratorConfig): Promise<void> {
  const repoRoot = getRepoRoot();
  const home = homedir();
  const unitDir = resolve(home, ".config/systemd/user");
  const aoConfigDir = resolve(home, ".config/ao");
  const secretsPath = resolve(aoConfigDir, "secrets.env");

  ensureDir(unitDir);
  ensureDir(aoConfigDir);

  // Resolve paths
  let nodePath: string;
  try {
    const { stdout } = await exec("which", ["node"]);
    nodePath = stdout.trim();
  } catch {
    nodePath = "/usr/bin/node";
  }

  let pnpmPath: string;
  try {
    const { stdout } = await exec("which", ["pnpm"]);
    pnpmPath = stdout.trim();
  } catch {
    pnpmPath = resolve(home, ".npm-global/bin/pnpm");
  }

  // Build PATH that includes node and pnpm directories
  const binDirs = new Set<string>();
  binDirs.add(dirname(nodePath));
  binDirs.add(dirname(pnpmPath));
  binDirs.add(resolve(home, ".local/bin"));
  binDirs.add(resolve(home, ".npm-global/bin"));
  // Linuxbrew — only add if it exists
  if (existsSync("/home/linuxbrew/.linuxbrew/bin")) {
    binDirs.add("/home/linuxbrew/.linuxbrew/bin");
  }
  binDirs.add("/usr/local/bin");
  binDirs.add("/usr/bin");
  binDirs.add("/bin");
  const envPath = [...binDirs].join(":");

  const port = config.port ?? 3000;
  const terminalPort = config.terminalPort ?? 14800;
  const directTerminalPort = config.directTerminalPort ?? 14801;
  const webDir = findWebDir();

  // Lifecycle daemon entry point (compiled JS)
  const lifecycleDaemonPath = resolve(repoRoot, "packages/cli/dist/commands/lifecycle-daemon.js");

  // --- Secrets ---
  const existingSecrets = readExistingSecrets(secretsPath);
  const existingUnit = readExistingTelegramToken(unitDir);
  const telegramToken = existingSecrets?.token ?? existingUnit?.token ?? "";
  const telegramChatId = existingSecrets?.chatId ?? existingUnit?.chatId ?? "";

  if (!telegramToken) {
    console.log(chalk.yellow("Warning: No TELEGRAM_BOT_TOKEN found."));
    console.log(chalk.dim("  Edit ~/.config/ao/secrets.env to set it.\n"));
  }

  const secretsContent = [
    `TELEGRAM_BOT_TOKEN=${telegramToken}`,
    `TELEGRAM_CHAT_ID=${telegramChatId}`,
    "",
  ].join("\n");

  writeFileSync(secretsPath, secretsContent, "utf-8");
  chmodSync(secretsPath, 0o600);
  console.log(chalk.green("✓"), `Secrets: ${secretsPath}`);

  // --- ao-telegram-bridge.service ---
  const telegramBridgePath = resolve(home, ".openclaw/telegram-bridge/bridge.mjs");
  const telegramUnit = `[Unit]
Description=Telegram Bridge for Agent Orchestrator
After=network.target
PartOf=ao.target

[Service]
Type=simple
ExecStart=${nodePath} ${telegramBridgePath}
EnvironmentFile=${secretsPath}
Environment=BRIDGE_PORT=8787
Restart=on-failure
RestartSec=5

[Install]
WantedBy=ao.target
`;
  writeFileSync(resolve(unitDir, "ao-telegram-bridge.service"), telegramUnit, "utf-8");
  console.log(chalk.green("✓"), "ao-telegram-bridge.service");

  // --- ao-lifecycle.service ---
  const lifecycleUnit = `[Unit]
Description=Agent Orchestrator Lifecycle Manager
After=network.target ao-telegram-bridge.service
PartOf=ao.target

[Service]
Type=simple
ExecStart=${nodePath} ${lifecycleDaemonPath}
WorkingDirectory=${repoRoot}
Environment=PATH=${envPath}
Environment=HOME=${home}
Environment=NODE_ENV=production
Environment=AO_CONFIG_PATH=${config.configPath}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=ao.target
`;
  writeFileSync(resolve(unitDir, "ao-lifecycle.service"), lifecycleUnit, "utf-8");
  console.log(chalk.green("✓"), "ao-lifecycle.service");

  // --- ao-dashboard.service ---
  const dashboardUnit = `[Unit]
Description=Agent Orchestrator Dashboard
After=network.target
PartOf=ao.target

[Service]
Type=simple
ExecStart=${pnpmPath} run dev
WorkingDirectory=${webDir}
Environment=PATH=${envPath}
Environment=HOME=${home}
Environment=PORT=${port}
Environment=AO_CONFIG_PATH=${config.configPath}
Environment=TERMINAL_PORT=${terminalPort}
Environment=DIRECT_TERMINAL_PORT=${directTerminalPort}
Environment=NEXT_PUBLIC_TERMINAL_PORT=${terminalPort}
Environment=NEXT_PUBLIC_DIRECT_TERMINAL_PORT=${directTerminalPort}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=ao.target
`;
  writeFileSync(resolve(unitDir, "ao-dashboard.service"), dashboardUnit, "utf-8");
  console.log(chalk.green("✓"), "ao-dashboard.service");

  // --- ao.target ---
  const targetUnit = `[Unit]
Description=Agent Orchestrator (all services)
Wants=ao-telegram-bridge.service ao-lifecycle.service ao-dashboard.service

[Install]
WantedBy=default.target
`;
  writeFileSync(resolve(unitDir, "ao.target"), targetUnit, "utf-8");
  console.log(chalk.green("✓"), "ao.target");

  // --- daemon-reload + enable ---
  console.log();
  await exec("systemctl", ["--user", "daemon-reload"]);
  console.log(chalk.green("✓"), "systemctl --user daemon-reload");

  await exec("systemctl", ["--user", "enable", "ao.target"]);
  console.log(chalk.green("✓"), "systemctl --user enable ao.target");

  // If the old telegram-bridge.service (without ao- prefix) exists, disable it
  const oldTelegramUnit = resolve(unitDir, "telegram-bridge.service");
  if (existsSync(oldTelegramUnit)) {
    try {
      await exec("systemctl", ["--user", "stop", "telegram-bridge.service"]);
      await exec("systemctl", ["--user", "disable", "telegram-bridge.service"]);
      console.log(chalk.green("✓"), "Disabled old telegram-bridge.service");
    } catch {
      // Ignore — may already be stopped
    }
  }
}

export function registerSetupSystemd(program: Command): void {
  program
    .command("setup-systemd")
    .description("Generate systemd user-units for the agent orchestrator")
    .action(async () => {
      try {
        const config = loadConfig();
        await setupSystemdUnits(config);

        console.log(chalk.bold.green("\n✓ Setup complete\n"));
        console.log("Start all services:");
        console.log(chalk.cyan("  ao start"));
        console.log("\nOr manually:");
        console.log(chalk.cyan("  systemctl --user start ao.target"));
        console.log("\nView logs:");
        console.log(chalk.cyan("  journalctl --user -u ao-lifecycle -f"));
        console.log(chalk.cyan("  journalctl --user -u ao-dashboard -f"));
        console.log(chalk.cyan("  journalctl --user -u ao-telegram-bridge -f"));
        console.log();
      } catch (err) {
        console.error(chalk.red("\nError:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
