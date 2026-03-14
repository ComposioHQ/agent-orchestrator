/**
 * Production entry point — starts Next.js + terminal servers.
 * Used by `ao start` when running from an npm install (no monorepo).
 * Replaces the dev-only `concurrently` setup.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve paths relative to the package root (one level up from dist-server/)
const pkgRoot = resolve(__dirname, "..");

const children: ChildProcess[] = [];

function log(label: string, msg: string): void {
  process.stdout.write(`[${label}] ${msg}\n`);
}

function spawnProcess(label: string, command: string, args: string[]): ChildProcess {
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
  });

  children.push(child);
  return child;
}

// Start Next.js production server (use local binary, not npx, to avoid slow global lookup)
const port = process.env["PORT"] || "3000";
const nextBin = resolve(pkgRoot, "node_modules", ".bin", "next");
spawnProcess("next", nextBin, ["start", "-p", port]);

// Start terminal WebSocket server
spawnProcess("terminal", "node", [resolve(__dirname, "terminal-websocket.js")]);

// Start direct terminal WebSocket server
spawnProcess("direct-terminal", "node", [resolve(__dirname, "direct-terminal-ws.js")]);

// Graceful shutdown
function cleanup(): void {
  for (const child of children) {
    child.kill();
  }
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
