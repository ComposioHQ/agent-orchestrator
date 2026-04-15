#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, process, __dirname, __filename */

const { spawn } = require("node:child_process");
const { createRequire } = require("node:module");
const { dirname, resolve } = require("node:path");
const { existsSync } = require("node:fs");

const mode = process.argv[2];

if (mode !== "dev" && mode !== "start") {
  process.stderr.write("Usage: node scripts/run-next.cjs <dev|start>\n");
  process.exit(1);
}

function normalizeEnvValue(value, fallback) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function resolveHosts(env) {
  const dashboardHost = normalizeEnvValue(
    env.AO_DASHBOARD_HOST ?? env.HOST,
    "127.0.0.1",
  );
  const directTerminalHost = normalizeEnvValue(
    env.AO_DIRECT_TERMINAL_HOST ?? dashboardHost,
    "127.0.0.1",
  );

  return { dashboardHost, directTerminalHost };
}

function resolveNextCommand() {
  const localBin = resolve(
    __dirname,
    "..",
    "node_modules",
    ".bin",
    process.platform === "win32" ? "next.cmd" : "next",
  );

  if (existsSync(localBin)) {
    return { command: localBin, prefixArgs: [] };
  }

  const requireFromHere = createRequire(__filename);

  try {
    const nextPkg = requireFromHere.resolve("next/package.json");
    return {
      command: process.execPath,
      prefixArgs: [resolve(dirname(nextPkg), "dist", "bin", "next")],
    };
  } catch {
    return {
      command: process.platform === "win32" ? "next.cmd" : "next",
      prefixArgs: [],
    };
  }
}

const port = normalizeEnvValue(process.env.PORT, "3000");
const { dashboardHost, directTerminalHost } = resolveHosts(process.env);
const { command, prefixArgs } = resolveNextCommand();
const childEnv = {
  ...process.env,
  PORT: port,
  HOST: dashboardHost,
  AO_DASHBOARD_HOST: dashboardHost,
  AO_DIRECT_TERMINAL_HOST: directTerminalHost,
  NEXT_PUBLIC_DIRECT_TERMINAL_HOST: directTerminalHost,
};

const child = spawn(
  command,
  [...prefixArgs, mode, "-H", dashboardHost, "-p", port],
  { stdio: "inherit", env: childEnv },
);

child.on("error", (error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
