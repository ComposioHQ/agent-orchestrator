#!/usr/bin/env node
/**
 * Postbuild step for @aoagents/ao-core: copy prompt template YAML files
 * from src/prompts/templates/ to dist/prompts/templates/.
 *
 * tsc does not copy non-TS assets. This script is invoked after `tsc` in
 * the core package's build script.
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const coreRoot = resolve(__dirname, "..", "packages", "core");
const srcDir = join(coreRoot, "src", "prompts", "templates");
const dstDir = join(coreRoot, "dist", "prompts", "templates");

if (!existsSync(srcDir)) {
  console.warn(`[copy-prompt-templates] src dir missing: ${srcDir}`);
  process.exit(0);
}

mkdirSync(dstDir, { recursive: true });
cpSync(srcDir, dstDir, { recursive: true });

const copied = readdirSync(dstDir);
console.log(`[copy-prompt-templates] copied ${copied.length} files → ${dstDir}`);
