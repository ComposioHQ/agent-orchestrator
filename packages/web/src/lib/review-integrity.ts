import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  ReviewResolutionStore,
  createResolutionRecord,
  evaluateMergeGuard,
  evaluateReviewIntegrity,
  getReviewIntegrityDir,
  validateResolutionRecord,
  type CICheck,
  type MergeGuardEvaluation,
  type OrchestratorConfig,
  type PRInfo,
  type ProjectConfig,
  type ResolutionRecord,
  type ResolutionType,
  type ReviewThreadSnapshot,
  type SCM,
} from "@composio/ao-core";

const execFileAsync = promisify(execFile);

export const REVIEW_INTEGRITY_DEFAULTS = {
  requireEvidenceForBotThreads: true,
  requiredChecks: ["review-integrity", "ao/merge-guard"],
  reverifyOnNewCommits: true,
} as const;

export interface ReviewIntegritySCM extends SCM {
  getReviewThreadSnapshots?(pr: PRInfo): Promise<ReviewThreadSnapshot[]>;
  getPRHeadSha?(pr: PRInfo): Promise<string>;
  resolveReviewThread?(pr: PRInfo, threadId: string): Promise<void>;
  publishCheckRun?(input: {
    pr: PRInfo;
    name: string;
    status: "completed";
    conclusion: "success" | "failure";
    summary: string;
    text?: string;
  }): Promise<void>;
}

export function getReviewResolutionStore(
  config: OrchestratorConfig,
  project: ProjectConfig,
): ReviewResolutionStore {
  const dir = (() => {
    try {
      return getReviewIntegrityDir(config.configPath, project.path);
    } catch {
      return join(project.path, ".ao-review-integrity");
    }
  })();
  return new ReviewResolutionStore(dir);
}

export function hashThreadBody(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

export async function getThreadSnapshots(
  scm: ReviewIntegritySCM,
  pr: PRInfo,
): Promise<ReviewThreadSnapshot[]> {
  if (scm.getReviewThreadSnapshots) {
    return scm.getReviewThreadSnapshots(pr);
  }

  throw new Error("SCM does not support full review thread snapshots");
}

export function normalizeCheckState(status: CICheck["status"]): "passed" | "pending" | "failed" {
  if (status === "passed") return "passed";
  if (status === "pending" || status === "running") return "pending";
  return "failed";
}

export function buildCheckConclusions(
  checks: CICheck[],
): Map<string, "passed" | "pending" | "failed"> {
  const map = new Map<string, "passed" | "pending" | "failed">();
  for (const check of checks) {
    map.set(check.name, normalizeCheckState(check.status));
  }
  return map;
}

async function gitInDir(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function isCommitReachable(workspacePath: string, commitSha: string): Promise<boolean> {
  try {
    await gitInDir(["merge-base", "--is-ancestor", commitSha, "HEAD"], workspacePath);
    return true;
  } catch {
    return false;
  }
}

async function getCommitTimestamp(workspacePath: string, commitSha: string): Promise<Date | null> {
  try {
    const raw = await gitInDir(["show", "-s", "--format=%cI", commitSha], workspacePath);
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  } catch {
    return null;
  }
}

function fallbackThread(record: ResolutionRecord): ReviewThreadSnapshot {
  return {
    prNumber: record.prNumber,
    threadId: record.threadId,
    source: "other",
    bodyHash: "unknown",
    severity: "unknown",
    status: "resolved",
    capturedAt: new Date(),
  };
}

export async function validateResolutionWithGit(
  record: ResolutionRecord,
  thread: ReviewThreadSnapshot | undefined,
  opts: {
    workspacePath?: string;
    headSha?: string;
    requireEvidenceForBotThreads?: boolean;
  },
): Promise<string[]> {
  const workspacePath = opts.workspacePath;
  const gitReachable = new Map<string, boolean>();
  const gitTimestamps = new Map<string, Date | null>();

  if (workspacePath && record.fixCommitSha) {
    gitReachable.set(
      record.fixCommitSha,
      await isCommitReachable(workspacePath, record.fixCommitSha),
    );
    if (record.resolutionType === "already_fixed") {
      gitTimestamps.set(
        record.fixCommitSha,
        await getCommitTimestamp(workspacePath, record.fixCommitSha),
      );
    }
  }

  const blockers = validateResolutionRecord(record, thread ?? fallbackThread(record), {
    currentHeadSha: opts.headSha,
    requireEvidenceForBotThreads: opts.requireEvidenceForBotThreads,
    isCommitReachable: (sha) => gitReachable.get(sha) ?? false,
    getCommitTimestamp: (sha) => gitTimestamps.get(sha) ?? null,
  });

  return [...new Set(blockers)];
}

export async function evaluateMergeGuardForPR(input: {
  scm: ReviewIntegritySCM;
  pr: PRInfo;
  recordsByThread: Map<string, ResolutionRecord>;
  requiredChecks?: string[];
  requireEvidenceForBotThreads?: boolean;
  reverifyOnNewCommits?: boolean;
}): Promise<{
  integrity: ReturnType<typeof evaluateReviewIntegrity>;
  guard: MergeGuardEvaluation;
}> {
  if (!input.scm.getReviewThreadSnapshots) {
    const checks = await input.scm.getCIChecks(input.pr);
    const checkConclusions = buildCheckConclusions(checks);
    const integrity = {
      status: "fail" as const,
      unresolvedThreadCount: 0,
      unverifiedResolvedThreadCount: 0,
      blockers: [
        {
          code: "THREAD_SNAPSHOTS_UNAVAILABLE" as const,
          message: "SCM does not support full review thread snapshots",
        },
      ],
    };

    checkConclusions.set("review-integrity", "failed");
    const guard = evaluateMergeGuard({
      integrity,
      requiredChecks: [...(input.requiredChecks ?? REVIEW_INTEGRITY_DEFAULTS.requiredChecks)],
      checkConclusions: new Map([...checkConclusions, ["ao/merge-guard", "failed"]]),
    });

    return { integrity, guard };
  }

  const threadSnapshots = await getThreadSnapshots(input.scm, input.pr);
  const checks = await input.scm.getCIChecks(input.pr);
  const checkConclusions = buildCheckConclusions(checks);

  const headSha = input.scm.getPRHeadSha ? await input.scm.getPRHeadSha(input.pr) : undefined;
  const integrity = evaluateReviewIntegrity(threadSnapshots, input.recordsByThread, {
    currentHeadSha: input.reverifyOnNewCommits ? headSha : undefined,
    requireEvidenceForBotThreads: input.requireEvidenceForBotThreads,
  });

  if (integrity.status === "pass") {
    checkConclusions.set("review-integrity", "passed");
  } else {
    checkConclusions.set("review-integrity", "failed");
  }

  const guard = evaluateMergeGuard({
    integrity,
    requiredChecks: [...(input.requiredChecks ?? REVIEW_INTEGRITY_DEFAULTS.requiredChecks)],
    checkConclusions: new Map([
      ...checkConclusions,
      ["ao/merge-guard", integrity.status === "pass" ? "passed" : "failed"],
    ]),
  });

  return { integrity, guard };
}

export async function publishGuardChecks(
  scm: ReviewIntegritySCM,
  pr: PRInfo,
  integrity: ReturnType<typeof evaluateReviewIntegrity>,
  guard: MergeGuardEvaluation,
): Promise<void> {
  if (!scm.publishCheckRun) return;

  await scm.publishCheckRun({
    pr,
    name: "review-integrity",
    status: "completed",
    conclusion: integrity.status === "pass" ? "success" : "failure",
    summary:
      integrity.status === "pass"
        ? "All review threads satisfy resolution integrity rules"
        : `${integrity.blockers.length} integrity blocker(s) detected`,
    text: integrity.blockers.map((b) => `- ${b.message}`).join("\n"),
  });

  await scm.publishCheckRun({
    pr,
    name: "ao/merge-guard",
    status: "completed",
    conclusion: guard.allowMerge ? "success" : "failure",
    summary: guard.allowMerge
      ? "Merge guard passed"
      : `${guard.blockers.length} merge blocker(s) detected`,
    text: guard.blockers.map((b) => `- ${b.message}`).join("\n"),
  });
}

export function buildResolutionRecordInput(input: {
  prNumber: number;
  threadId: string;
  resolutionType: ResolutionType;
  actorId: string;
  fixCommitSha?: string;
  rationale?: string;
  evidence?: {
    changedFiles?: string[];
    testCommands?: string[];
    testResults?: string[];
  };
}): Omit<ResolutionRecord, "id" | "createdAt"> {
  return createResolutionRecord({
    prNumber: input.prNumber,
    threadId: input.threadId,
    resolutionType: input.resolutionType,
    actorType: "agent",
    actorId: input.actorId,
    fixCommitSha: input.fixCommitSha,
    rationale: input.rationale,
    evidence: {
      changedFiles: input.evidence?.changedFiles ?? [],
      testCommands: input.evidence?.testCommands ?? [],
      testResults: input.evidence?.testResults ?? [],
    },
  });
}
