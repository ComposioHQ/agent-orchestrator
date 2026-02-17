/**
 * DashboardManager — unified dashboard lifecycle management.
 *
 * Consolidates the duplicated dashboard startup logic from
 * start.ts and dashboard.ts into a single service.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { findWebDir } from "../lib/web-dir.js";
import { exec } from "../lib/shell.js";
import type { ServicePorts } from "./PortManager.js";

export interface DashboardStartOptions {
  /** Ports for all dashboard services */
  ports: ServicePorts;
  /** Path to agent-orchestrator.yaml (passed via AO_CONFIG_PATH) */
  configPath: string | null;
  /** Whether to open the browser after startup */
  openBrowser?: boolean;
}

export class DashboardManager {
  private browserTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Start the dashboard and WebSocket servers.
   * Runs `pnpm dev` in the web package directory.
   */
  start(options: DashboardStartOptions): ChildProcess {
    const { ports, configPath, openBrowser = false } = options;
    const webDir = findWebDir();

    if (!existsSync(resolve(webDir, "package.json"))) {
      throw new Error(
        "Could not find @composio/ao-web package.\nEnsure it is installed: pnpm install",
      );
    }

    const env: Record<string, string> = { ...process.env } as Record<string, string>;

    // Pass config path so dashboard uses the same config as the CLI
    if (configPath) {
      env["AO_CONFIG_PATH"] = configPath;
    }

    // Set ports for all services
    env["PORT"] = String(ports.dashboard);
    env["TERMINAL_PORT"] = String(ports.terminalWs);
    env["DIRECT_TERMINAL_PORT"] = String(ports.directTerminalWs);

    const child = spawn("pnpm", ["run", "dev"], {
      cwd: webDir,
      stdio: "inherit",
      detached: false,
      env,
    });

    child.on("error", (err) => {
      console.error("Dashboard failed to start:", err.message);
    });

    if (openBrowser) {
      this.scheduleBrowserOpen(ports.dashboard);
    }

    return child;
  }

  /**
   * Stop dashboard and all WebSocket servers by killing processes on their ports.
   */
  async stop(ports: ServicePorts): Promise<void> {
    this.cancelBrowserOpen();

    const allPorts = [ports.dashboard, ports.terminalWs, ports.directTerminalWs];
    const allPids: string[] = [];

    for (const port of allPorts) {
      try {
        const { stdout } = await exec("lsof", ["-ti", `:${port}`]);
        const pids = stdout
          .trim()
          .split("\n")
          .filter((pid) => pid.length > 0);
        allPids.push(...pids);
      } catch {
        // Port not in use
      }
    }

    if (allPids.length === 0) {
      return;
    }

    const uniquePids = [...new Set(allPids)];

    try {
      await exec("kill", uniquePids);
    } catch {
      // Some processes may have already exited
    }
  }

  /**
   * Check if dashboard is running on a given port.
   */
  async isRunning(port: number): Promise<boolean> {
    try {
      const { stdout } = await exec("lsof", ["-ti", `:${port}`]);
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  /** Schedule browser open after a delay */
  private scheduleBrowserOpen(port: number, delayMs = 3000): void {
    this.browserTimer = setTimeout(() => {
      const browser = spawn("open", [`http://localhost:${port}`], {
        stdio: "ignore",
      });
      browser.on("error", () => {
        // Best effort
      });
    }, delayMs);
  }

  /** Cancel any pending browser open */
  private cancelBrowserOpen(): void {
    if (this.browserTimer) {
      clearTimeout(this.browserTimer);
      this.browserTimer = undefined;
    }
  }
}
