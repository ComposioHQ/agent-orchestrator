#!/usr/bin/env node
/**
 * check-css-tokens.mjs
 * -----------------------------------------------------------------------------
 * Scan packages/web/src/app/globals.css for `--color-*` (and optionally any
 * `--*`) custom-property definitions and report tokens that are never
 * referenced anywhere in the web package source or DESIGN.md.
 *
 * Also flags multiple tokens that resolve to the same literal value (likely
 * duplicates). Intentionally dependency-free (pure Node stdlib) so it can run
 * in CI without extra install overhead.
 *
 * Usage:
 *   node scripts/check-css-tokens.mjs            # warn-only, always exits 0
 *   node scripts/check-css-tokens.mjs --strict   # exit 1 on dead/duplicate
 *   node scripts/check-css-tokens.mjs --all      # scan every --* token
 *   node scripts/check-css-tokens.mjs --json     # emit machine-readable JSON
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WEB_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(WEB_ROOT, "..", "..");

const CSS_FILE = resolve(WEB_ROOT, "src/app/globals.css");
const SOURCE_DIR = resolve(WEB_ROOT, "src");
const DESIGN_DOC = resolve(REPO_ROOT, "DESIGN.md");

const SEARCH_EXTS = new Set([".tsx", ".ts", ".jsx", ".js", ".mjs", ".css", ".md"]);
const IGNORE_DIRS = new Set(["node_modules", ".next", "dist", "dist-server", "coverage"]);

const args = new Set(process.argv.slice(2));
const STRICT = args.has("--strict");
const ALL_TOKENS = args.has("--all");
const JSON_OUT = args.has("--json");

const TOKEN_PREFIX = ALL_TOKENS ? "--" : "--color-";

/**
 * Parse `--foo: value;` definitions from CSS, returning a map of
 * token name -> array of { value, scope } entries (because a token can be
 * redefined under :root vs .dark vs @theme).
 */
function parseTokenDefinitions(cssText) {
  const defs = new Map();
  // Track which scope block we're in so duplicate-value detection can be
  // scoped (light vs dark) instead of bleeding across modes.
  const scopeStack = ["root"];
  let depth = 0;

  // Strip comments to avoid false matches inside doc examples.
  const stripped = cssText.replace(/\/\*[\s\S]*?\*\//g, "");

  // Walk line by line; good enough since the file uses one declaration
  // per line and blocks open/close on their own lines.
  const lines = stripped.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();

    // Detect block openers (e.g. ":root {", ".dark {", "@theme {", "@theme inline {")
    const openerMatch = trimmed.match(/^(@theme(?:\s+inline)?|:root|\.dark|@media[^{]*)\s*\{/);
    if (openerMatch) {
      depth += 1;
      scopeStack.push(openerMatch[1].startsWith(".dark") ? "dark" : "root");
      continue;
    }

    // Count braces to track nesting generically.
    const opens = (trimmed.match(/\{/g) || []).length;
    const closes = (trimmed.match(/\}/g) || []).length;
    if (opens !== closes) {
      depth += opens - closes;
      if (closes > opens && scopeStack.length > 1) scopeStack.pop();
    }

    const defMatch = trimmed.match(/^(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/);
    if (!defMatch) continue;
    const [, name, rawValue] = defMatch;
    if (!name.startsWith(TOKEN_PREFIX)) continue;
    const scope = scopeStack[scopeStack.length - 1] || "root";
    const value = rawValue.trim();
    if (!defs.has(name)) defs.set(name, []);
    defs.get(name).push({ value, scope });
  }
  return defs;
}

function walkFiles(startPath) {
  const out = [];
  const stat = statSync(startPath, { throwIfNoEntry: false });
  if (!stat) return out;
  if (stat.isFile()) {
    if (SEARCH_EXTS.has(extname(startPath))) out.push(startPath);
    return out;
  }
  for (const entry of readdirSync(startPath, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = join(startPath, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (entry.isFile() && SEARCH_EXTS.has(extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Count references to each token across the given files, excluding the
 * token's own definition lines in globals.css (a token defining itself
 * does not count as "used").
 */
function countReferences(tokenNames, files) {
  const refs = new Map();
  for (const name of tokenNames) refs.set(name, 0);

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const isCssTokens = file === CSS_FILE;
    for (const name of tokenNames) {
      // Find every occurrence of the token name in the file.
      let idx = 0;
      let count = 0;
      while ((idx = text.indexOf(name, idx)) !== -1) {
        // Ensure word-boundary-like behaviour so `--color-bg` doesn't match
        // `--color-bg-surface`.
        const nextChar = text[idx + name.length];
        const isBoundary = !nextChar || !/[a-zA-Z0-9_-]/.test(nextChar);
        if (isBoundary) {
          if (isCssTokens) {
            // Skip self-definition lines: `  --name: value;`
            const lineStart = text.lastIndexOf("\n", idx) + 1;
            const lineEnd = text.indexOf("\n", idx);
            const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
            const isDefLine = new RegExp(`^\\s*${name}\\s*:`).test(line);
            if (!isDefLine) count += 1;
          } else {
            count += 1;
          }
        }
        idx += name.length;
      }
      refs.set(name, refs.get(name) + count);
    }
  }
  return refs;
}

function findDuplicateValues(defs) {
  // Group by (scope, normalizedValue). A token that resolves to var(--other)
  // is an alias, not a duplicate — skip those.
  const byScopeValue = new Map();
  for (const [name, entries] of defs) {
    for (const { value, scope } of entries) {
      const normalized = value.replace(/\s+/g, "").toLowerCase();
      if (normalized.startsWith("var(")) continue;
      if (normalized === "transparent" || normalized === "inherit" || normalized === "none") {
        continue;
      }
      const key = `${scope}::${normalized}`;
      if (!byScopeValue.has(key)) byScopeValue.set(key, []);
      byScopeValue.get(key).push(name);
    }
  }
  const duplicates = [];
  for (const [key, names] of byScopeValue) {
    const unique = [...new Set(names)];
    if (unique.length > 1) {
      const [scope, value] = key.split("::");
      duplicates.push({ scope, value, tokens: unique.sort() });
    }
  }
  return duplicates;
}

function main() {
  const cssText = readFileSync(CSS_FILE, "utf8");
  const defs = parseTokenDefinitions(cssText);
  const tokenNames = [...defs.keys()].sort();

  const searchFiles = walkFiles(SOURCE_DIR);
  searchFiles.push(CSS_FILE);
  try {
    if (statSync(DESIGN_DOC).isFile()) searchFiles.push(DESIGN_DOC);
  } catch {
    // DESIGN.md is optional.
  }

  const refs = countReferences(tokenNames, searchFiles);
  const dead = tokenNames.filter((name) => (refs.get(name) ?? 0) === 0);
  const duplicates = findDuplicateValues(defs);

  if (JSON_OUT) {
    const counts = Object.fromEntries(refs);
    process.stdout.write(
      JSON.stringify(
        { total: tokenNames.length, dead, duplicates, referenceCounts: counts },
        null,
        2,
      ) + "\n",
    );
  } else {
    printHuman({ total: tokenNames.length, dead, duplicates, refs });
  }

  const hasIssues = dead.length > 0 || duplicates.length > 0;
  if (STRICT && hasIssues) {
    process.exit(1);
  }
}

function printHuman({ total, dead, duplicates, refs }) {
  const out = process.stdout;
  out.write(`CSS token audit — ${CSS_FILE.replace(REPO_ROOT + "/", "")}\n`);
  out.write(`  Scanned ${total} tokens matching "${TOKEN_PREFIX}*"\n`);
  out.write(`  Dead tokens: ${dead.length}\n`);
  out.write(`  Duplicate-value groups: ${duplicates.length}\n\n`);

  if (dead.length) {
    out.write("── Dead tokens (defined, zero references) ─────────────────────\n");
    for (const name of dead) out.write(`  ${name}\n`);
    out.write("\n");
  }

  if (duplicates.length) {
    out.write("── Duplicate values (possible consolidation targets) ──────────\n");
    for (const { scope, value, tokens } of duplicates) {
      out.write(`  [${scope}] ${value}\n`);
      for (const t of tokens) out.write(`      ${t} (refs: ${refs.get(t) ?? 0})\n`);
    }
    out.write("\n");
  }

  if (!dead.length && !duplicates.length) {
    out.write("✓ No dead or duplicate color tokens found.\n");
  } else if (!STRICT) {
    out.write(
      "ℹ  Warn-only mode. Re-run with --strict to fail on findings once the baseline is clean.\n",
    );
  }
}

main();
