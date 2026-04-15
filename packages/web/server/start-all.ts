/**
 * Production entry point — starts Next.js + terminal servers.
 * Used by `ao start` when running from an npm install (no monorepo).
 * Replaces the dev-only `concurrently` setup.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve paths relative to the package root (one level up from dist-server/)
const pkgRoot = resolve(__dirname, "..");

const children: ChildProcess[] = [];
const DEFAULT_DASHBOARD_HOST = "127.0.0.1";
const DEFAULT_DIRECT_TERMINAL_HOST = "127.0.0.1";

function log(label: string, msg: string): void {
  process.stdout.write(`[${label}] ${msg}\n`);
}

function normalizeBindHost(input: string | undefined, fallback: string): string {
  const trimmed = input?.trim();
  return trimmed ? trimmed : fallback;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().replace(/^\[(.*)\]$/, "$1").toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function spawnProcess(
  label: string,
  command: string,
  args: string[],
  opts?: { restart?: boolean; maxRestarts?: number },
): ChildProcess {
  let restarts = 0;
  const maxRestarts = opts?.maxRestarts ?? 3;
  let slotIndex = -1;

  function launch(): ChildProcess {
    const child = spawn(command, args, {
      cwd: pkgRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    child.stdout?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n").filter(Boolean)) {
        log(label, line);
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n").filter(Boolean)) {
        log(label, line);
      }
    });

    child.on("exit", (code) => {
      log(label, `exited with code ${code}`);
      if (!shuttingDown && opts?.restart && code !== 0 && restarts < maxRestarts) {
        restarts++;
        log(label, `restarting (attempt ${restarts}/${maxRestarts})`);
        const replacement = launch();
        // Replace in-place — slot was assigned on first push
        children[slotIndex] = replacement;
      }
    });

    // Only push on first launch; restarts replace the existing slot
    if (slotIndex === -1) {
      slotIndex = children.length;
      children.push(child);
    }

    return child;
  }

  return launch();
}

/**
 * Resolve the `next` CLI binary path.
 * Tries the local .bin shim first (fast), then falls back to require.resolve (hoisted deps).
 */
function resolveNextBin(): string {
  const localBin = resolve(pkgRoot, "node_modules", ".bin", "next");
  if (existsSync(localBin)) return localBin;

  // Hoisted node_modules — resolve the actual next CLI entry
  const require = createRequire(resolve(pkgRoot, "package.json"));
  try {
    const nextPkg = require.resolve("next/package.json");
    return resolve(dirname(nextPkg), "dist", "bin", "next");
  } catch {
    // Last resort — rely on PATH
    return "next";
  }
}

// Start Next.js production server
const port = process.env["PORT"] || "3000";
const dashboardHost = normalizeBindHost(
  process.env["AO_DASHBOARD_HOST"] ?? process.env["HOST"],
  DEFAULT_DASHBOARD_HOST,
);
const directTerminalHost = normalizeBindHost(
  process.env["AO_DIRECT_TERMINAL_HOST"] ?? dashboardHost,
  DEFAULT_DIRECT_TERMINAL_HOST,
);

if (!isLoopbackHost(dashboardHost)) {
  log(
    "start-all",
    `Security warning: dashboard HTTP API is bound to ${dashboardHost} without built-in auth.`,
  );
}

if (!isLoopbackHost(directTerminalHost)) {
  log(
    "start-all",
    `Security warning: direct terminal WebSocket is bound to ${directTerminalHost} without built-in auth.`,
  );
}

spawnProcess("next", resolveNextBin(), ["start", "-p", port, "-H", dashboardHost]);

// Start direct terminal WebSocket server (auto-restart on crash)
spawnProcess("direct-terminal", "node", [resolve(__dirname, "direct-terminal-ws.js")], { restart: true });

// Graceful shutdown — send SIGTERM to children and wait for them to exit
let shuttingDown = false;

function cleanup(): void {
  if (shuttingDown) return;
  shuttingDown = true;

  let alive = children.length;
  if (alive === 0) {
    process.exit(0);
    return;
  }

  // Force exit after 5s if children don't exit cleanly
  const forceTimer = setTimeout(() => {
    log("start-all", "Children did not exit in time, forcing shutdown");
    process.exit(1);
  }, 5000);
  forceTimer.unref();

  for (const child of children) {
    child.on("exit", () => {
      alive--;
      if (alive <= 0) {
        clearTimeout(forceTimer);
        process.exit(0);
      }
    });
    child.kill("SIGTERM");
  }
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
