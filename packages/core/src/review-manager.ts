/**
 * Review manager — orchestrates the code review loop for worker PRs.
 *
 * Responsibilities:
 * - Serialize at most one reviewer workspace per worker session
 * - Track run lifecycle (reviewing → awaiting_context → done/stalled/terminated)
 * - Persist runs and findings via the review store
 * - Carry forward triage state (fingerprint-matched dismissals)
 * - Detect convergence / stalled loops
 * - Allocate project-scoped reviewer IDs
 *
 * Design choice: the reviewer workspace is a plain git worktree (no tmux, no
 * agent runtime). The CodeReview plugin runs directly in it. That keeps review
 * resource overhead tiny compared to a full AO session.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  CodeReview,
  CodeReviewConfig,
  CodeReviewFinding,
  CodeReviewLoopState,
  CodeReviewRun,
  CodeReviewRunOutcome,
  CodeReviewTerminationReason,
  ProjectConfig,
  SessionId,
} from "./types.js";
import { carryForwardTriage, detectStalled } from "./code-review-fingerprint.js";
import {
  allocateReviewerSessionId,
  createReviewStore,
  type ReviewStore,
} from "./review-store.js";
import { getReviewsDir, getReviewWorkspacesDir } from "./paths.js";

const GIT_TIMEOUT_MS = 30_000;
const execFileAsync = promisify(execFile);

export interface ReviewManagerDeps {
  /** Orchestrator config path — used to locate per-project review dirs. */
  configPath: string;
  /** Resolve a project config by ID. */
  getProject(projectId: string): ProjectConfig | undefined;
  /** Resolve the configured CodeReview plugin instance for a project. */
  resolveReviewPlugin(projectId: string): CodeReview | null;
  /** Resolve the session prefix for allocating reviewer IDs. */
  getSessionPrefix(projectId: string): string;
}

export interface ReviewManager {
  triggerReview(args: TriggerReviewArgs): Promise<CodeReviewRun>;
  dismissFinding(args: DismissArgs): Promise<CodeReviewFinding>;
  reopenFinding(args: ReopenArgs): Promise<CodeReviewFinding>;
  markSentToAgent(args: MarkSentArgs): Promise<CodeReviewFinding[]>;
  terminateRun(args: TerminateRunArgs): Promise<CodeReviewRun>;
  cleanupReviewerWorkspace(runId: string): Promise<void>;
  getStore(projectId: string): ReviewStore;
  readHeadSha(workspacePath: string): Promise<string | null>;
}

export interface TriggerReviewArgs {
  projectId: string;
  linkedSessionId: SessionId;
  workerWorkspacePath: string;
  branch: string;
  baseBranch?: string;
  configOverride?: CodeReviewConfig;
}

export interface DismissArgs {
  projectId: string;
  runId: string;
  findingId: string;
  dismissedBy: string;
}

export interface ReopenArgs {
  projectId: string;
  runId: string;
  findingId: string;
}

export interface MarkSentArgs {
  projectId: string;
  runId: string;
  findingIds: string[];
}

export interface TerminateRunArgs {
  projectId: string;
  runId: string;
  reason: CodeReviewTerminationReason;
}

export function createReviewManager(deps: ReviewManagerDeps): ReviewManager {
  const storeCache = new Map<string, ReviewStore>();

  function storeFor(projectId: string): ReviewStore {
    const cached = storeCache.get(projectId);
    if (cached) return cached;
    const project = deps.getProject(projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    const reviewsDir = getReviewsDir(deps.configPath, project.path);
    mkdirSync(reviewsDir, { recursive: true });
    // createReviewStore expects the project base dir; the reviews subdir is appended internally.
    const store = createReviewStore(join(reviewsDir, ".."));
    storeCache.set(projectId, store);
    return store;
  }

  async function readHeadSha(workspacePath: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: workspacePath,
        timeout: GIT_TIMEOUT_MS,
      });
      const sha = stdout.trim();
      return sha.length > 0 ? sha : null;
    } catch {
      return null;
    }
  }

  async function createReviewerWorktree(
    project: ProjectConfig,
    reviewerSessionId: string,
    headSha: string,
  ): Promise<string> {
    const baseDir = getReviewWorkspacesDir(deps.configPath, project.path);
    mkdirSync(baseDir, { recursive: true });
    const workspacePath = join(baseDir, reviewerSessionId);

    if (existsSync(workspacePath)) {
      try {
        await execFileAsync("git", ["worktree", "remove", "--force", workspacePath], {
          cwd: project.path,
          timeout: GIT_TIMEOUT_MS,
        });
      } catch {
        // best-effort
      }
      try {
        rmSync(workspacePath, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }

    // Detached checkout at the exact SHA being reviewed so a misbehaving plugin
    // can never accidentally commit on top of the worker's branch.
    await execFileAsync("git", ["worktree", "add", "--detach", workspacePath, headSha], {
      cwd: resolve(project.path),
      timeout: GIT_TIMEOUT_MS,
    });
    return workspacePath;
  }

  async function destroyWorktree(project: ProjectConfig, workspacePath: string): Promise<void> {
    try {
      await execFileAsync("git", ["worktree", "remove", "--force", workspacePath], {
        cwd: project.path,
        timeout: GIT_TIMEOUT_MS,
      });
    } catch {
      if (existsSync(workspacePath)) {
        try {
          rmSync(workspacePath, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    }
  }

  function priorFindingsByFingerprint(
    store: ReviewStore,
    linkedSessionId: SessionId,
  ): Map<string, CodeReviewFinding> {
    const priorFindings = store.listFindingsForSession(linkedSessionId);
    const map = new Map<string, CodeReviewFinding>();
    for (const f of priorFindings) {
      const existing = map.get(f.fingerprint);
      if (!existing || existing.createdAt < f.createdAt) {
        map.set(f.fingerprint, f);
      }
    }
    return map;
  }

  async function markOutdatedRuns(
    store: ReviewStore,
    project: ProjectConfig,
    linkedSessionId: SessionId,
    newHeadSha: string,
  ): Promise<void> {
    const runs = store.listRunsForSession(linkedSessionId);
    for (const run of runs) {
      if (run.headSha === newHeadSha) continue;
      if (run.outcome === "outdated") continue;
      if (run.outcome === "completed") {
        store.updateRun(run.runId, { outcome: "outdated" });
      }
      if (run.reviewerWorkspacePath) {
        await destroyWorktree(project, run.reviewerWorkspacePath);
        store.updateRun(run.runId, { reviewerWorkspacePath: null });
      }
    }
  }

  return {
    async triggerReview(args: TriggerReviewArgs): Promise<CodeReviewRun> {
      const project = deps.getProject(args.projectId);
      if (!project) throw new Error(`Unknown project: ${args.projectId}`);
      const plugin = deps.resolveReviewPlugin(args.projectId);
      if (!plugin) throw new Error(`No code-review plugin configured for ${args.projectId}`);

      const sessionPrefix = deps.getSessionPrefix(args.projectId);
      const store = storeFor(args.projectId);

      const headSha = await readHeadSha(args.workerWorkspacePath);
      if (!headSha) {
        throw new Error(
          `Unable to read HEAD SHA from worker workspace: ${args.workerWorkspacePath}`,
        );
      }

      // Serialize: if another run is already in-flight for this worker at this
      // SHA, reuse it. Queue new reviews — never preempt.
      const priorRuns = store.listRunsForSession(args.linkedSessionId);
      for (const run of priorRuns) {
        if (
          run.headSha === headSha &&
          (run.loopState === "reviewing" || run.loopState === "awaiting_context")
        ) {
          return run;
        }
      }

      await markOutdatedRuns(store, project, args.linkedSessionId, headSha);

      const reviewerSessionId = allocateReviewerSessionId(store.listAllRuns(), sessionPrefix);
      const workspacePath = await createReviewerWorktree(project, reviewerSessionId, headSha);

      const initialRun = store.createRun({
        reviewerSessionId,
        reviewerWorkspacePath: workspacePath,
        linkedSessionId: args.linkedSessionId,
        projectId: args.projectId,
        headSha,
        overallSummary: "",
        loopState: "reviewing",
        outcome: "completed",
      });
      const runId = initialRun.runId;

      const reviewConfig = args.configOverride ?? project.codeReview ?? {};
      const confidenceThreshold = reviewConfig.limits?.confidenceThreshold ?? 0;
      const severityThreshold = reviewConfig.severityThreshold ?? "info";
      const baseBranch = args.baseBranch ?? project.defaultBranch;

      let pluginResult;
      try {
        pluginResult = await plugin.runReview({
          reviewerWorkspacePath: workspacePath,
          baseBranch,
          headSha,
          linkedSessionId: args.linkedSessionId,
          projectId: args.projectId,
          maxBudgetUsd: reviewConfig.limits?.maxBudgetPerRun,
          confidenceThreshold,
          severityThreshold,
          prompt: reviewConfig.prompt,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const failedRun = store.updateRun(runId, {
          outcome: "failed",
          loopState: "terminated",
          terminationReason: "reviewer_failure",
          completedAt: new Date().toISOString(),
          overallSummary: `Reviewer plugin crashed: ${message}`,
        });
        await destroyWorktree(project, workspacePath);
        store.updateRun(runId, { reviewerWorkspacePath: null });
        return failedRun;
      }

      const priorByFingerprint = priorFindingsByFingerprint(store, args.linkedSessionId);

      const appended: CodeReviewFinding[] = [];
      for (const input of pluginResult.findings) {
        const finding = store.appendFinding(runId, input);
        const prior = priorByFingerprint.get(finding.fingerprint);
        const carry = carryForwardTriage(prior);
        let current = finding;
        if (carry.status === "dismissed") {
          current = store.updateFindingStatus(runId, finding.findingId, "dismissed", {
            dismissedBy: carry.dismissedBy,
          });
        }
        appended.push(current);
      }

      const openFindings = appended.filter((f) => f.status === "open");
      const loopStateInit: CodeReviewLoopState =
        openFindings.length === 0 ? "done" : "awaiting_context";
      const outcome: CodeReviewRunOutcome = pluginResult.outcome;

      let terminationReason: CodeReviewTerminationReason | undefined;
      let finalLoopState: CodeReviewLoopState = loopStateInit;

      if (loopStateInit !== "done") {
        const runs = store.listRunsForSession(args.linkedSessionId);
        const sortedRuns = [...runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const recentRunFindings: CodeReviewFinding[][] = [];
        for (const r of sortedRuns) {
          if (r.runId === runId) {
            recentRunFindings.push(appended);
          } else {
            recentRunFindings.push(store.listFindingsForRun(r.runId));
          }
        }
        const maxReviewRounds = reviewConfig.limits?.maxReviewRounds ?? 3;
        const stallWindow = reviewConfig.limits?.stallWindow ?? 3;
        const verdict = detectStalled(recentRunFindings, maxReviewRounds, stallWindow);
        if (verdict === "stalled") {
          finalLoopState = "stalled";
          terminationReason = "cycle_cap";
        }
      }

      const finalRun = store.updateRun(runId, {
        outcome,
        loopState: finalLoopState,
        terminationReason,
        completedAt: new Date().toISOString(),
        overallSummary: pluginResult.overallSummary,
        overallConfidence: pluginResult.overallConfidence,
        findingCount: appended.length,
        costUsd: pluginResult.cost?.estimatedCostUsd,
      });

      // done/stalled/failed/outdated → cleanup the workspace right away.
      // awaiting_context keeps it so sendFollowUp can chat with the reviewer.
      if (
        finalLoopState === "done" ||
        finalLoopState === "stalled" ||
        outcome === "failed" ||
        outcome === "outdated"
      ) {
        await destroyWorktree(project, workspacePath);
        store.updateRun(runId, { reviewerWorkspacePath: null });
        return { ...finalRun, reviewerWorkspacePath: null };
      }

      return finalRun;
    },

    async dismissFinding(args: DismissArgs): Promise<CodeReviewFinding> {
      const store = storeFor(args.projectId);
      return store.updateFindingStatus(args.runId, args.findingId, "dismissed", {
        dismissedBy: args.dismissedBy,
      });
    },

    async reopenFinding(args: ReopenArgs): Promise<CodeReviewFinding> {
      const store = storeFor(args.projectId);
      return store.updateFindingStatus(args.runId, args.findingId, "open");
    },

    async markSentToAgent(args: MarkSentArgs): Promise<CodeReviewFinding[]> {
      const store = storeFor(args.projectId);
      const updated: CodeReviewFinding[] = [];
      const now = new Date().toISOString();
      for (const id of args.findingIds) {
        updated.push(
          store.updateFindingStatus(args.runId, id, "sent_to_agent", { sentToAgentAt: now }),
        );
      }
      return updated;
    },

    async terminateRun(args: TerminateRunArgs): Promise<CodeReviewRun> {
      const store = storeFor(args.projectId);
      const run = store.getRun(args.runId);
      if (!run) throw new Error(`Run not found: ${args.runId}`);
      if (run.reviewerWorkspacePath) {
        const project = deps.getProject(args.projectId);
        if (project) await destroyWorktree(project, run.reviewerWorkspacePath);
      }
      return store.updateRun(args.runId, {
        loopState: "terminated",
        terminationReason: args.reason,
        reviewerWorkspacePath: null,
        completedAt: new Date().toISOString(),
      });
    },

    async cleanupReviewerWorkspace(runId: string): Promise<void> {
      for (const projectId of storeCache.keys()) {
        const store = storeCache.get(projectId)!;
        const run = store.getRun(runId);
        if (!run) continue;
        if (run.reviewerWorkspacePath) {
          const project = deps.getProject(projectId);
          if (project) await destroyWorktree(project, run.reviewerWorkspacePath);
        }
        store.updateRun(runId, { reviewerWorkspacePath: null });
        return;
      }
    },

    getStore(projectId: string): ReviewStore {
      return storeFor(projectId);
    },

    readHeadSha,
  };
}
