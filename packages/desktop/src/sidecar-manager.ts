import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type { SidecarStartOptions, SidecarStatus } from "./types.js";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SidecarManager {
  private child: ChildProcess | null = null;
  private startedAt: Date | null = null;
  private scriptPath: string | null = null;

  getStatus(): SidecarStatus {
    return {
      running: this.child !== null && !this.child.killed,
      pid: this.child?.pid ?? null,
      startedAt: this.startedAt,
      scriptPath: this.scriptPath,
    };
  }

  async start(options: SidecarStartOptions): Promise<void> {
    if (this.child && !this.child.killed) {
      throw new Error("Sidecar is already running");
    }

    if (!existsSync(options.scriptPath)) {
      throw new Error(`Sidecar script not found: ${options.scriptPath}`);
    }

    const args = [options.scriptPath, ...(options.args ?? [])];
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      process.stdout.write(`[desktop-sidecar] ${chunk}`);
    });
    child.stderr?.on("data", (chunk) => {
      process.stderr.write(`[desktop-sidecar] ${chunk}`);
    });

    this.child = child;
    this.startedAt = new Date();
    this.scriptPath = options.scriptPath;
  }

  async stop(graceMs = 3_000): Promise<void> {
    if (!this.child) return;
    const child = this.child;

    child.kill("SIGTERM");

    const started = Date.now();
    while (!child.killed && Date.now() - started < graceMs) {
      await wait(100);
    }

    if (!child.killed) {
      child.kill("SIGKILL");
    }

    this.child = null;
    this.startedAt = null;
    this.scriptPath = null;
  }
}
