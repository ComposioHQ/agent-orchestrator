#!/usr/bin/env node
// Deeper analysis of a gh-trace JSONL file than summarize-gh-trace.mjs.
// Answers the questions summarize doesn't: failure breakdown, operation
// bucketing quality, per-repo split, rate-limit curve, status coverage.

import { readFileSync } from "node:fs";

function usage() {
  console.error("Usage: node experiments/analyze-trace.mjs <trace.jsonl>");
  process.exit(1);
}

const path = process.argv[2];
if (!path) usage();

const rows = readFileSync(path, "utf-8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

function fmt(n) {
  return n.toLocaleString();
}

function pct(num, denom) {
  if (!denom) return "0.0%";
  return `${((num / denom) * 100).toFixed(1)}%`;
}

function groupBy(rows, fn) {
  const m = new Map();
  for (const r of rows) {
    const k = fn(r);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function extractRepo(row) {
  const args = row.args ?? [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--repo" && args[i + 1]) return args[i + 1];
    if (typeof args[i] === "string" && args[i].startsWith("repos/")) {
      const m = args[i].match(/^repos\/([^/]+\/[^/?]+)/);
      if (m) return m[1];
    }
  }
  return "unknown";
}

function extractEndpointShape(row) {
  const args = row.args ?? [];
  if (args[0] !== "api") return `cli:${args[0] ?? "?"}.${args[1] ?? "?"}`;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (!a) continue;
    if (a === "--method" || a === "-X" || a === "-H" || a === "--header") {
      i++;
      continue;
    }
    if (a === "-f" || a === "--raw-field" || a === "-F" || a === "--field") {
      i++;
      continue;
    }
    if (!a.startsWith("-")) {
      return a.replace(/\/\d+/g, "/:n").replace(/[?&].*$/, "");
    }
  }
  return "api:?";
}

console.log(`# Deeper analysis — ${path}`);
console.log(`\nTotal rows: ${fmt(rows.length)}`);

// ---------------------------------------------------------------------------
// Wall clock
// ---------------------------------------------------------------------------
const withTs = rows.filter((r) => r.timestamp);
if (withTs.length >= 2) {
  const first = new Date(withTs[0].timestamp).getTime();
  const last = new Date(withTs[withTs.length - 1].timestamp).getTime();
  const elapsedMs = last - first;
  const elapsedMin = elapsedMs / 60_000;
  console.log(`First: ${withTs[0].timestamp}`);
  console.log(`Last:  ${withTs[withTs.length - 1].timestamp}`);
  console.log(`Elapsed: ${elapsedMin.toFixed(2)} min`);
  console.log(`Calls/min: ${(rows.length / elapsedMin).toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// Success / failure
// ---------------------------------------------------------------------------
const ok = rows.filter((r) => r.ok);
const failed = rows.filter((r) => !r.ok);
console.log(`\n## Outcome`);
console.log(`Succeeded: ${fmt(ok.length)} (${pct(ok.length, rows.length)})`);
console.log(`Failed:    ${fmt(failed.length)} (${pct(failed.length, rows.length)})`);

// ---------------------------------------------------------------------------
// Failure breakdown — what Adil didn't report
// ---------------------------------------------------------------------------
if (failed.length > 0) {
  console.log(`\n## Failures by exit code × operation`);
  const buckets = groupBy(
    failed,
    (r) => `exit=${r.exitCode ?? "?"} signal=${r.signal ?? "-"} ${r.operation ?? "?"}`,
  );
  for (const [k, v] of buckets.slice(0, 20)) {
    console.log(`  ${fmt(v).padStart(4)}  ${k}`);
  }

  // Fraction of failures that look like 304-on-exit-1
  const httpStatusByFail = groupBy(failed, (r) => String(r.httpStatus ?? "none"));
  console.log(`\n## Failures by httpStatus`);
  for (const [k, v] of httpStatusByFail) {
    console.log(`  ${fmt(v).padStart(4)}  ${k}`);
  }
}

// ---------------------------------------------------------------------------
// HTTP status coverage
// ---------------------------------------------------------------------------
const withHttpStatus = rows.filter((r) => r.httpStatus !== undefined && r.httpStatus !== null);
console.log(`\n## httpStatus coverage`);
console.log(
  `Rows with httpStatus set: ${fmt(withHttpStatus.length)} / ${fmt(rows.length)} (${pct(withHttpStatus.length, rows.length)})`,
);
const statusCounts = groupBy(rows, (r) => String(r.httpStatus ?? "none"));
for (const [k, v] of statusCounts) {
  console.log(`  ${fmt(v).padStart(4)}  ${k}`);
}

// ---------------------------------------------------------------------------
// httpStatus coverage by operation type (is the gap specific to cli subcmds?)
// ---------------------------------------------------------------------------
console.log(`\n## httpStatus coverage by operation`);
const opToCoverage = new Map();
for (const r of rows) {
  const op = r.operation ?? "?";
  const entry = opToCoverage.get(op) ?? { total: 0, withStatus: 0 };
  entry.total += 1;
  if (r.httpStatus !== undefined && r.httpStatus !== null) entry.withStatus += 1;
  opToCoverage.set(op, entry);
}
const opRows = [...opToCoverage.entries()].sort((a, b) => b[1].total - a[1].total);
for (const [op, { total, withStatus }] of opRows) {
  console.log(
    `  ${fmt(total).padStart(4)}  ${op.padEnd(32)}  status set: ${fmt(withStatus).padStart(4)} (${pct(withStatus, total)})`,
  );
}

// ---------------------------------------------------------------------------
// Operation naming quality (Adil's bug: gh.api.--method bucket)
// ---------------------------------------------------------------------------
console.log(`\n## Operation naming quality`);
const badNames = opRows.filter(([op]) => op.includes("--") || op.endsWith(".?") || op === "?");
if (badNames.length === 0) {
  console.log(`  (no malformed operation names found)`);
} else {
  for (const [op, { total }] of badNames) {
    console.log(`  ${fmt(total).padStart(4)}  ${op}  ← flag-derived, should be endpoint`);
  }
}

// ---------------------------------------------------------------------------
// Endpoint shapes (normalized) — what callsites actually hit
// ---------------------------------------------------------------------------
console.log(`\n## Endpoint shapes (top 20, PR numbers normalized to :n)`);
const shapeCounts = groupBy(rows, (r) => extractEndpointShape(r));
for (const [shape, count] of shapeCounts.slice(0, 20)) {
  console.log(`  ${fmt(count).padStart(4)}  ${shape}`);
}

// ---------------------------------------------------------------------------
// Per-repo split — Adil only used one repo, but let's verify
// ---------------------------------------------------------------------------
console.log(`\n## Per-repo split`);
const repoCounts = groupBy(rows, (r) => extractRepo(r));
for (const [repo, count] of repoCounts) {
  console.log(`  ${fmt(count).padStart(4)}  ${repo}`);
}

// ---------------------------------------------------------------------------
// Rate-limit curve
// ---------------------------------------------------------------------------
const withRL = rows.filter((r) => typeof r.rateLimitRemaining === "number");
console.log(`\n## Rate limit`);
console.log(`Rows with rateLimit header: ${fmt(withRL.length)} (${pct(withRL.length, rows.length)})`);
if (withRL.length >= 2) {
  const first = withRL[0];
  const last = withRL[withRL.length - 1];
  const delta = first.rateLimitRemaining - last.rateLimitRemaining;
  const elapsedMs =
    new Date(last.timestamp).getTime() - new Date(first.timestamp).getTime();
  const elapsedHr = elapsedMs / 3_600_000;
  console.log(`First remaining: ${fmt(first.rateLimitRemaining)}  @ ${first.timestamp}`);
  console.log(`Last  remaining: ${fmt(last.rateLimitRemaining)}  @ ${last.timestamp}`);
  console.log(`Delta (naive): ${delta} tokens over ${(elapsedMs / 60_000).toFixed(2)} min`);
  console.log(`Burn rate (naive): ${(delta / elapsedHr).toFixed(1)} tokens/hr`);

  // Resource split
  const byResource = new Map();
  for (const r of withRL) {
    const res = r.rateLimitResource ?? "unknown";
    byResource.set(res, (byResource.get(res) ?? 0) + 1);
  }
  console.log(`Rate-limit resource split:`);
  for (const [res, n] of [...byResource.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${fmt(n).padStart(4)}  ${res}`);
  }

  // -------------------------------------------------------------------------
  // Per-reset-window burn segments
  // Groups rows by rateLimitReset value so runs that straddle a reset boundary
  // produce per-window deltas instead of a single meaningless cross-reset delta.
  // -------------------------------------------------------------------------
  const windowMap = new Map(); // resetEpoch -> { rows: [], resource }
  for (const r of withRL) {
    const resetKey = r.rateLimitReset ?? "unknown";
    if (!windowMap.has(resetKey)) windowMap.set(resetKey, []);
    windowMap.get(resetKey).push(r);
  }
  const windows = [...windowMap.entries()].sort((a, b) => {
    const aKey = typeof a[0] === "number" ? a[0] : 0;
    const bKey = typeof b[0] === "number" ? b[0] : 0;
    return aKey - bKey;
  });

  if (windows.length > 1) {
    console.log(`\n  ⚠ Run straddled ${windows.length} reset windows — naive delta is invalid.`);
  }
  console.log(`\n### Per-reset-window burn segments`);
  for (const [resetEpoch, windowRows] of windows) {
    const resetDate = typeof resetEpoch === "number"
      ? new Date(resetEpoch * 1000).toISOString()
      : "unknown";
    const wFirst = windowRows[0];
    const wLast = windowRows[windowRows.length - 1];
    const wDelta = wFirst.rateLimitRemaining - wLast.rateLimitRemaining;
    const wElapsedMs =
      new Date(wLast.timestamp).getTime() - new Date(wFirst.timestamp).getTime();
    const wElapsedHr = wElapsedMs / 3_600_000;
    const resource = wFirst.rateLimitResource ?? "unknown";
    console.log(`  Window reset=${resetDate} resource=${resource} rows=${windowRows.length}`);
    console.log(`    remaining: ${fmt(wFirst.rateLimitRemaining)} → ${fmt(wLast.rateLimitRemaining)}  delta=${wDelta}`);
    console.log(`    elapsed: ${(wElapsedMs / 60_000).toFixed(2)} min`);
    if (wElapsedHr > 0) {
      console.log(`    burn rate: ${(wDelta / wElapsedHr).toFixed(1)} tokens/hr`);
    }
  }
}

// ---------------------------------------------------------------------------
// Per-minute call density (proxy for "calls per poll")
// ---------------------------------------------------------------------------
if (withTs.length >= 2) {
  console.log(`\n## Calls per minute (density histogram)`);
  const startMs = new Date(withTs[0].timestamp).getTime();
  const buckets = new Map();
  for (const r of rows) {
    if (!r.timestamp) continue;
    const t = new Date(r.timestamp).getTime();
    const minute = Math.floor((t - startMs) / 60_000);
    buckets.set(minute, (buckets.get(minute) ?? 0) + 1);
  }
  const sortedBuckets = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
  const counts = sortedBuckets.map((e) => e[1]);
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  const avg = counts.reduce((s, n) => s + n, 0) / counts.length;
  const median = counts.slice().sort((a, b) => a - b)[Math.floor(counts.length / 2)];
  console.log(
    `Minutes observed: ${counts.length} | min ${min} | median ${median} | avg ${avg.toFixed(1)} | max ${max} calls/min`,
  );
}

// ---------------------------------------------------------------------------
// Duration tail
// ---------------------------------------------------------------------------
const durations = rows.map((r) => Number(r.durationMs) || 0).sort((a, b) => a - b);
function pctile(arr, p) {
  if (arr.length === 0) return 0;
  const idx = Math.min(arr.length - 1, Math.floor(arr.length * p));
  return arr[idx];
}
console.log(`\n## Duration distribution (ms)`);
console.log(`p50:  ${pctile(durations, 0.5)}`);
console.log(`p90:  ${pctile(durations, 0.9)}`);
console.log(`p95:  ${pctile(durations, 0.95)}`);
console.log(`p99:  ${pctile(durations, 0.99)}`);
console.log(`max:  ${pctile(durations, 1.0)}`);
const slow = rows.filter((r) => (r.durationMs ?? 0) > 5000);
console.log(`Calls > 5000 ms: ${fmt(slow.length)}`);
if (slow.length > 0) {
  const slowOps = groupBy(slow, (r) => r.operation ?? "?");
  for (const [op, n] of slowOps) console.log(`  ${fmt(n).padStart(4)}  ${op}`);
}
