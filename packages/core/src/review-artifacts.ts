/**
 * Review artifacts for multi-phase workflows.
 *
 * Layout inside a worktree:
 *   .ao/plan.md
 *   .ao/reviews/{phase}-round-{N}-{role}.md
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReviewerRole, SwarmReviewDecision } from "./types.js";

export type ReviewPhase = "plan_review" | "code_review";

export interface ReviewArtifact {
  phase: ReviewPhase;
  round: number;
  role: ReviewerRole;
  decision: SwarmReviewDecision;
  timestamp: string;
  content: string;
  path?: string;
}

const REVIEW_DECISIONS = new Set<SwarmReviewDecision>(["approved", "changes_requested", "pending"]);

function getAoDir(worktreePath: string): string {
  return join(worktreePath, ".ao");
}

function getReviewsDir(worktreePath: string): string {
  return join(getAoDir(worktreePath), "reviews");
}

function ensureAoDirs(worktreePath: string): void {
  mkdirSync(getAoDir(worktreePath), { recursive: true });
  mkdirSync(getReviewsDir(worktreePath), { recursive: true });
}

function parseHeaderAndBody(raw: string): { header: Record<string, string>; body: string } {
  const lines = raw.split(/\r?\n/);
  const header: Record<string, string> = {};
  let separator = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "---") {
      separator = i;
      break;
    }
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key.length > 0) {
      header[key] = value;
    }
  }

  const body = separator === -1 ? "" : lines.slice(separator + 1).join("\n").trim();
  return { header, body };
}

function parseRound(raw: string | undefined, fallback = 1): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseDecision(raw: string | undefined): SwarmReviewDecision {
  if (!raw || !REVIEW_DECISIONS.has(raw as SwarmReviewDecision)) {
    return "pending";
  }
  return raw as SwarmReviewDecision;
}

function reviewFilename(artifact: Pick<ReviewArtifact, "phase" | "round" | "role">): string {
  return `${artifact.phase}-round-${artifact.round}-${artifact.role}.md`;
}

export function writePlanArtifact(worktreePath: string, content: string): void {
  ensureAoDirs(worktreePath);
  writeFileSync(join(getAoDir(worktreePath), "plan.md"), content, "utf-8");
}

export function readPlanArtifact(worktreePath: string): string | null {
  const path = join(getAoDir(worktreePath), "plan.md");
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

export function writeReviewArtifact(worktreePath: string, review: ReviewArtifact): void {
  ensureAoDirs(worktreePath);
  const path = join(getReviewsDir(worktreePath), reviewFilename(review));

  const payload = [
    `decision=${review.decision}`,
    `round=${review.round}`,
    `phase=${review.phase}`,
    `role=${review.role}`,
    `timestamp=${review.timestamp}`,
    "---",
    review.content.trim(),
    "",
  ].join("\n");

  writeFileSync(path, payload, "utf-8");
}

export function readReviewArtifacts(
  worktreePath: string,
  phase: ReviewPhase,
  round: number,
): ReviewArtifact[] {
  const reviewsDir = getReviewsDir(worktreePath);
  if (!existsSync(reviewsDir)) return [];

  const pattern = new RegExp(
    `^${phase}-round-${round}-(architect|developer|product)\\.md$`,
  );

  const artifacts: ReviewArtifact[] = [];
  const files = readdirSync(reviewsDir).filter((name) => pattern.test(name)).sort();

  for (const file of files) {
    const fullPath = join(reviewsDir, file);
    const raw = readFileSync(fullPath, "utf-8");
    const { header, body } = parseHeaderAndBody(raw);
    const roleFromFilename = (file.match(/-(architect|developer|product)\.md$/)?.[1] ??
      "developer") as ReviewerRole;

    artifacts.push({
      // Trust canonical file path for identity fields. Header values are informational.
      phase,
      round,
      role: roleFromFilename,
      decision: parseDecision(header["decision"]),
      timestamp: header["timestamp"] ?? "",
      content: body,
      path: fullPath,
    });
  }

  return artifacts;
}

export function isAllApproved(reviews: ReviewArtifact[]): boolean {
  return reviews.length > 0 && reviews.every((review) => review.decision === "approved");
}

export function getLatestRound(worktreePath: string, phase: ReviewPhase): number {
  const reviewsDir = getReviewsDir(worktreePath);
  if (!existsSync(reviewsDir)) return 0;

  const pattern = new RegExp(`^${phase}-round-(\\d+)-(architect|developer|product)\\.md$`);
  let maxRound = 0;

  for (const file of readdirSync(reviewsDir)) {
    const match = file.match(pattern);
    if (!match) continue;
    const round = parseRound(match[1], 0);
    if (round > maxRound) {
      maxRound = round;
    }
  }

  return maxRound;
}
