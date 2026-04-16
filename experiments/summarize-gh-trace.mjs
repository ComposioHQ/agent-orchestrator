#!/usr/bin/env node

import { readFileSync } from "node:fs";

function usage() {
  console.error("Usage: node experiments/summarize-gh-trace.mjs <trace.jsonl>");
  process.exit(1);
}

const tracePath = process.argv[2];
if (!tracePath) usage();

const raw = readFileSync(tracePath, "utf-8");
const lines = raw.split("\n").filter(Boolean);
const entries = lines.map((line) => JSON.parse(line));

const totals = {
  count: entries.length,
  ok: entries.filter((entry) => entry.ok).length,
  failed: entries.filter((entry) => !entry.ok).length,
};

const byOperation = new Map();
const byStatus = new Map();
let peakDurationMs = 0;

for (const entry of entries) {
  peakDurationMs = Math.max(peakDurationMs, Number(entry.durationMs) || 0);

  const operation = String(entry.operation ?? "unknown");
  byOperation.set(operation, (byOperation.get(operation) ?? 0) + 1);

  const status = entry.httpStatus === undefined ? "none" : String(entry.httpStatus);
  byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
}

function printMap(title, map) {
  console.log(`\n${title}`);
  for (const [key, value] of [...map.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return String(a[0]).localeCompare(String(b[0]));
  })) {
    console.log(`  ${key}: ${value}`);
  }
}

console.log(`Trace file: ${tracePath}`);
console.log(`Entries: ${totals.count}`);
console.log(`Succeeded: ${totals.ok}`);
console.log(`Failed: ${totals.failed}`);
console.log(`Longest request: ${peakDurationMs}ms`);

printMap("By operation", byOperation);
printMap("By HTTP status", byStatus);

// Rate-limit burn per reset window
const withRL = entries.filter((e) => typeof e.rateLimitRemaining === "number");
if (withRL.length >= 2) {
  console.log(`\nRate limit (${withRL.length} rows with headers):`);

  // Group by rateLimitReset to segment across reset boundaries
  const windowMap = new Map();
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
    console.log(`  ⚠ Run straddled ${windows.length} reset windows`);
  }
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
    const resource = wFirst.rateLimitResource ?? "?";
    console.log(`  Window reset=${resetDate} resource=${resource}: remaining ${wFirst.rateLimitRemaining}→${wLast.rateLimitRemaining} delta=${wDelta} (${windowRows.length} rows, ${(wElapsedMs / 60_000).toFixed(1)}min${wElapsedHr > 0 ? `, ${(wDelta / wElapsedHr).toFixed(0)} tokens/hr` : ""})`);
  }
}
