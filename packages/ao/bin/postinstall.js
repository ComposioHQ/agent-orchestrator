#!/usr/bin/env node
/**
 * Postinstall script for @composio/ao (npm/yarn global installs).
 *
 * Fixes node-pty's spawn-helper binary missing the execute bit.
 * node-pty@1.1.0 ships spawn-helper without +x; the monorepo works around
 * this via scripts/rebuild-node-pty.js, but that never runs for global installs.
 *
 * Upstream fix: microsoft/node-pty#866 (only in 1.2.0-beta, not stable yet).
 */

import { chmodSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// No-op on Windows — different PTY mechanism
if (process.platform === "win32") process.exit(0);

const __dirname = dirname(fileURLToPath(import.meta.url));

function findPackageUp(startDir, ...segments) {
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

const nodePtyDir = findPackageUp(__dirname, "node-pty");
if (!nodePtyDir) process.exit(0);

const spawnHelper = resolve(
  nodePtyDir,
  "prebuilds",
  `${process.platform}-${process.arch}`,
  "spawn-helper",
);

if (!existsSync(spawnHelper)) process.exit(0);

try {
  chmodSync(spawnHelper, 0o755);
  console.log("\u2713 node-pty spawn-helper permissions set");
} catch {
  console.warn("\u26a0\ufe0f  Could not set spawn-helper permissions (non-critical)");
}
