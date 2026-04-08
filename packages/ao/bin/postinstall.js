#!/usr/bin/env node
/**
 * Postinstall script for @composio/ao (npm/yarn global installs).
 *
 * 1. Fixes node-pty's spawn-helper binary missing the execute bit.
 *    node-pty@1.1.0 ships spawn-helper without +x; the monorepo works around
 *    this via scripts/rebuild-node-pty.js, but that never runs for global installs.
 *    Upstream fix: microsoft/node-pty#866 (only in 1.2.0-beta, not stable yet).
 *
 * 2. Clears stale Next.js runtime cache (.next/cache) from @composio/ao-web
 *    after a version upgrade, so `ao start` serves fresh dashboard assets.
 *    Writes a version stamp (.next/AO_VERSION) to skip cleanup on subsequent runs.
 */

import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

// --- 1. Fix node-pty spawn-helper permissions (non-Windows only) ---
if (process.platform !== "win32") {
  const nodePtyDir = findPackageUp(__dirname, "node-pty");
  if (nodePtyDir) {
    const spawnHelper = resolve(
      nodePtyDir,
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "spawn-helper",
    );
    if (existsSync(spawnHelper)) {
      try {
        chmodSync(spawnHelper, 0o755);
        console.log("\u2713 node-pty spawn-helper permissions set");
      } catch {
        console.warn("\u26a0\ufe0f  Could not set spawn-helper permissions (non-critical)");
      }
    }
  }
}

// --- 2. Clear stale Next.js runtime cache after version upgrade ---
try {
  const webDir = findPackageUp(__dirname, "@composio", "ao-web");
  if (webDir) {
    const pkgPath = resolve(webDir, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      const version = pkg.version;
      const cacheDir = resolve(webDir, ".next", "cache");
      const stampPath = resolve(webDir, ".next", "AO_VERSION");

      if (existsSync(cacheDir)) {
        rmSync(cacheDir, { recursive: true, force: true });
        console.log("\u2713 Cleared stale .next/cache");
      }
      if (existsSync(resolve(webDir, ".next"))) {
        writeFileSync(stampPath, version, "utf8");
        console.log(`\u2713 Dashboard version stamp set to ${version}`);
      }
    }
  }
} catch (err) {
  console.warn(`\u26a0\ufe0f  Could not clear dashboard cache (non-critical): ${err.message}`);
}
