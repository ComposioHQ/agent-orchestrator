#!/usr/bin/env node
// Standalone drill that exercises execGhObserved() directly and writes
// a JSONL trace. Deliberately mirrors the call shapes used by
// scm-github and tracker-github so we can cross-check the tracer's
// behavior against Adil's real AO run without spinning up AO.
//
// Uses public-read endpoints on ComposioHQ/agent-orchestrator. No writes.

import { execGhObserved, getGhTraceFilePath } from "../packages/core/dist/gh-trace.js";

const REPO = "ComposioHQ/agent-orchestrator";
const [owner, name] = REPO.split("/");

const traceFile = getGhTraceFilePath();
if (!traceFile) {
  console.error(
    "AO_GH_TRACE_FILE is not set. Run with: AO_GH_TRACE_FILE=/path/to/out.jsonl node drill-tracer.mjs",
  );
  process.exit(1);
}
console.log(`Trace file: ${traceFile}`);
console.log(`Target repo: ${REPO}`);

async function run(label, args, ctx) {
  process.stdout.write(`  ${label.padEnd(40)} `);
  try {
    const stdout = await execGhObserved(args, ctx, 20_000);
    console.log(`ok  (${stdout.length} bytes)`);
    return { ok: true, stdout };
  } catch (err) {
    const code = err?.code;
    const stderr = err?.stderr ? String(err.stderr).slice(0, 120) : "";
    console.log(`err exit=${code} ${stderr}`);
    return { ok: false, err };
  }
}

function extractEtagFromStdout(stdout) {
  const lines = stdout.replace(/\r/g, "").split("\n");
  for (const line of lines) {
    if (!line) break;
    const m = line.match(/^etag:\s*(.+)$/i);
    if (m) return m[1].trim();
  }
  return undefined;
}

console.log("\n=== Phase 1: baseline captures (no If-None-Match) ===");

// Shape 1: PR list guard — the one callsite that uses `-i`, exactly as
// in packages/plugins/scm-github/src/graphql-batch.ts:checkPRListETag.
const guardPRListArgs = [
  "api",
  "--method",
  "GET",
  `repos/${owner}/${name}/pulls?state=open&sort=updated&direction=desc&per_page=1`,
  "-i",
];
const guardPRList = await run("guard-pr-list (with -i)", guardPRListArgs, {
  component: "drill",
  operation: "gh.api.guard-pr-list",
});
const guardPRListEtag = guardPRList.ok ? extractEtagFromStdout(guardPRList.stdout) : undefined;
console.log(`    captured etag: ${guardPRListEtag ?? "<none>"}`);

// Shape 2: commit status guard — same pattern, but against a real SHA.
// Grab a SHA from the default branch first.
const headResult = await run(
  "fetch default branch SHA",
  ["api", `repos/${owner}/${name}/commits/HEAD`, "-i"],
  { component: "drill", operation: "gh.api.head-commit" },
);
const sha = headResult.ok
  ? (() => {
      const body = headResult.stdout.split(/\n\n/)[1] ?? "";
      const m = body.match(/"sha"\s*:\s*"([a-f0-9]{40})"/);
      return m ? m[1] : undefined;
    })()
  : undefined;
console.log(`    HEAD sha: ${sha ?? "<unresolved>"}`);

let guardCommitStatusEtag;
if (sha) {
  const guardCommitArgs = [
    "api",
    "--method",
    "GET",
    `repos/${owner}/${name}/commits/${sha}/status`,
    "-i",
  ];
  const guardCommit = await run("guard-commit-status (with -i)", guardCommitArgs, {
    component: "drill",
    operation: "gh.api.guard-commit-status",
  });
  guardCommitStatusEtag = guardCommit.ok
    ? extractEtagFromStdout(guardCommit.stdout)
    : undefined;
  console.log(`    captured etag: ${guardCommitStatusEtag ?? "<none>"}`);
}

// Shape 3: GraphQL batch — graphql-batch.ts fires this without `-i`,
// so httpStatus should be 'none' in our trace.
const graphqlArgs = [
  "api",
  "graphql",
  "-f",
  `query=query { repository(owner: "${owner}", name: "${name}") { pullRequests(first: 1, states: OPEN) { nodes { number title } } } }`,
];
await run("graphql-batch (no -i)", graphqlArgs, {
  component: "drill",
  operation: "gh.api.graphql-batch",
});

// Shape 4: higher-level gh pr list — always no status because subcommand
// parses its own response.
await run("gh pr list (cli subcommand)", ["pr", "list", "--repo", REPO, "--limit", "3", "--json", "number,title"], {
  component: "drill",
});

// Shape 5: higher-level gh pr view
await run("gh pr view (cli subcommand)", ["pr", "view", "--repo", REPO, "--json", "state"], {
  component: "drill",
}).catch(() => {
  /* repo may not have open PRs in the default query; ignore */
});

// Shape 6: gh pr checks — reproduces the `cli:pr.checks` rows in Adil's trace.
// This may fail cleanly if no PR exists; that's still a valid tracer row.
const openPrResult = await run(
  "fetch any open PR number",
  ["pr", "list", "--repo", REPO, "--limit", "1", "--json", "number", "--state", "open"],
  { component: "drill" },
);
let anyOpenPr;
if (openPrResult.ok) {
  const m = openPrResult.stdout.match(/"number"\s*:\s*(\d+)/);
  if (m) anyOpenPr = Number(m[1]);
}
if (anyOpenPr) {
  await run(`gh pr checks ${anyOpenPr}`, ["pr", "checks", String(anyOpenPr), "--repo", REPO], {
    component: "drill",
  });
}

// Shape 7: reproduce the Adil bucket `gh.api.--method` by doing a POST-style
// api call. Comments endpoint on a real PR would write; we use a GET that
// still hits `--method` so the bug shows up without side effects.
const apiMethodGetArgs = [
  "api",
  "--method",
  "GET",
  `repos/${owner}/${name}/issues?state=open&per_page=1`,
];
await run("api --method GET (reproduces --method bug)", apiMethodGetArgs, {
  component: "drill",
});

console.log("\n=== Phase 2: ETag replay (should yield 304 on exit=1) ===");

if (guardPRListEtag) {
  const replayArgs = [
    ...guardPRListArgs,
    "-H",
    `If-None-Match: ${guardPRListEtag}`,
  ];
  const result = await run("guard-pr-list replay", replayArgs, {
    component: "drill",
    operation: "gh.api.guard-pr-list",
  });
  if (!result.ok) {
    console.log(`    (expected: 304 surfaces as exit=1 — PLAN.md Phase B1 bug #1)`);
  }
}

if (guardCommitStatusEtag && sha) {
  const replayArgs = [
    "api",
    "--method",
    "GET",
    `repos/${owner}/${name}/commits/${sha}/status`,
    "-i",
    "-H",
    `If-None-Match: ${guardCommitStatusEtag}`,
  ];
  const result = await run("guard-commit-status replay", replayArgs, {
    component: "drill",
    operation: "gh.api.guard-commit-status",
  });
  if (!result.ok) {
    console.log(`    (expected: 304 surfaces as exit=1)`);
  }
}

console.log("\nDone. Analyze with:");
console.log(`  node experiments/analyze-trace.mjs ${traceFile}`);
