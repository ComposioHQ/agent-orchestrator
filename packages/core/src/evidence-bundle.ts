/**
 * Evidence Bundle — structured evidence generation and review gate (bd-2gz)
 *
 * Two-stage evidence review:
 * 1. Generate bundles with CI check runs, file diffs, changed files, verdict
 * 2. Review bundles and return PASS/FAIL for merge gate condition 6
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SCM, PRInfo, CICheck } from "./types.js";

// =============================================================================
// TYPES
// =============================================================================

export interface EvidenceBundle {
  prNumber: number;
  prUrl: string;
  branch: string;
  generatedAt: string; // ISO string
  ciChecks: CICheckEvidence[];
  changedFiles: string[];
  diffStats: { additions: number; deletions: number; filesChanged: number };
  verdict: EvidenceVerdict;
}

export interface CICheckEvidence {
  name: string;
  status: string;
  conclusion: string | null;
  url: string | null;
}

export interface EvidenceVerdict {
  passed: boolean;
  reasons: string[];
  reviewedAt: string; // ISO string
}

// =============================================================================
// PRIVATE HELPERS
// =============================================================================

function parseDiffStats(statOutput: string): {
  additions: number;
  deletions: number;
  filesChanged: number;
} {
  const match = statOutput.match(
    /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/,
  );
  if (!match) {
    return { additions: 0, deletions: 0, filesChanged: 0 };
  }
  return {
    filesChanged: parseInt(match[1] ?? "0", 10),
    additions: parseInt(match[2] ?? "0", 10),
    deletions: parseInt(match[3] ?? "0", 10),
  };
}

function mapCICheck(check: CICheck): CICheckEvidence {
  return {
    name: check.name,
    status: check.status,
    conclusion: check.conclusion ?? null,
    url: check.url ?? null,
  };
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Generate a structured evidence bundle for a PR.
 * Collects CI checks from SCM and git diff information from the workspace.
 */
export async function generateEvidenceBundle(
  pr: PRInfo,
  scm: SCM,
  workspacePath: string,
): Promise<EvidenceBundle> {
  const ciChecks = await scm.getCIChecks(pr);

  const diffRef = `${pr.baseBranch}...HEAD`;

  const nameOnlyOutput = execFileSync(
    "git",
    ["diff", "--name-only", diffRef],
    { cwd: workspacePath, encoding: "utf8" },
  );
  const changedFiles = String(nameOnlyOutput)
    .split("\n")
    .filter((f) => f.trim().length > 0);

  const statOutput = execFileSync(
    "git",
    ["diff", "--stat", diffRef],
    { cwd: workspacePath, encoding: "utf8" },
  );
  const diffStats = parseDiffStats(String(statOutput));

  const partialBundle = {
    prNumber: pr.number,
    prUrl: pr.url,
    branch: pr.branch,
    generatedAt: new Date().toISOString(),
    ciChecks: ciChecks.map(mapCICheck),
    changedFiles,
    diffStats,
  };

  // Compute verdict with a placeholder bundle (verdict field not used in review)
  const placeholderBundle: EvidenceBundle = {
    ...partialBundle,
    verdict: { passed: false, reasons: [], reviewedAt: "" },
  };
  const verdict = reviewEvidenceBundle(placeholderBundle);

  return { ...partialBundle, verdict };
}

/**
 * Review an evidence bundle and return a verdict.
 * Checks that all CI checks passed and at least one file was changed.
 */
export function reviewEvidenceBundle(bundle: EvidenceBundle): EvidenceVerdict {
  const reasons: string[] = [];

  for (const check of bundle.ciChecks) {
    if (check.status !== "passed" && check.status !== "skipped") {
      reasons.push(`CI check '${check.name}' is not passing (status: ${check.status})`);
    }
  }

  if (bundle.changedFiles.length === 0) {
    reasons.push("No files changed in this PR");
  }

  return {
    passed: reasons.length === 0,
    reasons,
    reviewedAt: new Date().toISOString(),
  };
}

/**
 * Write an evidence bundle to disk.
 * Creates bundle.json (full bundle) and verdict.json (just the verdict) in outputDir.
 */
export function writeEvidenceBundle(bundle: EvidenceBundle, outputDir: string): void {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, "bundle.json"), JSON.stringify(bundle, null, 2));
  writeFileSync(join(outputDir, "verdict.json"), JSON.stringify(bundle.verdict, null, 2));
}
