#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const webDir = resolve(__dirname, "..");

function findNextServerEntry() {
  const candidates = [
    resolve(webDir, ".next", "standalone", "packages", "web", "server.js"),
    resolve(webDir, ".next", "standalone", "server.js"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function requirePath(path, label) {
  if (!existsSync(path)) {
    console.error(`[Dashboard] Missing ${label}: ${path}`);
    process.exit(1);
  }
  return path;
}

const nextServer = findNextServerEntry();
if (!nextServer) {
  console.error("[Dashboard] Could not find a built Next standalone server.");
  process.exit(1);
}

const terminalServer = requirePath(
  resolve(webDir, "dist", "server", "terminal-websocket.js"),
  "terminal server build output",
);
const directTerminalServer = requirePath(
  resolve(webDir, "dist", "server", "direct-terminal-ws.js"),
  "direct terminal server build output",
);

const nextEnv = {
  ...process.env,
  HOSTNAME: process.env.HOSTNAME ?? "0.0.0.0",
};

const services = [
  {
    name: "next",
    child: spawn(process.execPath, [nextServer], {
      cwd: webDir,
      env: nextEnv,
      stdio: "inherit",
    }),
  },
  {
    name: "terminal",
    child: spawn(process.execPath, [terminalServer], {
      cwd: webDir,
      env: process.env,
      stdio: "inherit",
    }),
  },
  {
    name: "direct-terminal",
    child: spawn(process.execPath, [directTerminalServer], {
      cwd: webDir,
      env: process.env,
      stdio: "inherit",
    }),
  },
];

let shuttingDown = false;

function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const { child } of services) {
    if (child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
    }
  }

  const forceExitTimer = setTimeout(() => {
    for (const { child } of services) {
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGKILL");
      }
    }
    process.exit(exitCode);
  }, 5000);
  forceExitTimer.unref();

  Promise.all(
    services.map(
      ({ child }) =>
        new Promise((resolveChild) => {
          if (child.exitCode !== null || child.killed) {
            resolveChild();
            return;
          }
          child.once("exit", () => resolveChild());
        }),
    ),
  ).finally(() => {
    process.exit(exitCode);
  });
}

for (const { name, child } of services) {
  child.once("error", (err) => {
    console.error(`[Dashboard] Failed to start ${name}: ${err.message}`);
    shutdown(1);
  });

  child.once("exit", (code, signal) => {
    if (shuttingDown) return;
    const exitCode = code ?? (signal ? 1 : 0);
    if (exitCode !== 0) {
      console.error(
        `[Dashboard] ${name} exited ${signal ? `via ${signal}` : `with code ${exitCode}`}`,
      );
    }
    shutdown(exitCode);
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
