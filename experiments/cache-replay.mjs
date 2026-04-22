#!/usr/bin/env node
/**
 * Counterfactual cache replay.
 *
 * Reads an `execGhObserved` JSONL trace and simulates what the
 * tracker-github + scm-github caches (commits c5f831bf, de69bb5b, fb651cf6)
 * would have done if they had been live for that exact run.
 *
 * Per-method TTLs match the shipped code:
 *   - resolvePR:                 60s
 *   - getPRState:                 5s
 *   - getPRSummary:               5s
 *   - getReviews:                 5s
 *   - getReviewDecision:          5s
 *   - getCIChecks:                5s   (covers `gh pr checks` + statusCheckRollup fallback)
 *   - getMergeability:            5s
 *   - getPendingComments:         5s   (per-PR `gh api graphql` review-thread query)
 *   - detectPR:                   5s   (positive-only — empty results never cached)
 *   - tracker-github getIssue:  300s   (5 min)
 *
 * Detects the cached operation from the row's `operation` + `args`. Walks
 * timestamps in order. For each call, checks whether the previous matching
 * key is still inside its TTL window — if so, that call would have been
 * a cache hit (no gh subprocess, no HTTP, no rate-limit spend).
 *
 * Usage:  node cache-replay.mjs <path-to-gh-trace-ao.jsonl>
 */

import { readFileSync } from "node:fs";

if (process.argv.length < 3) {
  console.error("usage: node cache-replay.mjs <gh-trace-ao.jsonl>");
  process.exit(2);
}
const tracePath = process.argv[2];

const TTL = {
  resolvePR: 60_000,
  getPRState: 5_000,
  getPRSummary: 5_000,
  getReviews: 10_000,
  getReviewDecision: 10_000,
  getCIChecks: 5_000,
  getMergeability: 5_000,
  getPendingComments: 10_000,
  detectPR: 30_000,
  getIssue: 5 * 60_000,
};

// ── classification ─────────────────────────────────────────────────────────
//
// Map (operation, args) → { method, key } if the row would have been served
// by one of the new caches; otherwise null (passes through unchanged).

function pickJsonFields(args) {
  const i = args.indexOf("--json");
  return i >= 0 && i + 1 < args.length ? args[i + 1] : "";
}

function pickFlag(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : "";
}

function pickRepoNumberFromPRView(args) {
  const repo = pickFlag(args, "--repo");
  // gh pr view <reference> --repo ...
  const ref = args[2] ?? "";
  return { repo, ref };
}

function classify(row) {
  const { operation, args } = row;
  if (!Array.isArray(args)) return null;

  // tracker-github gh issue view ...
  if (operation === "gh.issue.view") {
    const repo = pickFlag(args, "--repo");
    const id = args[2] ?? "";
    if (!repo || !id) return null;
    return { method: "getIssue", key: `${repo}#${id.replace(/^#/, "")}` };
  }

  // scm-github gh pr checks ...
  if (operation === "gh.pr.checks") {
    const repo = pickFlag(args, "--repo");
    const num = args[2] ?? "";
    if (!repo || !num) return null;
    return { method: "getCIChecks", key: `${repo}#${num}:getCIChecks` };
  }

  // scm-github gh pr list --head BRANCH ...   (detectPR)
  // Positive-only: stdoutBytes <= 3 means "[]" — never cached.
  if (operation === "gh.pr.list") {
    const repo = pickFlag(args, "--repo");
    const head = pickFlag(args, "--head");
    if (!repo || !head) return null;
    return {
      method: "detectPR",
      key: `${repo}#${head}:detectPR`,
      positive: row.stdoutBytes !== undefined && row.stdoutBytes > 3,
    };
  }

  // scm-github bare gh api graphql ...   (getPendingComments per-PR)
  if (operation === "gh.api.graphql") {
    // The query body is in args; we key by the PR (owner/name/number).
    // Look for owner=, name=, number= -F/-f arg pairs.
    let owner = "", name = "", number = "";
    for (let i = 0; i < args.length - 1; i++) {
      const v = args[i + 1];
      if (typeof v !== "string") continue;
      if (v.startsWith("owner=")) owner = v.slice(6);
      else if (v.startsWith("name=")) name = v.slice(5);
      else if (v.startsWith("number=")) number = v.slice(7);
    }
    if (owner && name && number) {
      return { method: "getPendingComments", key: `${owner}/${name}#${number}:getPendingComments` };
    }
    return null;
  }

  // scm-github gh pr view ... — branch by --json field set
  if (operation === "gh.pr.view") {
    const { repo, ref } = pickRepoNumberFromPRView(args);
    if (!repo || !ref) return null;
    const fields = pickJsonFields(args);

    // resolvePR — full identity field set
    if (fields === "number,url,title,headRefName,baseRefName,isDraft") {
      return { method: "resolvePR", key: `${repo}:resolvePR:ref=${ref}` };
    }
    // getPRState
    if (fields === "state") {
      return { method: "getPRState", key: `${repo}#${ref}:getPRState` };
    }
    // getPRSummary
    if (fields === "state,title,additions,deletions") {
      return { method: "getPRSummary", key: `${repo}#${ref}:getPRSummary` };
    }
    // getReviews
    if (fields === "reviews") {
      return { method: "getReviews", key: `${repo}#${ref}:getReviews` };
    }
    // getReviewDecision
    if (fields === "reviewDecision") {
      return { method: "getReviewDecision", key: `${repo}#${ref}:getReviewDecision` };
    }
    // getMergeability
    if (fields === "mergeable,reviewDecision,mergeStateStatus,isDraft") {
      return { method: "getMergeability", key: `${repo}#${ref}:getMergeability` };
    }
    // statusCheckRollup — fallback path inside getCIChecks (rides on same key)
    if (fields === "statusCheckRollup") {
      return { method: "getCIChecks", key: `${repo}#${ref}:getCIChecks` };
    }
    return null;
  }

  return null;
}

// ── replay ─────────────────────────────────────────────────────────────────

const lines = readFileSync(tracePath, "utf8").split("\n").filter(Boolean);
const cache = new Map(); // key → expiresAtMs
const totals = {
  rows: 0,
  cacheable: 0,
  hits: 0,
  issued: 0,
  byMethod: {},
};

for (const line of lines) {
  let row;
  try { row = JSON.parse(line); } catch { continue; }
  totals.rows++;
  const ts = Date.parse(row.timestamp);
  if (Number.isNaN(ts)) continue;

  const c = classify(row);
  if (!c) continue;
  totals.cacheable++;

  const m = (totals.byMethod[c.method] ??= { rows: 0, hits: 0, issued: 0 });
  m.rows++;

  const expires = cache.get(c.key);
  const hit = expires !== undefined && expires > ts;

  if (hit) {
    totals.hits++;
    m.hits++;
  } else {
    totals.issued++;
    m.issued++;
    // detectPR: positive-only — only cache non-empty responses
    if (c.method === "detectPR" && c.positive === false) {
      // do not write cache
    } else {
      cache.set(c.key, ts + TTL[c.method]);
    }
  }
}

// ── report ─────────────────────────────────────────────────────────────────

const reduction = (totals.cacheable - totals.issued) / totals.cacheable;
const overallReduction = totals.hits / totals.rows;

console.log(`\nCache-replay results — ${tracePath}\n`);
console.log(`Total trace rows:          ${totals.rows}`);
console.log(`Cacheable rows:            ${totals.cacheable}  (${(totals.cacheable / totals.rows * 100).toFixed(1)}% of total)`);
console.log(`Cache hits (avoided gh):   ${totals.hits}`);
console.log(`Cache misses (issued):     ${totals.issued}`);
console.log(`Reduction on cacheable:    ${(reduction * 100).toFixed(1)}%`);
console.log(`Reduction on whole trace:  ${(overallReduction * 100).toFixed(1)}%`);

console.log(`\nPer-method breakdown:`);
console.log(`${"method".padEnd(22)}${"rows".padStart(8)}${"issued".padStart(10)}${"hits".padStart(10)}${"hit%".padStart(10)}`);
console.log(`${"─".repeat(60)}`);
const ordered = Object.entries(totals.byMethod).sort((a, b) => b[1].rows - a[1].rows);
for (const [method, m] of ordered) {
  const hitPct = (m.hits / m.rows * 100).toFixed(1);
  console.log(`${method.padEnd(22)}${String(m.rows).padStart(8)}${String(m.issued).padStart(10)}${String(m.hits).padStart(10)}${(hitPct + "%").padStart(10)}`);
}

console.log(`\nUncached operations (passed through):`);
const uncached = totals.rows - totals.cacheable;
console.log(`  ${uncached} rows  (${(uncached / totals.rows * 100).toFixed(1)}% of total)`);
