/**
 * `ao service install/uninstall` — systemd/launchd service management
 * for the lifecycle-worker.
 *
 * Generates and installs a system service so the lifecycle-worker
 * auto-starts on boot, enabling dead-session recovery and auto-respawn.
 *
 * macOS: ~/Library/LaunchAgents/com.composio.ao-lifecycle.<projectId>.plist
 * Linux: ~/.config/systemd/user/ao-lifecycle-<projectId>.service
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig, type OrchestratorConfig } from "@composio/ao-core";

// ---------------------------------------------------------------------------
// Service file generators
// ---------------------------------------------------------------------------

function sanitizeProjectId(projectId: string): string {
  return projectId.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function resolveAoBinary(): string {
  // Try to find the ao binary from the current process
  const entry = process.argv[1];
  if (entry && existsSync(entry)) {
    return resolve(entry);
  }
  // Fall back to looking in PATH
  try {
    return execSync("which ao", { encoding: "utf-8" }).trim();
  } catch {
    return "ao";
  }
}

function generateLaunchdPlist(
  projectId: string,
  aoBinary: string,
  configPath: string,
): string {
  const safeId = sanitizeProjectId(projectId);
  const logDir = join(homedir(), "Library", "Logs", "ao");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.composio.ao-lifecycle.${safeId}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${aoBinary}</string>
    <string>lifecycle-worker</string>
    <string>${projectId}</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>AO_CONFIG_PATH</key>
    <string>${configPath}</string>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:${join(homedir(), ".local", "bin")}</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>ThrottleInterval</key>
  <integer>30</integer>

  <key>StandardOutPath</key>
  <string>${join(logDir, `lifecycle-${safeId}.log`)}</string>
  <key>StandardErrorPath</key>
  <string>${join(logDir, `lifecycle-${safeId}.log`)}</string>
</dict>
</plist>
`;
}

function generateSystemdUnit(
  projectId: string,
  aoBinary: string,
  configPath: string,
): string {
  const safeId = sanitizeProjectId(projectId);
  return `[Unit]
Description=AO Lifecycle Worker (${projectId})
After=network.target

[Service]
Type=simple
ExecStart=${aoBinary} lifecycle-worker ${projectId}
Environment=AO_CONFIG_PATH=${configPath}
Restart=on-failure
RestartSec=30

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=ao-lifecycle-${safeId}

[Install]
WantedBy=default.target
`;
}

// ---------------------------------------------------------------------------
// Install / Uninstall
// ---------------------------------------------------------------------------

function getLaunchdPath(projectId: string): string {
  const safeId = sanitizeProjectId(projectId);
  return join(homedir(), "Library", "LaunchAgents", `com.composio.ao-lifecycle.${safeId}.plist`);
}

function getSystemdPath(projectId: string): string {
  const safeId = sanitizeProjectId(projectId);
  return join(homedir(), ".config", "systemd", "user", `ao-lifecycle-${safeId}.service`);
}

interface InstallResult {
  servicePath: string;
  platform: "launchd" | "systemd";
  activated: boolean;
}

function installService(
  projectId: string,
  config: OrchestratorConfig,
): InstallResult {
  const aoBinary = resolveAoBinary();
  const os = platform();

  if (os === "darwin") {
    const plistPath = getLaunchdPath(projectId);
    const logDir = join(homedir(), "Library", "Logs", "ao");
    mkdirSync(logDir, { recursive: true });
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });

    // Unload existing if present (ignore errors)
    if (existsSync(plistPath)) {
      try {
        execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: "ignore" });
      } catch {
        // May not be loaded
      }
    }

    const content = generateLaunchdPlist(projectId, aoBinary, config.configPath);
    writeFileSync(plistPath, content);

    let activated = false;
    try {
      execSync(`launchctl load "${plistPath}"`, { stdio: "pipe" });
      activated = true;
    } catch {
      // Load failed — user can manually load
    }

    return { servicePath: plistPath, platform: "launchd", activated };
  }

  if (os === "linux") {
    const unitPath = getSystemdPath(projectId);
    mkdirSync(join(homedir(), ".config", "systemd", "user"), { recursive: true });

    const content = generateSystemdUnit(projectId, aoBinary, config.configPath);
    writeFileSync(unitPath, content);

    let activated = false;
    try {
      execSync("systemctl --user daemon-reload", { stdio: "pipe" });
      const safeId = sanitizeProjectId(projectId);
      execSync(`systemctl --user enable --now ao-lifecycle-${safeId}.service`, {
        stdio: "pipe",
      });
      activated = true;
    } catch {
      // systemctl not available or failed
    }

    return { servicePath: unitPath, platform: "systemd", activated };
  }

  throw new Error(`Unsupported platform: ${os}. Only macOS (launchd) and Linux (systemd) are supported.`);
}

function uninstallService(projectId: string): { removed: boolean; servicePath: string } {
  const os = platform();

  if (os === "darwin") {
    const plistPath = getLaunchdPath(projectId);
    if (!existsSync(plistPath)) {
      return { removed: false, servicePath: plistPath };
    }

    try {
      execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: "ignore" });
    } catch {
      // May not be loaded
    }

    unlinkSync(plistPath);
    return { removed: true, servicePath: plistPath };
  }

  if (os === "linux") {
    const unitPath = getSystemdPath(projectId);
    if (!existsSync(unitPath)) {
      return { removed: false, servicePath: unitPath };
    }

    const safeId = sanitizeProjectId(projectId);
    try {
      execSync(`systemctl --user disable --now ao-lifecycle-${safeId}.service 2>/dev/null`, {
        stdio: "ignore",
      });
    } catch {
      // May not be running
    }

    unlinkSync(unitPath);

    try {
      execSync("systemctl --user daemon-reload", { stdio: "pipe" });
    } catch {
      // Best effort
    }

    return { removed: true, servicePath: unitPath };
  }

  throw new Error(`Unsupported platform: ${os}`);
}

function getServiceStatus(projectId: string): { installed: boolean; running: boolean; servicePath: string } {
  const os = platform();

  if (os === "darwin") {
    const plistPath = getLaunchdPath(projectId);
    if (!existsSync(plistPath)) {
      return { installed: false, running: false, servicePath: plistPath };
    }
    const safeId = sanitizeProjectId(projectId);
    let running = false;
    try {
      const output = execSync(`launchctl list 2>/dev/null`, { encoding: "utf-8" });
      running = output.includes(`com.composio.ao-lifecycle.${safeId}`);
    } catch {
      // Can't determine status
    }
    return { installed: true, running, servicePath: plistPath };
  }

  if (os === "linux") {
    const unitPath = getSystemdPath(projectId);
    if (!existsSync(unitPath)) {
      return { installed: false, running: false, servicePath: unitPath };
    }
    const safeId = sanitizeProjectId(projectId);
    let running = false;
    try {
      execSync(`systemctl --user is-active ao-lifecycle-${safeId}.service`, {
        stdio: "pipe",
      });
      running = true;
    } catch {
      // Not active
    }
    return { installed: true, running, servicePath: unitPath };
  }

  return { installed: false, running: false, servicePath: "" };
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerService(program: Command): void {
  const service = program
    .command("service")
    .description("Manage lifecycle-worker system service (auto-start on boot)");

  service
    .command("install")
    .description("Install lifecycle-worker as a system service")
    .argument("[project]", "Project ID (defaults to first project in config)")
    .action(async (projectArg?: string) => {
      const config = loadConfig();
      const projectId = projectArg ?? Object.keys(config.projects)[0];

      if (!projectId || !config.projects[projectId]) {
        console.error(chalk.red(`Unknown project: ${projectId ?? "(none)"}`));
        console.error(chalk.dim("Available projects: " + Object.keys(config.projects).join(", ")));
        process.exit(1);
      }

      try {
        const result = installService(projectId, config);
        console.log(chalk.green(`Service installed: ${result.servicePath}`));
        console.log(chalk.dim(`Platform: ${result.platform}`));

        if (result.activated) {
          console.log(chalk.green("Service activated — lifecycle-worker will start on boot."));
        } else {
          if (result.platform === "launchd") {
            console.log(chalk.yellow(`Activate manually: launchctl load "${result.servicePath}"`));
          } else {
            const safeId = sanitizeProjectId(projectId);
            console.log(
              chalk.yellow(
                `Activate manually: systemctl --user enable --now ao-lifecycle-${safeId}.service`,
              ),
            );
          }
        }

        console.log(
          chalk.dim(
            "\nThe lifecycle-worker will auto-start on boot, detect dead sessions, and respawn them.",
          ),
        );
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  service
    .command("uninstall")
    .description("Remove lifecycle-worker system service")
    .argument("[project]", "Project ID (defaults to first project in config)")
    .action(async (projectArg?: string) => {
      const config = loadConfig();
      const projectId = projectArg ?? Object.keys(config.projects)[0];

      if (!projectId) {
        console.error(chalk.red("No project found in config."));
        process.exit(1);
      }

      try {
        const result = uninstallService(projectId);
        if (result.removed) {
          console.log(chalk.green(`Service removed: ${result.servicePath}`));
        } else {
          console.log(chalk.yellow(`No service found at: ${result.servicePath}`));
        }
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  service
    .command("status")
    .description("Check lifecycle-worker service status")
    .argument("[project]", "Project ID (defaults to first project in config)")
    .action(async (projectArg?: string) => {
      const config = loadConfig();
      const projectId = projectArg ?? Object.keys(config.projects)[0];

      if (!projectId) {
        console.error(chalk.red("No project found in config."));
        process.exit(1);
      }

      const status = getServiceStatus(projectId);
      if (!status.installed) {
        console.log(chalk.yellow("Service not installed."));
        console.log(chalk.dim(`Run: ao service install ${projectId}`));
      } else {
        console.log(chalk.green(`Service installed: ${status.servicePath}`));
        console.log(
          status.running
            ? chalk.green("Status: running")
            : chalk.yellow("Status: not running"),
        );
      }
    });
}
