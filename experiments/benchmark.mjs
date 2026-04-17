#!/usr/bin/env node
// benchmark.mjs — GH Rate-Limit Benchmark Harness
// Three modes: setup (spawn sessions), measure (trace + scorecard), report (recompute from trace)
// Node.js stdlib only, shells out to AO CLI and gh CLI.

import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, unlinkSync, symlinkSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// ─── Constants ────────────────────────────────────────────────────────────────

const BENCHMARK_VERSION = "0.1.0";
const SCHEMA_VERSION = 1;

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, "out");
const AO_CLI = resolve(__dirname, "../packages/cli/dist/index.js");

// ANSI escape sequences
const ANSI = {
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
};

const isTTY = process.stdout.isTTY;

// ─── CLI Arg Parser ────────────────────────────────────────────────────────────

/**
 * Parses process.argv into { mode, flags }.
 * Positional args beyond argv[2] are the mode (first) and any extra positionals.
 * --key value pairs populate flags as { key: value }.
 * --key (no following value or next is another flag) becomes { key: true }.
 */
function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = {};
  let mode = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (mode === null) {
      mode = arg;
    }
    // additional positionals after mode are ignored for now
  }

  return { mode, flags };
}

// ─── Usage / Help ──────────────────────────────────────────────────────────────

function usage() {
  const u = (s) => console.error(s);
  u("");
  u(`  GH Rate-Limit Benchmark Harness  v${BENCHMARK_VERSION}`);
  u("");
  u("  Usage:");
  u("    node experiments/benchmark.mjs <mode> [options]");
  u("");
  u("  Modes:");
  u("");
  u("    setup    One-time: spawn N sessions, wait for PRs, kill agents, write setup artifact.");
  u("             Options:");
  u("               --project <name>         Project name in agent-orchestrator.yaml (required)");
  u("               --sessions <n>           Number of sessions to spawn (required)");
  u("               --issues <1,2,3,...>     Comma-separated issue numbers (required, count must match --sessions)");
  u("");
  u("    measure  Repeatable: start AO, warmup, measure for a fixed window, print scorecard.");
  u("             Options:");
  u("               --project <name>         Project name (required)");
  u("               --sessions <n>           Session count — resolves setup artifact (required)");
  u("               --duration <d>           Measurement window length, e.g. 15m (required)");
  u("               --warmup <d>             Warmup before measurement, e.g. 2m (default: 2m)");
  u("");
  u("    report   Offline: regenerate scorecard from an existing trace file.");
  u("             Options:");
  u("               --trace <path>           Path to JSONL trace file (required)");
  u("               --warmup-end <ISO ts>    Exclude rows before this timestamp (optional)");
  u("");
  u("  Examples:");
  u("    node experiments/benchmark.mjs setup --project todo-app --sessions 5 --issues 1,2,3,4,5");
  u("    node experiments/benchmark.mjs measure --project todo-app --sessions 5 --duration 15m");
  u("    node experiments/benchmark.mjs report --trace experiments/out/gh-trace-bench-1776400000.jsonl");
  u("");
}

// ─── die ──────────────────────────────────────────────────────────────────────

function die(msg) {
  console.error(`${ANSI.red}ERROR:${ANSI.reset} ${msg}`);
  process.exit(1);
}

// ─── Shared Utilities ──────────────────────────────────────────────────────────

const execFileAsync = promisify(execFile);

/**
 * Parses duration strings like "2m", "15m", "1h", "30s" into milliseconds.
 */
function parseDuration(str) {
  if (typeof str !== "string") die(`parseDuration: expected string, got ${typeof str}`);
  const m = str.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/i);
  if (!m) die(`Invalid duration format: "${str}". Expected e.g. "30s", "2m", "1h", "500ms"`);
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  switch (unit) {
    case "ms": return n;
    case "s":  return n * 1000;
    case "m":  return n * 60 * 1000;
    case "h":  return n * 60 * 60 * 1000;
    default:   die(`Unrecognised duration unit: "${unit}"`);
  }
}

/**
 * Wraps execFileAsync. Returns stdout trimmed.
 * opts: { timeout (ms, default 30000), cwd, env }
 */
async function run(cmd, args = [], opts = {}) {
  const { timeout = 30_000, cwd, env } = opts;
  const { stdout } = await execFileAsync(cmd, args, {
    timeout,
    cwd,
    env: env ?? process.env,
    maxBuffer: 10 * 1024 * 1024, // 10 MB
  });
  return stdout.trim();
}

/**
 * Calls `gh` CLI without AO_GH_TRACE_FILE in the environment,
 * so benchmark-control calls don't pollute the trace being measured.
 */
async function ghControl(args = [], opts = {}) {
  const env = { ...process.env };
  delete env.AO_GH_TRACE_FILE;
  delete env.AO_GH_TRACE;
  return run("gh", args, { ...opts, env });
}

/**
 * Returns the short git SHA of HEAD, or "unknown" on error.
 */
function gitSha() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * Returns the current git branch name, or "unknown" on error.
 */
function gitBranch() {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * Finds agent-orchestrator.yaml by:
 * 1. AO_CONFIG_PATH env var
 * 2. Walk up from cwd
 * 3. Check ~/agent-orchestrator.yaml / .yml
 * Returns path or null.
 */
function findConfig() {
  // 1. env var
  if (process.env.AO_CONFIG_PATH) {
    const p = resolve(process.env.AO_CONFIG_PATH);
    if (existsSync(p)) return p;
  }

  // 2. walk up from cwd
  const names = ["agent-orchestrator.yaml", "agent-orchestrator.yml"];
  let dir = process.cwd();
  const root = resolve("/");
  while (dir !== root) {
    for (const name of names) {
      const p = join(dir, name);
      if (existsSync(p)) return p;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }

  // 3. home directory
  const home = homedir();
  for (const name of names) {
    const p = join(home, name);
    if (existsSync(p)) return p;
  }

  return null;
}

/**
 * Reads agent-orchestrator.yaml and extracts the named project block.
 * Uses a simple line-based parser (no YAML library).
 *
 * Config format:
 *   projects:
 *     todo-app:
 *       repo: illegalcall/todo-app
 *       path: ~/Development/todo-app
 *       defaultBranch: main
 *
 * The project name is the YAML key under `projects:`, not a `name:` field.
 * Returns { repo, path, defaultBranch, sessionPrefix } or dies.
 */
function loadProjectConfig(projectName) {
  const configPath = findConfig();
  if (!configPath) die("Could not find agent-orchestrator.yaml. Set AO_CONFIG_PATH or run from project root.");

  const text = readFileSync(configPath, "utf-8");
  const lines = text.split("\n");

  // Find `projects:` section, then find `  projectName:` key under it
  let inProjects = false;
  let inTarget = false;
  let targetIndent = 0;
  const config = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const currentIndent = line.length - trimmed.length;

    // Detect `projects:` block
    if (trimmed === "projects:" || trimmed.startsWith("projects: ")) {
      inProjects = true;
      continue;
    }

    if (inProjects && !inTarget) {
      // Look for the project key: `  todo-app:` (key followed by colon)
      const keyMatch = trimmed.match(/^([\w-]+)\s*:\s*$/);
      if (keyMatch && keyMatch[1] === projectName) {
        inTarget = true;
        targetIndent = currentIndent;
        continue;
      }
      // If we hit a non-indented line, we left the projects block
      if (currentIndent === 0 && trimmed.length > 0 && !trimmed.startsWith("#")) {
        inProjects = false;
      }
    }

    if (inTarget) {
      // If we de-dented to or past the project key level, we're done
      if (currentIndent <= targetIndent && trimmed.length > 0) break;

      const kvMatch = trimmed.match(/^([\w-]+)\s*:\s*(.+)$/);
      if (kvMatch) {
        config[kvMatch[1]] = kvMatch[2].replace(/^["']|["']$/g, "").trim();
      }
    }
  }

  const repo = config.repo;
  const rawPath = config.path;
  const defaultBranch = config.defaultBranch || "main";
  const sessionPrefix = config.sessionPrefix || projectName;

  if (!repo) die(`Project "${projectName}" not found in config or missing "repo" field`);
  if (!rawPath) die(`Project "${projectName}" missing "path" field in config`);

  const projectPath = rawPath.startsWith("~/")
    ? join(homedir(), rawPath.slice(2))
    : rawPath;

  return { repo, path: projectPath, defaultBranch, sessionPrefix };
}

/**
 * Returns the value at percentile p (0–100) from a sorted numeric array.
 * Does NOT sort the array — caller must pre-sort.
 */
function percentile(sortedArr, p) {
  if (!sortedArr || sortedArr.length === 0) return null;
  if (p <= 0) return sortedArr[0];
  if (p >= 100) return sortedArr[sortedArr.length - 1];
  const idx = (p / 100) * (sortedArr.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sortedArr[lower];
  const frac = idx - lower;
  return sortedArr[lower] * (1 - frac) + sortedArr[upper] * frac;
}

/**
 * Formats a number with commas.
 */
function fmt(n) {
  if (n == null) return "N/A";
  return Number(n).toLocaleString("en-US");
}

/**
 * Ensures OUT_DIR exists.
 */
function ensureOutDir() {
  mkdirSync(OUT_DIR, { recursive: true });
}

// ─── Scorecard Computation Engine ─────────────────────────────────────────────

/**
 * Reads a JSONL file and returns an array of parsed row objects.
 * Dies if the file does not exist or cannot be parsed.
 */
function readTrace(tracePath) {
  if (!existsSync(tracePath)) die(`Trace file not found: ${tracePath}`);
  const text = readFileSync(tracePath, "utf-8");
  const rows = [];
  let lineNum = 0;
  for (const line of text.split("\n")) {
    lineNum++;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch (err) {
      console.error(`Warning: skipping malformed JSON at line ${lineNum}: ${err.message}`);
    }
  }
  return rows;
}

/**
 * Computes the burn rate for a given rate-limit resource over the measurement window.
 *
 * @param {object[]} rows - All trace rows (pre-filtered to the window)
 * @param {string} resource - "core" | "graphql" | ...
 * @param {number} windowDurationMs - Duration of the measurement window in ms
 * @returns {{ pointsPerHr, estimated, straddled, windows }} or null if <2 data rows
 */
function computeBurnRate(rows, resource, windowDurationMs) {
  const relevant = rows.filter(
    (r) =>
      typeof r.rateLimitRemaining === "number" &&
      r.rateLimitResource === resource,
  );

  if (relevant.length < 2) return null;

  // Group by rateLimitReset epoch
  const byReset = new Map();
  for (const r of relevant) {
    const key = r.rateLimitReset ?? "unknown";
    if (!byReset.has(key)) byReset.set(key, []);
    byReset.get(key).push(r);
  }

  const straddled = byReset.size > 1;
  let totalDelta = 0;
  const windowDetails = [];

  // For each reset window: delta = first.remaining - last.remaining (consumed = decrease)
  for (const [resetKey, windowRows] of byReset) {
    // Sort by timestamp within the window
    windowRows.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const first = windowRows[0];
    const last = windowRows[windowRows.length - 1];
    const delta = first.rateLimitRemaining - last.rateLimitRemaining;
    // delta > 0: we consumed quota; delta < 0: could indicate a reset boundary artifact
    // Only count positive deltas (actual consumption)
    const consumption = Math.max(0, delta);
    totalDelta += consumption;
    windowDetails.push({
      resetEpoch: resetKey,
      firstRemaining: first.rateLimitRemaining,
      lastRemaining: last.rateLimitRemaining,
      delta: consumption,
      rows: windowRows.length,
    });
  }

  // Normalize to per-hour using the actual measurement window duration
  const pointsPerHr = windowDurationMs > 0
    ? Math.round((totalDelta / windowDurationMs) * 3_600_000)
    : 0;

  return {
    pointsPerHr,
    estimated: false,
    straddled,
    windows: windowDetails,
  };
}

/**
 * Computes the full scorecard from a trace.
 *
 * @param {object[]} allRows - All rows from readTrace()
 * @param {string} windowStart - ISO timestamp, start of measurement window
 * @param {string} windowEnd - ISO timestamp, end of measurement window
 * @param {object|null} snapshots - { before: { core, graphql }, after: { core, graphql } } from gh api rate_limit
 * @param {number} benchmarkControlCalls - Count of ghControl() calls made by this harness
 * @returns {object} scorecard metrics matching spec schema
 */
function computeScorecard(allRows, windowStart, windowEnd, snapshots, benchmarkControlCalls) {
  const startMs = new Date(windowStart).getTime();
  const endMs = new Date(windowEnd).getTime();
  const windowDurationMs = endMs - startMs;

  // Filter to measurement window, excluding benchmark-control rows
  const rows = allRows.filter((r) => {
    const ts = r.timestamp ? new Date(r.timestamp).getTime() : 0;
    if (ts < startMs || ts > endMs) return false;
    if (r.component === "benchmark-control") return false;
    return true;
  });

  // ── Total calls ──────────────────────────────────────────────────────────
  const totalCalls = rows.length;
  const callsPerMin = windowDurationMs > 0
    ? parseFloat((totalCalls / (windowDurationMs / 60_000)).toFixed(1))
    : 0;

  // ── GraphQL points/hr ────────────────────────────────────────────────────
  let graphqlPointsPerHr = 0;
  let graphqlPointsPerHrEstimated = false;

  const gqlBurnRate = computeBurnRate(rows, "graphql", windowDurationMs);
  if (gqlBurnRate) {
    graphqlPointsPerHr = gqlBurnRate.pointsPerHr;
  } else if (snapshots) {
    // Fallback: bracket delta
    const delta = (snapshots.before?.graphql?.remaining ?? 0) - (snapshots.after?.graphql?.remaining ?? 0);
    if (delta > 0) {
      const durationHr = windowDurationMs / 3_600_000;
      graphqlPointsPerHr = durationHr > 0 ? Math.round(delta / durationHr) : 0;
      graphqlPointsPerHrEstimated = true;
    }
  }

  // ── REST core requests/hr ────────────────────────────────────────────────
  let restCoreRequestsPerHr = 0;
  let restCoreRequestsPerHrEstimated = false;

  const coreBurnRate = computeBurnRate(rows, "core", windowDurationMs);
  if (coreBurnRate) {
    restCoreRequestsPerHr = coreBurnRate.pointsPerHr;
  } else if (snapshots) {
    const delta = (snapshots.before?.core?.remaining ?? 0) - (snapshots.after?.core?.remaining ?? 0);
    if (delta > 0) {
      const durationHr = windowDurationMs / 3_600_000;
      restCoreRequestsPerHr = durationHr > 0 ? Math.round(delta / durationHr) : 0;
      restCoreRequestsPerHrEstimated = true;
    }
  }

  // ── graphql-batch count ──────────────────────────────────────────────────
  const graphqlBatchCount = rows.filter((r) => r.operation === "gh.api.graphql-batch").length;

  // ── guard-pr-list metrics ────────────────────────────────────────────────
  const guardPrListRows = rows.filter((r) => r.operation === "gh.api.guard-pr-list");
  const guardPrList304Count = guardPrListRows.filter((r) => r.httpStatus === 304).length;
  const guardPrListSuccessCount = guardPrListRows.filter((r) => r.ok && r.httpStatus !== 304).length;
  const guardPrListErrorCount = guardPrListRows.filter((r) => !r.ok && r.httpStatus !== 304).length;
  const guardPrListTotal = guardPrList304Count + guardPrListSuccessCount + guardPrListErrorCount;
  const guardPrList304Rate = guardPrListTotal > 0
    ? parseFloat((guardPrList304Count / guardPrListTotal).toFixed(3))
    : 0;

  // ── Opaque calls ─────────────────────────────────────────────────────────
  const opaqueCallCount = rows.filter((r) => r.httpStatus == null).length;
  const opaqueCallPct = totalCalls > 0
    ? parseFloat((opaqueCallCount / totalCalls).toFixed(2))
    : 0;

  // ── Bracket delta from snapshots ─────────────────────────────────────────
  const bracketDelta = { core: null, graphql: null };
  if (snapshots) {
    bracketDelta.core = (snapshots.before?.core?.remaining ?? 0) - (snapshots.after?.core?.remaining ?? 0);
    bracketDelta.graphql = (snapshots.before?.graphql?.remaining ?? 0) - (snapshots.after?.graphql?.remaining ?? 0);
  }

  // ── Percentile durations ─────────────────────────────────────────────────
  const durations = rows
    .map((r) => Number(r.durationMs))
    .filter((d) => !isNaN(d) && d >= 0)
    .sort((a, b) => a - b);

  // ── Resource windows ─────────────────────────────────────────────────────
  const resourceWindows = {
    graphql: gqlBurnRate
      ? { resetAt: gqlBurnRate.windows[0]?.resetEpoch ? new Date(gqlBurnRate.windows[0].resetEpoch * 1000).toISOString() : null, straddled: gqlBurnRate.straddled }
      : { resetAt: null, straddled: false },
    core: coreBurnRate
      ? { resetAt: coreBurnRate.windows[0]?.resetEpoch ? new Date(coreBurnRate.windows[0].resetEpoch * 1000).toISOString() : null, straddled: coreBurnRate.straddled }
      : { resetAt: null, straddled: false },
  };

  return {
    totalCalls,
    callsPerMin,
    graphqlPointsPerHr,
    graphqlPointsPerHrEstimated,
    restCoreRequestsPerHr,
    restCoreRequestsPerHrEstimated,
    graphqlBatchCount,
    guardPrList304Count,
    guardPrListErrorCount,
    guardPrList304Rate,
    opaqueCallCount,
    opaqueCallPct,
    bracketDelta,
    p50DurationMs: Math.round(percentile(durations, 50) ?? 0),
    p95DurationMs: Math.round(percentile(durations, 95) ?? 0),
    p99DurationMs: Math.round(percentile(durations, 99) ?? 0),
    benchmarkControlCalls: benchmarkControlCalls ?? null,
    resourceWindows,
  };
}

// ─── Console Output ────────────────────────────────────────────────────────────

const GQL_BUDGET = 5000;
const REST_BUDGET = 5000;

/**
 * Renders a progress bar using unicode block characters.
 * Color: green <50%, yellow 50–80%, red >80%.
 * Falls back to plain ASCII in non-TTY.
 *
 * @param {number} used
 * @param {number} budget
 * @param {number} width - Number of cells (default 20)
 * @returns {string}
 */
function budgetBar(used, budget, width = 20) {
  if (used == null || budget == null || budget === 0) return "".padEnd(width, "░");
  const ratio = Math.min(1, used / budget);
  const filled = Math.round(ratio * width);
  const empty = width - filled;

  const bar = "█".repeat(filled) + "░".repeat(empty);

  if (!isTTY) return bar;

  let color;
  if (ratio < 0.5) color = ANSI.green;
  else if (ratio < 0.8) color = ANSI.yellow;
  else color = ANSI.red;

  return `${color}${bar}${ANSI.reset}`;
}

/**
 * Prints the formatted scorecard to stdout (console.log).
 * All other output goes to stderr.
 *
 * @param {object} envelope - The full scorecard envelope
 */
function printScorecard(envelope) {
  const sc = envelope.scorecard ?? {};
  const divider = "═".repeat(59);

  const scenarioId = envelope.scenarioId ?? "report";
  const sha = envelope.gitSha ?? "unknown";
  const branch = envelope.branch ?? "unknown";
  const measuredAt = envelope.measuredAt ?? new Date().toISOString();
  const n = envelope.sessionCount ?? "?";
  const warmupStr = envelope.warmup?.requested ?? "none";
  const durationStr = envelope.window?.durationActual ?? envelope.window?.durationRequested ?? "?";

  console.log(`\n${divider}`);
  console.log("  GH Rate-Limit Benchmark");
  console.log(`  ${scenarioId} | ${sha} | ${branch}`);
  console.log(`  ${measuredAt} | warmup ${warmupStr} | measured ${durationStr} | ${n} sessions`);
  console.log(divider);

  console.log();
  console.log(`  Total GH calls:          ${fmt(sc.totalCalls).padStart(6)}`);
  console.log(`  Calls/min:               ${String(sc.callsPerMin ?? 0).padStart(6)}`);

  console.log();
  const gqlStr = fmt(sc.graphqlPointsPerHr).padStart(6);
  const gqlEst = sc.graphqlPointsPerHrEstimated ? " (estimated)" : "";
  console.log(`  GraphQL points/hr:     ${gqlStr}  / 5,000  ${budgetBar(sc.graphqlPointsPerHr, GQL_BUDGET)}  ${Math.round((sc.graphqlPointsPerHr / GQL_BUDGET) * 100)}%${gqlEst}`);

  const coreStr = fmt(sc.restCoreRequestsPerHr).padStart(6);
  const coreEst = sc.restCoreRequestsPerHrEstimated ? " (estimated)" : "";
  console.log(`  REST core requests/hr: ${coreStr}  / 5,000  ${budgetBar(sc.restCoreRequestsPerHr, REST_BUDGET)}  ${Math.round((sc.restCoreRequestsPerHr / REST_BUDGET) * 100)}%${coreEst}`);

  console.log();
  console.log(`  graphql-batch count:     ${fmt(sc.graphqlBatchCount).padStart(6)}`);
  console.log(`  guard-pr-list 304s:      ${fmt(sc.guardPrList304Count).padStart(6)}  (${(sc.guardPrList304Rate * 100).toFixed(1)}%)`);
  console.log(`  guard-pr-list errors:    ${fmt(sc.guardPrListErrorCount).padStart(6)}`);

  console.log();
  console.log(`  Opaque calls:            ${fmt(sc.opaqueCallCount).padStart(6)}  (${(sc.opaqueCallPct * 100).toFixed(1)}%)`);
  if (sc.bracketDelta?.core != null) {
    console.log(`  Bracket delta (core):    ${fmt(sc.bracketDelta.core).padStart(6)}`);
  }
  if (sc.bracketDelta?.graphql != null) {
    console.log(`  Bracket delta (graphql): ${fmt(sc.bracketDelta.graphql).padStart(6)}`);
  }

  console.log();
  console.log(`  p50 / p95 / p99:     ${fmt(sc.p50DurationMs)} / ${fmt(sc.p95DurationMs)} / ${fmt(sc.p99DurationMs)} ms`);

  console.log();
  if (envelope.trace) console.log(`  Trace:     ${envelope.trace}`);
  if (envelope.scorecardPath) console.log(`  Scorecard: ${envelope.scorecardPath}`);
  console.log(divider);

  if (sc.resourceWindows?.graphql?.straddled) {
    console.log(`  Warning: GraphQL window straddled a reset boundary — per-row burn is authoritative`);
  }
  if (sc.resourceWindows?.core?.straddled) {
    console.log(`  Warning: REST core window straddled a reset boundary — per-row burn is authoritative`);
  }
  console.log();
}

// ─── Mode Stubs ───────────────────────────────────────────────────────────────

/**
 * setup mode — provision test sessions and wait for them to reach pr_open.
 * Spawns N sessions against real issues, waits for PRs to appear, then tears
 * down agents and writes a setup artifact for `measure` to consume.
 */
async function runSetup(flags) {
  // ── 1. Parse and validate flags ──────────────────────────────────────────
  const { project, sessions: sessionsStr, issues: issuesStr } = flags;

  if (!project) die("setup requires --project <name>");
  if (!sessionsStr) die("setup requires --sessions <n>");
  if (!issuesStr) die("setup requires --issues <comma-separated issue numbers>");

  const sessionCount = parseInt(sessionsStr, 10);
  if (!Number.isInteger(sessionCount) || sessionCount <= 0)
    die(`--sessions must be a positive integer, got: ${sessionsStr}`);

  const issueNumbers = String(issuesStr)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (issueNumbers.length !== sessionCount)
    die(
      `--issues count (${issueNumbers.length}) must equal --sessions (${sessionCount})`,
    );

  // ── 2. Build scenario/artifact identifiers ───────────────────────────────
  const scenario = "quiet-steady";
  const topology = "single-repo";
  const scenarioId = `${scenario}.${topology}.${sessionCount}`;

  ensureOutDir();
  const artifactPath = resolve(
    OUT_DIR,
    `setup-${project}-${scenarioId}.json`,
  );

  // ── 3. Load project config ───────────────────────────────────────────────
  const projectConfig = loadProjectConfig(project);
  const { repo, path: projectPath } = projectConfig;

  // ── 4. Check for a valid existing artifact ───────────────────────────────
  if (existsSync(artifactPath)) {
    let existing;
    try {
      existing = JSON.parse(readFileSync(artifactPath, "utf-8"));
    } catch {
      existing = null;
    }

    if (existing?.ready === true && Array.isArray(existing.sessions)) {
      // Verify all worktrees are still present
      const allPresent = existing.sessions.every(
        (s) => s.worktreePath && existsSync(s.worktreePath),
      );
      if (allPresent) {
        console.error(
          `[setup] Reusing existing artifact: ${artifactPath} (all ${existing.sessions.length} worktrees present)`,
        );
        return;
      } else {
        console.error(
          `[setup] Warning: existing artifact has missing worktrees — re-running setup`,
        );
      }
    }
  }

  // ── 5. Start AO ──────────────────────────────────────────────────────────
  console.error(`[setup] Starting AO for project "${project}"...`);

  // Strip AO_GH_TRACE_FILE so setup calls do not pollute traces
  const aoEnv = { ...process.env };
  delete aoEnv.AO_GH_TRACE_FILE;
  delete aoEnv.AO_GH_TRACE;

  const aoProc = spawn(
    process.execPath,
    [AO_CLI, "start", project, "--no-dashboard"],
    {
      env: aoEnv,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  aoProc.stdout.on("data", (chunk) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) console.error(`[ao] ${line}`);
    }
  });
  aoProc.stderr.on("data", (chunk) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) console.error(`[ao] ${line}`);
    }
  });

  // Give AO 5s to initialise before sending commands
  console.error("[setup] Waiting 5s for AO initialisation...");
  await sleep(5_000);

  // ── 6. Batch-spawn sessions ──────────────────────────────────────────────
  console.error(
    `[setup] Batch-spawning ${sessionCount} sessions for issues: ${issueNumbers.join(", ")}`,
  );
  try {
    const batchOut = await run(
      process.execPath,
      [AO_CLI, "batch-spawn", ...issueNumbers],
      { timeout: 120_000, env: aoEnv },
    );
    if (batchOut) console.error(`[ao:batch-spawn] ${batchOut}`);
  } catch (err) {
    // Kill AO before dying so we don't leave it hanging
    aoProc.kill("SIGTERM");
    die(`batch-spawn failed: ${err.message}`);
  }

  // Give sessions 5s to stabilise
  console.error("[setup] Waiting 5s for sessions to stabilise...");
  await sleep(5_000);

  // ── 7. Discover worktrees ─────────────────────────────────────────────────
  console.error("[setup] Discovering worktrees...");
  let worktreeListOutput;
  try {
    worktreeListOutput = await run(
      "git",
      ["-C", projectPath, "worktree", "list", "--porcelain"],
      { timeout: 15_000 },
    );
  } catch (err) {
    aoProc.kill("SIGTERM");
    die(`git worktree list failed: ${err.message}`);
  }

  // Parse porcelain output: each worktree block is separated by a blank line.
  // Fields we care about: "worktree <path>" and "branch refs/heads/<branch>"
  // Skip the main worktree (path === projectPath).
  const worktreeMap = new Map(); // sessionId -> { worktreePath, branch }

  const blocks = worktreeListOutput.split(/\n\n+/).filter(Boolean);
  for (const block of blocks) {
    const lines = block.split("\n").filter(Boolean);
    let wtPath = null;
    let wtBranch = null;

    for (const line of lines) {
      if (line.startsWith("worktree ")) wtPath = line.slice("worktree ".length).trim();
      if (line.startsWith("branch refs/heads/")) wtBranch = line.slice("branch refs/heads/".length).trim();
    }

    if (!wtPath || wtPath === projectPath) continue; // skip main worktree

    // Derive sessionId from the worktree directory name (last path segment)
    const sessionId = wtPath.split("/").pop();

    // Skip orchestrator sessions — they don't create PRs
    if (sessionId.includes("orchestrator")) continue;

    worktreeMap.set(sessionId, { worktreePath: wtPath, branch: wtBranch });
  }

  console.error(`[setup] Found ${worktreeMap.size} non-main worktree(s)`);

  // ── 8. Get branch for each worktree (in case porcelain didn't have it) ───
  for (const [sessionId, entry] of worktreeMap) {
    if (!entry.branch) {
      try {
        entry.branch = await run(
          "git",
          ["-C", entry.worktreePath, "branch", "--show-current"],
          { timeout: 10_000 },
        );
      } catch {
        entry.branch = null;
      }
    }
  }

  // ── 9. Build initial sessions list ───────────────────────────────────────
  // We may not have worktrees for every issue yet (agents may not have created
  // branches), so we build from worktreeMap and supplement with issue info.
  // The mapping issue->sessionId comes from the worktree directory name which
  // AO typically names after the session (e.g. <sessionPrefix>-<issue>).
  const sessionsList = Array.from(worktreeMap.entries()).map(
    ([sessionId, { worktreePath, branch }]) => ({
      sessionId,
      issue: null, // filled below
      branch,
      worktreePath,
      prNumber: null,
      prUrl: null,
    }),
  );

  // Attempt to match issues to sessions by sessionId naming convention:
  // AO names worktrees as "<sessionPrefix>-<issueNumber>" (e.g. "todo-app-42").
  for (const session of sessionsList) {
    for (const issueNum of issueNumbers) {
      if (
        session.sessionId.endsWith(`-${issueNum}`) ||
        session.sessionId === issueNum
      ) {
        session.issue = issueNum;
        break;
      }
    }
  }

  // ── 10. Poll for PR readiness (timeout 10 minutes) ───────────────────────
  const PR_POLL_INTERVAL_MS = 30_000;
  const PR_POLL_TIMEOUT_MS = 10 * 60_000;
  const pollDeadline = Date.now() + PR_POLL_TIMEOUT_MS;

  let controlCalls = 0;

  console.error(
    `[setup] Polling for PRs (timeout 10 min, every 30s)...`,
  );

  while (Date.now() < pollDeadline) {
    const pending = sessionsList.filter((s) => s.prNumber === null && s.branch);

    if (pending.length === 0) {
      console.error("[setup] All sessions have PRs — done polling.");
      break;
    }

    console.error(
      `[setup] ${pending.length} session(s) still waiting for PR...`,
    );

    for (const session of pending) {
      if (!session.branch) continue;
      try {
        const raw = await ghControl([
          "pr",
          "list",
          "--head",
          session.branch,
          "--repo",
          repo,
          "--json",
          "number,url",
          "--limit",
          "1",
        ]);
        controlCalls++;

        const prList = JSON.parse(raw || "[]");
        if (Array.isArray(prList) && prList.length > 0) {
          session.prNumber = prList[0].number;
          session.prUrl = prList[0].url;
          console.error(
            `[setup] PR found for ${session.sessionId}: #${session.prNumber} — ${session.prUrl}`,
          );
        }
      } catch {
        controlCalls++;
        // Ignore per-session errors; continue polling
      }
    }

    const allDone = sessionsList.every((s) => s.prNumber !== null || !s.branch);
    if (allDone) {
      console.error("[setup] All sessions have PRs — done polling.");
      break;
    }

    if (Date.now() + PR_POLL_INTERVAL_MS < pollDeadline) {
      await sleep(PR_POLL_INTERVAL_MS);
    } else {
      break;
    }
  }

  const prFoundCount = sessionsList.filter((s) => s.prNumber !== null).length;
  console.error(
    `[setup] PR polling complete: ${prFoundCount}/${sessionsList.length} sessions have PRs`,
  );

  // ── 11. Kill agent tmux sessions ─────────────────────────────────────────
  console.error("[setup] Killing agent tmux sessions (best-effort)...");
  for (const session of sessionsList) {
    try {
      await run("tmux", ["kill-session", "-t", session.sessionId], {
        timeout: 5_000,
      });
      console.error(`[setup] Killed tmux session: ${session.sessionId}`);
    } catch {
      // Best-effort — ignore errors (session may not exist or tmux unavailable)
    }
  }

  // ── 12. Stop AO ──────────────────────────────────────────────────────────
  console.error("[setup] Stopping AO (SIGTERM)...");
  aoProc.kill("SIGTERM");

  await new Promise((resolve) => {
    const killDeadline = Date.now() + 10_000;

    function checkExit() {
      if (aoProc.exitCode !== null) {
        console.error(`[setup] AO exited with code ${aoProc.exitCode}`);
        resolve();
        return;
      }
      if (Date.now() >= killDeadline) {
        console.error("[setup] AO did not exit in 10s — sending SIGKILL");
        aoProc.kill("SIGKILL");
        resolve();
        return;
      }
      setTimeout(checkExit, 500);
    }

    // Give it a tick to update exitCode after SIGTERM
    setTimeout(checkExit, 500);
  });

  // ── 13. Write setup artifact ──────────────────────────────────────────────
  const artifact = {
    schemaVersion: SCHEMA_VERSION,
    benchmarkVersion: BENCHMARK_VERSION,
    scenarioId,
    createdAt: new Date().toISOString(),
    gitSha: gitSha(),
    branch: gitBranch(),
    project,
    repo,
    scenario,
    topology,
    sessionCount,
    ready: true,
    sessions: sessionsList,
  };

  writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), "utf-8");

  // ── 14. Print summary ─────────────────────────────────────────────────────
  console.error("");
  console.error(`[setup] Setup complete.`);
  console.error(`  Sessions spawned:   ${sessionsList.length}`);
  console.error(`  PRs found:          ${prFoundCount}`);
  console.error(`  Control GH calls:   ${controlCalls}`);
  console.error(`  Artifact:           ${artifactPath}`);
  console.error("");
}

/**
 * measure mode — run a measurement window against already-running sessions.
 * Implementation pending (Task 5+).
 */
async function runMeasure(flags) {
  // ── 1. Parse and validate flags ────────────────────────────────────────────
  const { project, sessions: sessionsStr, duration: durationStr } = flags;
  const warmupStr = flags.warmup ?? "2m";

  if (!project) die("measure requires --project <name>");
  if (!sessionsStr) die("measure requires --sessions <n>");
  if (!durationStr) die("measure requires --duration <e.g. 15m>");

  const sessionCount = parseInt(sessionsStr, 10);
  if (!Number.isInteger(sessionCount) || sessionCount <= 0)
    die(`--sessions must be a positive integer, got: ${sessionsStr}`);

  const durationMs = parseDuration(durationStr);
  const warmupMs = parseDuration(warmupStr);

  // ── 2. Build scenarioId and locate setup artifact ─────────────────────────
  const scenarioId = `quiet-steady.single-repo.${sessionCount}`;
  ensureOutDir();
  const artifactPath = resolve(OUT_DIR, `setup-${project}-${scenarioId}.json`);

  if (!existsSync(artifactPath)) {
    die(`Setup artifact not found: ${artifactPath}\nRun "setup" mode first.`);
  }

  let setup;
  try {
    setup = JSON.parse(readFileSync(artifactPath, "utf-8"));
  } catch (err) {
    die(`Failed to parse setup artifact: ${err.message}`);
  }

  // ── 3. Load project config ─────────────────────────────────────────────────
  const projectConfig = loadProjectConfig(project);
  const { repo } = projectConfig;

  // ── 4. Validate setup ──────────────────────────────────────────────────────
  console.error(`[measure] Validating setup (${setup.sessions.length} sessions)...`);
  let controlCalls = 0;
  const invalidSessions = [];

  for (const session of setup.sessions) {
    let ok = true;

    // Check worktree exists
    if (!session.worktreePath || !existsSync(session.worktreePath)) {
      console.error(`[measure] FAIL: worktree missing for ${session.sessionId}: ${session.worktreePath}`);
      ok = false;
    }

    // Check PR is still open
    if (session.prNumber) {
      try {
        const raw = await ghControl([
          "pr", "view", String(session.prNumber),
          "--repo", repo,
          "--json", "state",
        ]);
        controlCalls++;
        const prData = JSON.parse(raw);
        if (prData.state !== "OPEN") {
          console.error(`[measure] FAIL: PR #${session.prNumber} for ${session.sessionId} is ${prData.state}, not OPEN`);
          ok = false;
        }
      } catch (err) {
        controlCalls++;
        console.error(`[measure] FAIL: could not check PR #${session.prNumber} for ${session.sessionId}: ${err.message}`);
        ok = false;
      }
    } else {
      console.error(`[measure] WARNING: ${session.sessionId} has no PR number — skipping PR check`);
    }

    if (!ok) invalidSessions.push(session.sessionId);
  }

  if (invalidSessions.length > 0) {
    die(`Setup validation failed for sessions: ${invalidSessions.join(", ")}\nRe-run setup mode to fix broken sessions.`);
  }

  console.error(`[measure] Setup validated — all ${setup.sessions.length} sessions OK`);

  // ── 5. Create placeholder tmux sessions ────────────────────────────────────
  // The lifecycle manager checks isProcessRunning via tmux.  If the tmux session
  // for a session is dead, the lifecycle marks it "killed" (terminal) and skips
  // PR polling entirely.  We need a live tmux session per session so the
  // lifecycle actually exercises the PR enrichment / CI-check code paths.
  //
  // We read the tmuxName from AO metadata and create a detached tmux session
  // that runs "sleep infinity".  These get cleaned up after the measurement.
  const placeholderTmuxSessions = [];
  const aoDataDir = join(homedir(), ".agent-orchestrator");
  // Find the project data directory: ~/.agent-orchestrator/{hash}-{project}
  // There may be multiple dirs (from different config checkouts). Pick the one
  // that has session metadata files matching our setup artifact.
  let projectDataDir = null;
  try {
    const entries = readdirSync(aoDataDir);
    const candidates = entries.filter((e) => e.endsWith(`-${project}`));
    const firstSessionId = setup.sessions[0]?.sessionId;
    for (const candidate of candidates) {
      const sessionsDir = join(aoDataDir, candidate, "sessions");
      if (firstSessionId && existsSync(join(sessionsDir, firstSessionId))) {
        projectDataDir = join(aoDataDir, candidate);
        break;
      }
    }
  } catch { /* ignore */ }

  // Create a symlink named "claude" -> /bin/sleep so the process appears as
  // ".../claude" in `ps` output, matching the agent's /(?:^|\/)claude(?:\s|$)/
  // regex in findClaudeProcess().
  const claudeStubDir = join(OUT_DIR, "stub-bin");
  const claudeStubPath = join(claudeStubDir, "claude");
  mkdirSync(claudeStubDir, { recursive: true });
  try { unlinkSync(claudeStubPath); } catch { /* didn't exist */ }
  symlinkSync("/bin/sleep", claudeStubPath);

  if (projectDataDir) {
    const sessionsMetaDir = join(projectDataDir, "sessions");
    for (const session of setup.sessions) {
      try {
        const metaFile = join(sessionsMetaDir, session.sessionId);
        const meta = readFileSync(metaFile, "utf-8");
        const tmuxNameMatch = meta.match(/^tmuxName=(.+)$/m);
        if (!tmuxNameMatch) continue;
        const tmuxName = tmuxNameMatch[1].trim();

        // Check if tmux session already exists
        try {
          await run("tmux", ["has-session", "-t", tmuxName], { timeout: 3_000 });
          // Already exists — skip
          continue;
        } catch { /* doesn't exist — create it */ }

        // Launch the "claude" symlink (which is really /bin/sleep) in the tmux
        // session.  `ps` will show ".../claude 86400" which matches the
        // findClaudeProcess regex, preventing lifecycle from marking sessions
        // as "killed" before reaching the PR/CI check code paths.
        // Note: macOS sleep doesn't accept "infinity" — use 86400 (24h).
        await run("tmux", ["new-session", "-d", "-s", tmuxName, "-x", "80", "-y", "24",
          `${claudeStubPath} 86400`], {
          timeout: 5_000,
        });
        placeholderTmuxSessions.push(tmuxName);
      } catch (err) {
        console.error(`[measure] WARNING: could not create placeholder tmux for ${session.sessionId}: ${err.message}`);
      }
    }
    console.error(`[measure] Created ${placeholderTmuxSessions.length} placeholder tmux session(s)`);
  } else {
    console.error(`[measure] WARNING: could not find AO data dir for project "${project}" — sessions may appear as killed`);
  }

  // ── 6. Set up trace file ───────────────────────────────────────────────────
  const timestamp = Math.floor(Date.now() / 1000);
  const traceFile = resolve(OUT_DIR, `gh-trace-bench-${timestamp}.jsonl`);

  // ── 7. Start AO with trace ─────────────────────────────────────────────────
  console.error(`[measure] Starting AO (trace → ${traceFile})...`);

  const aoProc = spawn(
    process.execPath,
    [AO_CLI, "start", project, "--no-dashboard"],
    {
      env: { ...process.env, AO_GH_TRACE_FILE: traceFile },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  aoProc.stdout.on("data", (chunk) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) console.error(`[ao] ${line}`);
    }
  });
  aoProc.stderr.on("data", (chunk) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) console.error(`[ao] ${line}`);
    }
  });

  // Helper to stop AO gracefully
  async function stopAO() {
    console.error("[measure] Stopping AO (SIGTERM)...");
    aoProc.kill("SIGTERM");
    await new Promise((resolve) => {
      const killDeadline = Date.now() + 10_000;
      function checkExit() {
        if (aoProc.exitCode !== null) {
          console.error(`[measure] AO exited with code ${aoProc.exitCode}`);
          resolve();
          return;
        }
        if (Date.now() >= killDeadline) {
          console.error("[measure] AO did not exit in 10s — sending SIGKILL");
          aoProc.kill("SIGKILL");
          resolve();
          return;
        }
        setTimeout(checkExit, 500);
      }
      setTimeout(checkExit, 500);
    });
  }

  let snapshotBefore = null;
  let snapshotAfter = null;
  let measureStart = null;
  let measureEnd = null;
  let warmupEnd = null;

  try {
    // ── 8. Warmup phase ────────────────────────────────────────────────────────
    console.error(`[measure] Warmup: ${warmupStr} (${warmupMs / 1000}s)...`);
    const warmupDeadline = Date.now() + warmupMs;
    while (Date.now() < warmupDeadline) {
      const remaining = warmupDeadline - Date.now();
      console.error(`[measure] Warmup: ${Math.ceil(remaining / 1000)}s remaining...`);
      await sleep(Math.min(5_000, remaining));
    }

    // ── 9. Record warmup end ───────────────────────────────────────────────────
    warmupEnd = new Date().toISOString();
    console.error(`[measure] Warmup complete at ${warmupEnd}`);

    // ── 10. Before rate-limit snapshot ────────────────────────────────────────
    console.error("[measure] Capturing rate-limit snapshot (before)...");
    {
      const raw = await ghControl(["api", "rate_limit"]);
      controlCalls++;
      const data = JSON.parse(raw);
      const { core, graphql } = data.resources;
      snapshotBefore = {
        capturedAt: new Date().toISOString(),
        core: { limit: core.limit, remaining: core.remaining, used: core.used },
        graphql: { limit: graphql.limit, remaining: graphql.remaining, used: graphql.used },
      };
    }
    console.error(`[measure] Before snapshot: core remaining=${snapshotBefore.core.remaining}, graphql remaining=${snapshotBefore.graphql.remaining}`);

    // ── 11. Record measurement start ──────────────────────────────────────────
    measureStart = new Date().toISOString();
    console.error(`[measure] Measurement window started at ${measureStart} (duration: ${durationStr})`);

    // ── 12. Measurement window ────────────────────────────────────────────────
    const measureDeadline = Date.now() + durationMs;
    let nextLog = Date.now() + 60_000;
    while (Date.now() < measureDeadline) {
      const remaining = measureDeadline - Date.now();
      if (Date.now() >= nextLog) {
        console.error(`[measure] Window: ${Math.ceil(remaining / 1000)}s remaining...`);
        nextLog += 60_000;
      }
      await sleep(Math.min(5_000, remaining));
    }

    // ── 13. Record measurement end ────────────────────────────────────────────
    measureEnd = new Date().toISOString();
    console.error(`[measure] Measurement window ended at ${measureEnd}`);

    // ── 14. After rate-limit snapshot ─────────────────────────────────────────
    console.error("[measure] Capturing rate-limit snapshot (after)...");
    {
      const raw = await ghControl(["api", "rate_limit"]);
      controlCalls++;
      const data = JSON.parse(raw);
      const { core, graphql } = data.resources;
      snapshotAfter = {
        capturedAt: new Date().toISOString(),
        core: { limit: core.limit, remaining: core.remaining, used: core.used },
        graphql: { limit: graphql.limit, remaining: graphql.remaining, used: graphql.used },
      };
    }
    console.error(`[measure] After snapshot: core remaining=${snapshotAfter.core.remaining}, graphql remaining=${snapshotAfter.graphql.remaining}`);
  } finally {
    // ── 15. Stop AO (always, even on error) ──────────────────────────────────
    await stopAO();

    // ── 15b. Kill placeholder tmux sessions ─────────────────────────────────
    for (const tmuxName of placeholderTmuxSessions) {
      try {
        await run("tmux", ["kill-session", "-t", tmuxName], { timeout: 3_000 });
      } catch { /* best-effort */ }
    }
    if (placeholderTmuxSessions.length > 0) {
      console.error(`[measure] Killed ${placeholderTmuxSessions.length} placeholder tmux session(s)`);
    }
  }

  // ── 16. Compute scorecard ─────────────────────────────────────────────────
  console.error(`[measure] Reading trace from ${traceFile}...`);
  const allRows = readTrace(traceFile);
  console.error(`[measure] Trace has ${allRows.length} rows`);

  const snapshots = {
    before: { core: snapshotBefore.core, graphql: snapshotBefore.graphql },
    after: { core: snapshotAfter.core, graphql: snapshotAfter.graphql },
  };

  const scorecard = computeScorecard(allRows, measureStart, measureEnd, snapshots, controlCalls);

  // ── 17. Build envelope ────────────────────────────────────────────────────
  const windowDurationMs = new Date(measureEnd).getTime() - new Date(measureStart).getTime();
  const durationSec = Math.round(windowDurationMs / 1000);
  const durationMin = Math.floor(durationSec / 60);
  const durationRemSec = durationSec % 60;
  const durationActual = `${durationMin}m ${durationRemSec}s`;

  const scorecardTimestamp = Math.floor(Date.now() / 1000);

  const envelope = {
    schemaVersion: SCHEMA_VERSION,
    benchmarkVersion: BENCHMARK_VERSION,
    scenarioId,
    gitSha: gitSha(),
    branch: gitBranch(),
    measuredAt: measureEnd,
    sessionCount: setup.sessions.length,
    warmup: {
      requested: warmupStr,
      actualEnd: warmupEnd,
    },
    window: {
      start: measureStart,
      end: measureEnd,
      durationRequested: durationStr,
      durationActual,
    },
    resourceWindows: scorecard.resourceWindows,
    rateLimitSnapshots: {
      before: snapshotBefore,
      after: snapshotAfter,
    },
    scorecard,
    trace: traceFile,
    supplemental: null,
  };

  // ── 18. Write scorecard JSON ──────────────────────────────────────────────
  const scorecardPath = resolve(OUT_DIR, `scorecard-${scenarioId}-${scorecardTimestamp}.json`);
  writeFileSync(scorecardPath, JSON.stringify(envelope, null, 2), "utf-8");

  // ── 19. Set scorecardPath on envelope ────────────────────────────────────
  envelope.scorecardPath = scorecardPath;

  // ── 20. Print scorecard ───────────────────────────────────────────────────
  printScorecard(envelope);

  // ── 21. Log paths ─────────────────────────────────────────────────────────
  console.error(`Trace written to:     ${traceFile}`);
  console.error(`Scorecard written to: ${scorecardPath}`);
}

/**
 * report mode — compute and print a scorecard from a completed trace.
 */
async function runReport(flags) {
  if (!flags.trace) die("report mode requires --trace <path>");

  const tracePath = resolve(flags.trace);
  const warmupEnd = flags["warmup-end"] ?? null;

  // Read trace
  const allRows = readTrace(tracePath);
  if (allRows.length === 0) die(`Trace file is empty: ${tracePath}`);

  // Sort rows by timestamp to ensure correct window boundaries
  allRows.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  // Determine window boundaries
  const windowStart = warmupEnd ?? allRows[0].timestamp;
  const windowEnd = allRows[allRows.length - 1].timestamp;

  // Compute scorecard
  const scorecard = computeScorecard(allRows, windowStart, windowEnd, null, null);

  // Null out fields unavailable in report mode
  scorecard.bracketDelta = { core: null, graphql: null };
  scorecard.benchmarkControlCalls = null;

  // Compute window duration
  const windowDurationMs = new Date(windowEnd).getTime() - new Date(windowStart).getTime();
  const durationSec = Math.round(windowDurationMs / 1000);
  const durationMin = Math.floor(durationSec / 60);
  const durationRemSec = durationSec % 60;
  const durationActual = `${durationMin}m ${durationRemSec}s`;

  // Build envelope
  const measuredAt = new Date().toISOString();
  const timestamp = Math.floor(Date.now() / 1000);

  const envelope = {
    schemaVersion: SCHEMA_VERSION,
    benchmarkVersion: BENCHMARK_VERSION,
    scenarioId: "report",
    gitSha: gitSha(),
    branch: gitBranch(),
    measuredAt,
    sessionCount: "?",
    warmup: warmupEnd ? { requested: "?", actualEnd: warmupEnd } : null,
    window: {
      start: windowStart,
      end: windowEnd,
      durationRequested: "?",
      durationActual,
    },
    resourceWindows: scorecard.resourceWindows,
    rateLimitSnapshots: null,
    scorecard,
    trace: tracePath,
    supplemental: null,
  };

  // Write scorecard JSON
  ensureOutDir();
  const scorecardPath = resolve(OUT_DIR, `scorecard-report-${timestamp}.json`);
  writeFileSync(scorecardPath, JSON.stringify(envelope, null, 2), "utf-8");
  envelope.scorecardPath = scorecardPath;

  // Print scorecard to stdout
  printScorecard(envelope);

  // Log scorecard path to stderr
  console.error(`Scorecard written to: ${scorecardPath}`);
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

const { mode, flags } = parseArgs(process.argv);

if (!mode || flags.help || flags.h) {
  usage();
  process.exit(mode ? 1 : 0);
}

switch (mode) {
  case "setup":
    runSetup(flags).catch((err) => die(err.message));
    break;
  case "measure":
    runMeasure(flags).catch((err) => die(err.message));
    break;
  case "report":
    runReport(flags).catch((err) => die(err.message));
    break;
  default:
    console.error(`Unknown mode: "${mode}"`);
    usage();
    process.exit(1);
}
