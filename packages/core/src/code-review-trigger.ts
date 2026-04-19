/**
 * Bridge between the lifecycle manager and the review manager.
 *
 * The lifecycle manager exposes a generic `onSessionPolled` hook. This module
 * wraps a ReviewManager into a poll-cycle callback that:
 *   1. Skips sessions without a codeReview configuration or in a non-reviewable
 *      status.
 *   2. Reads HEAD SHA from the worker's workspace to detect fresh commits.
 *   3. Triggers a review if the SHA hasn't been reviewed yet and the project's
 *      configured trigger flags allow it.
 *
 * Kept as a standalone module so the lifecycle manager itself stays agnostic
 * of the review slot.
 */

import type {
  CodeReviewConfig,
  OrchestratorConfig,
  Session,
  SessionStatus,
} from "./types.js";
import type { ReviewManager } from "./review-manager.js";

/** Statuses during which we want the reviewer to run. */
const REVIEW_STATUSES: ReadonlySet<SessionStatus> = new Set([
  "pr_open",
  "review_pending",
  "changes_requested",
  "ci_failed",
]);

export interface CreateReviewTriggerDeps {
  config: OrchestratorConfig;
  reviewManager: ReviewManager;
}

export function createReviewTrigger(
  deps: CreateReviewTriggerDeps,
): (session: Session, status: SessionStatus) => Promise<void> {
  const lastReviewedSha = new Map<string, string>();

  return async function onSessionPolled(
    session: Session,
    status: SessionStatus,
  ): Promise<void> {
    if (!session.workspacePath) return;
    if (!REVIEW_STATUSES.has(status)) return;

    const project = deps.config.projects[session.projectId];
    if (!project) return;

    const reviewConfig: CodeReviewConfig | undefined = project.codeReview;
    if (!reviewConfig || reviewConfig.mode === "disabled") return;

    const trigger = reviewConfig.trigger ?? {};
    const isPROpenTrigger = status === "pr_open" && trigger.onPullRequestOpen !== false;
    const isUpdateTrigger =
      (status === "review_pending" ||
        status === "changes_requested" ||
        status === "ci_failed") &&
      trigger.onPullRequestUpdate !== false;

    if (reviewConfig.mode === "manual-only") return;
    if (!isPROpenTrigger && !isUpdateTrigger) return;

    const headSha = await deps.reviewManager.readHeadSha(session.workspacePath);
    if (!headSha) return;

    if (lastReviewedSha.get(session.id) === headSha) return;

    try {
      await deps.reviewManager.triggerReview({
        projectId: session.projectId,
        linkedSessionId: session.id,
        workerWorkspacePath: session.workspacePath,
        branch: session.branch ?? project.defaultBranch,
        baseBranch: project.defaultBranch,
      });
      lastReviewedSha.set(session.id, headSha);
    } catch {
      // Swallow — next poll cycle will try again. Errors are surfaced via the
      // review store and dashboards, not by crashing the poll.
    }
  };
}
