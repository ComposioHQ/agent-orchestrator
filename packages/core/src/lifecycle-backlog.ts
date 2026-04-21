/**
 * Backlog dispatchers — review comments, CI failures, and merge conflicts.
 *
 * These fire once per poll cycle after the primary lifecycle transition has
 * been handled. Each dispatcher deduplicates on a fingerprint of the fetched
 * items so that repeated polls don't spam the agent; when the batch
 * enrichment cache has relevant data, it is preferred over individual REST
 * calls.
 */

import {
  TERMINAL_STATUSES,
  type CICheck,
  type EventPriority,
  type OpenCodeSessionManager,
  type OrchestratorConfig,
  type OrchestratorEvent,
  type PluginRegistry,
  type ReactionConfig,
  type ReactionResult,
  type SCM,
  type Session,
  type SessionStatus,
} from "./types.js";
import { createEvent, makeFingerprint } from "./lifecycle-events.js";
import { formatAutomatedCommentsMessage } from "./format-automated-comments.js";
import { DEFAULT_BUGBOT_COMMENTS_MESSAGE } from "./config.js";
import type { ReactionEngine } from "./reaction-engine.js";
import type { PREnrichmentCache } from "./pr-enrichment-cache.js";

export type NotifyHuman = (event: OrchestratorEvent, priority: EventPriority) => Promise<void>;
export type UpdateSessionMetadata = (
  session: Session,
  updates: Partial<Record<string, string>>,
) => void;

export interface BacklogDispatchers {
  maybeDispatchReviewBacklog(
    session: Session,
    oldStatus: SessionStatus,
    newStatus: SessionStatus,
    transitionReaction?: { key: string; result: ReactionResult | null },
  ): Promise<void>;
  maybeDispatchCIFailureDetails(
    session: Session,
    oldStatus: SessionStatus,
    newStatus: SessionStatus,
    transitionReaction?: { key: string; result: ReactionResult | null },
  ): Promise<void>;
  maybeDispatchMergeConflicts(session: Session, newStatus: SessionStatus): Promise<void>;
  /** Drop throttle entries for sessions no longer present. */
  pruneReviewBacklogThrottle(currentSessionIds: Set<string>): void;
  /** Clear throttle entry for a single session. */
  clearReviewBacklogThrottle(sessionId: string): void;
}

export interface BacklogDispatchersDeps {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  sessionManager: OpenCodeSessionManager;
  reactionEngine: ReactionEngine;
  prEnrichmentCache: PREnrichmentCache;
  updateSessionMetadata: UpdateSessionMetadata;
  notifyHuman: NotifyHuman;
}

/** Throttle interval for review backlog API calls (2 minutes). */
const REVIEW_BACKLOG_THROTTLE_MS = 2 * 60 * 1000;

/**
 * Format CI check failures into a human-readable message for the agent.
 * Includes check names, statuses, and links for debugging.
 */
export function formatCIFailureMessage(failedChecks: CICheck[]): string {
  const lines = ["CI checks are failing on your PR. Here are the failed checks:", ""];
  for (const check of failedChecks) {
    const status = check.conclusion ?? check.status;
    const link = check.url ? ` — ${check.url}` : "";
    lines.push(`- **${check.name}**: ${status}${link}`);
  }
  lines.push("", "Investigate the failures, fix the issues, and push again.");
  return lines.join("\n");
}

export function createBacklogDispatchers(deps: BacklogDispatchersDeps): BacklogDispatchers {
  const {
    config,
    registry,
    sessionManager,
    reactionEngine,
    prEnrichmentCache,
    updateSessionMetadata,
    notifyHuman,
  } = deps;

  /**
   * Per-session timestamp of last review backlog API check.
   * Used to throttle getPendingComments/getAutomatedComments to at most once per 2 minutes.
   * In-memory only — resets on restart (acceptable since it's a rate-limit hint, not state).
   */
  const lastReviewBacklogCheckAt = new Map<string, number>();

  async function maybeDispatchReviewBacklog(
    session: Session,
    oldStatus: SessionStatus,
    newStatus: SessionStatus,
    transitionReaction?: { key: string; result: ReactionResult | null },
  ): Promise<void> {
    const project = config.projects[session.projectId];
    if (!project || !session.pr) return;

    const scm = project.scm?.plugin ? registry.get<SCM>("scm", project.scm.plugin) : null;
    if (!scm) return;

    const humanReactionKey = "changes-requested";
    const automatedReactionKey = "bugbot-comments";

    if (TERMINAL_STATUSES.has(newStatus) || session.lifecycle.pr.state !== "open") {
      reactionEngine.clearTracker(session.id, humanReactionKey);
      reactionEngine.clearTracker(session.id, automatedReactionKey);
      lastReviewBacklogCheckAt.delete(session.id);
      updateSessionMetadata(session, {
        lastPendingReviewFingerprint: "",
        lastPendingReviewDispatchHash: "",
        lastPendingReviewDispatchAt: "",
        lastAutomatedReviewFingerprint: "",
        lastAutomatedReviewDispatchHash: "",
        lastAutomatedReviewDispatchAt: "",
      });
      return;
    }

    // Throttle review backlog API calls to at most once per 2 minutes.
    // Comments don't change faster than this in practice, and the SCM calls
    // (getPendingComments + getAutomatedComments) consume API quota on every poll.
    //
    // Exception: bypass throttle when a transition reaction just fired for a
    // review reaction key. The transitionReaction branch records
    // lastPendingReviewDispatchHash, which requires the current fingerprint from
    // the API. If we throttle here, that metadata never gets written and the
    // next unthrottled poll sees a "new" fingerprint, clears the reaction tracker,
    // and fires a duplicate dispatch.
    const hasRelevantTransition =
      transitionReaction?.key === humanReactionKey ||
      transitionReaction?.key === automatedReactionKey;
    if (!hasRelevantTransition) {
      const lastCheckAt = lastReviewBacklogCheckAt.get(session.id) ?? 0;
      if (Date.now() - lastCheckAt < REVIEW_BACKLOG_THROTTLE_MS) {
        return;
      }
    }
    lastReviewBacklogCheckAt.set(session.id, Date.now());

    const [pendingResult, automatedResult] = await Promise.allSettled([
      scm.getPendingComments(session.pr),
      scm.getAutomatedComments(session.pr),
    ]);

    // null means "failed to fetch" — preserve existing metadata.
    // [] means "confirmed no comments" — safe to clear.
    const pendingComments =
      pendingResult.status === "fulfilled" && Array.isArray(pendingResult.value)
        ? pendingResult.value
        : null;
    const automatedComments =
      automatedResult.status === "fulfilled" && Array.isArray(automatedResult.value)
        ? automatedResult.value
        : null;

    // --- Pending (human) review comments ---
    // null = SCM fetch failed; skip processing to preserve existing metadata.
    if (pendingComments !== null) {
      const pendingFingerprint = makeFingerprint(pendingComments.map((comment) => comment.id));
      const lastPendingFingerprint = session.metadata["lastPendingReviewFingerprint"] ?? "";
      const lastPendingDispatchHash = session.metadata["lastPendingReviewDispatchHash"] ?? "";

      if (
        pendingFingerprint !== lastPendingFingerprint &&
        transitionReaction?.key !== humanReactionKey
      ) {
        reactionEngine.clearTracker(session.id, humanReactionKey);
      }
      if (pendingFingerprint !== lastPendingFingerprint) {
        updateSessionMetadata(session, {
          lastPendingReviewFingerprint: pendingFingerprint,
        });
      }

      if (!pendingFingerprint) {
        reactionEngine.clearTracker(session.id, humanReactionKey);
        updateSessionMetadata(session, {
          lastPendingReviewFingerprint: "",
          lastPendingReviewDispatchHash: "",
          lastPendingReviewDispatchAt: "",
        });
      } else if (
        transitionReaction?.key === humanReactionKey &&
        transitionReaction.result?.success
      ) {
        if (lastPendingDispatchHash !== pendingFingerprint) {
          updateSessionMetadata(session, {
            lastPendingReviewDispatchHash: pendingFingerprint,
            lastPendingReviewDispatchAt: new Date().toISOString(),
          });
        }
      } else if (
        !(oldStatus !== newStatus && newStatus === "changes_requested") &&
        pendingFingerprint !== lastPendingDispatchHash
      ) {
        const reactionConfig = reactionEngine.getReactionConfigForSession(session, humanReactionKey);
        if (
          reactionConfig &&
          reactionConfig.action &&
          (reactionConfig.auto !== false || reactionConfig.action === "notify")
        ) {
          const result = await reactionEngine.executeReaction(
            session.id,
            session.projectId,
            humanReactionKey,
            reactionConfig,
          );
          if (result.success) {
            updateSessionMetadata(session, {
              lastPendingReviewDispatchHash: pendingFingerprint,
              lastPendingReviewDispatchAt: new Date().toISOString(),
            });
          }
        }
      }
    }

    // --- Automated (bot) review comments ---
    if (automatedComments !== null) {
      const automatedFingerprint = makeFingerprint(
        automatedComments.map((comment) => comment.id),
      );
      const lastAutomatedFingerprint = session.metadata["lastAutomatedReviewFingerprint"] ?? "";
      const lastAutomatedDispatchHash =
        session.metadata["lastAutomatedReviewDispatchHash"] ?? "";

      if (automatedFingerprint !== lastAutomatedFingerprint) {
        reactionEngine.clearTracker(session.id, automatedReactionKey);
        updateSessionMetadata(session, {
          lastAutomatedReviewFingerprint: automatedFingerprint,
        });
      }

      if (!automatedFingerprint) {
        reactionEngine.clearTracker(session.id, automatedReactionKey);
        updateSessionMetadata(session, {
          lastAutomatedReviewFingerprint: "",
          lastAutomatedReviewDispatchHash: "",
          lastAutomatedReviewDispatchAt: "",
        });
      } else if (automatedFingerprint !== lastAutomatedDispatchHash) {
        const reactionConfig = reactionEngine.getReactionConfigForSession(
          session,
          automatedReactionKey,
        );
        if (
          reactionConfig &&
          reactionConfig.action &&
          (reactionConfig.auto !== false || reactionConfig.action === "notify")
        ) {
          // Inject the detailed comment listing + correct-API guidance into the
          // message so the agent doesn't re-fetch with stale or unpaginated calls
          // (see #895 — fixes the pagination + stale `gh pr checks` failure modes).
          // Only override when the message is the built-in sentinel — a user who
          // customized `reactions.bugbot-comments.message` in their YAML gets
          // exactly what they wrote, nothing more.
          const usingDefaultMessage =
            reactionConfig.message === DEFAULT_BUGBOT_COMMENTS_MESSAGE;
          const detailedConfig: ReactionConfig =
            reactionConfig.action === "send-to-agent" && usingDefaultMessage
              ? {
                  ...reactionConfig,
                  message: formatAutomatedCommentsMessage(automatedComments, session.pr),
                }
              : reactionConfig;
          const result = await reactionEngine.executeReaction(
            session.id,
            session.projectId,
            automatedReactionKey,
            detailedConfig,
          );
          if (result.success) {
            updateSessionMetadata(session, {
              lastAutomatedReviewDispatchHash: automatedFingerprint,
              lastAutomatedReviewDispatchAt: new Date().toISOString(),
            });
          }
        }
      }
    }
  }

  /**
   * Dispatch CI failure details to the agent session when new or changed
   * failures are detected. Follows the same fingerprinting/deduplication
   * pattern as maybeDispatchReviewBacklog().
   */
  async function maybeDispatchCIFailureDetails(
    session: Session,
    _oldStatus: SessionStatus,
    newStatus: SessionStatus,
    transitionReaction?: { key: string; result: ReactionResult | null },
  ): Promise<void> {
    const project = config.projects[session.projectId];
    if (!project || !session.pr) return;

    const scm = project.scm?.plugin ? registry.get<SCM>("scm", project.scm.plugin) : null;
    if (!scm) return;

    const ciReactionKey = "ci-failed";

    // Clear tracking when PR is closed/merged
    if (newStatus === "merged" || newStatus === "killed") {
      reactionEngine.clearTracker(session.id, ciReactionKey);
      updateSessionMetadata(session, {
        lastCIFailureFingerprint: "",
        lastCIFailureDispatchHash: "",
        lastCIFailureDispatchAt: "",
      });
      return;
    }

    // Only dispatch CI details when in ci_failed state
    if (newStatus !== "ci_failed") {
      // CI is no longer failing — clear tracking so next failure is dispatched fresh
      const lastFingerprint = session.metadata["lastCIFailureFingerprint"] ?? "";
      if (lastFingerprint) {
        reactionEngine.clearTracker(session.id, ciReactionKey);
        updateSessionMetadata(session, {
          lastCIFailureFingerprint: "",
          lastCIFailureDispatchHash: "",
          lastCIFailureDispatchAt: "",
        });
      }
      return;
    }

    // Fetch individual CI checks for failure details.
    // Use batch enrichment data when available to avoid an extra REST call;
    // fall back to getCIChecks() when the batch didn't run this cycle.
    const prKey = `${session.pr.owner}/${session.pr.repo}#${session.pr.number}`;
    const cachedEnrichment = prEnrichmentCache.get(prKey);

    let checks: CICheck[];
    if (cachedEnrichment?.ciChecks !== undefined) {
      checks = cachedEnrichment.ciChecks;
    } else {
      try {
        checks = await scm.getCIChecks(session.pr);
      } catch {
        // Failed to fetch checks — skip this cycle
        return;
      }
    }

    const failedChecks = checks.filter(
      (c) => c.status === "failed" || c.conclusion?.toUpperCase() === "FAILURE",
    );
    if (failedChecks.length === 0) return;

    const ciFingerprint = makeFingerprint(
      failedChecks.map((c) => `${c.name}:${c.status}:${c.conclusion ?? ""}`),
    );
    const lastCIFingerprint = session.metadata["lastCIFailureFingerprint"] ?? "";
    const lastCIDispatchHash = session.metadata["lastCIFailureDispatchHash"] ?? "";

    // Reset reaction tracker when failure set changes
    if (ciFingerprint !== lastCIFingerprint && transitionReaction?.key !== ciReactionKey) {
      reactionEngine.clearTracker(session.id, ciReactionKey);
    }
    if (ciFingerprint !== lastCIFingerprint) {
      updateSessionMetadata(session, {
        lastCIFailureFingerprint: ciFingerprint,
      });
    }

    // If transition already sent a ci-failed reaction with the static message,
    // skip this cycle but do NOT record dispatch hash — the next poll will send
    // the detailed CI failure info with check names and URLs.
    if (transitionReaction?.key === ciReactionKey && transitionReaction.result?.success) {
      return;
    }

    // Skip if we already dispatched this exact failure set
    if (ciFingerprint === lastCIDispatchHash) return;

    // Dispatch CI failure details directly via sessionManager.send() rather than
    // executeReaction() to avoid consuming the ci-failed reaction's retry budget.
    // The transition reaction owns escalation; this is a follow-up info delivery.
    const reactionConfig = reactionEngine.getReactionConfigForSession(session, ciReactionKey);
    if (
      reactionConfig &&
      reactionConfig.action &&
      (reactionConfig.auto !== false || reactionConfig.action === "notify")
    ) {
      const detailedMessage = formatCIFailureMessage(failedChecks);

      try {
        if (reactionConfig.action === "send-to-agent") {
          await sessionManager.send(session.id, detailedMessage);
        } else {
          // For "notify" action, send to human notifiers instead
          const event = createEvent("ci.failing", {
            sessionId: session.id,
            projectId: session.projectId,
            message: detailedMessage,
            data: { failedChecks: failedChecks.map((c) => c.name) },
          });
          await notifyHuman(event, reactionConfig.priority ?? "warning");
        }

        updateSessionMetadata(session, {
          lastCIFailureDispatchHash: ciFingerprint,
          lastCIFailureDispatchAt: new Date().toISOString(),
        });
      } catch {
        // Send failed — will retry on next poll cycle
      }
    }
  }

  /**
   * Dispatch merge conflict notifications to the agent session.
   * Conflicts are detected from the PR enrichment cache or getMergeability()
   * and dispatched independently of the session status (conflicts can coexist
   * with ci_failed, changes_requested, etc.).
   */
  async function maybeDispatchMergeConflicts(
    session: Session,
    newStatus: SessionStatus,
  ): Promise<void> {
    const project = config.projects[session.projectId];
    if (!project || !session.pr) return;

    const scm = project.scm?.plugin ? registry.get<SCM>("scm", project.scm.plugin) : null;
    if (!scm) return;

    const conflictReactionKey = "merge-conflicts";

    // Clear tracking when PR is no longer open.
    if (session.lifecycle.pr.state !== "open" || newStatus === "killed") {
      reactionEngine.clearTracker(session.id, conflictReactionKey);
      updateSessionMetadata(session, {
        lastMergeConflictDispatched: "",
      });
      return;
    }

    // Only check for conflicts on open PRs
    if (
      newStatus !== "pr_open" &&
      newStatus !== "ci_failed" &&
      newStatus !== "review_pending" &&
      newStatus !== "changes_requested" &&
      newStatus !== "approved" &&
      newStatus !== "mergeable"
    ) {
      return;
    }

    // Check for conflicts using cached enrichment data or fallback to individual call.
    // When batch enrichment ran (cachedData is present), use its hasConflicts value
    // to avoid 3 redundant REST calls from getMergeability() — the batch already
    // fetched the mergeable/mergeStateStatus fields via GraphQL.
    const prKey = `${session.pr.owner}/${session.pr.repo}#${session.pr.number}`;
    const cachedData = prEnrichmentCache.get(prKey);

    let hasConflicts: boolean;
    if (cachedData) {
      // Batch ran — trust its data (undefined means CONFLICTING wasn't set → no conflicts)
      hasConflicts = cachedData.hasConflicts ?? false;
    } else {
      // Batch didn't run this cycle — fall back to individual API call
      try {
        const mergeReadiness = await scm.getMergeability(session.pr);
        hasConflicts = !mergeReadiness.noConflicts;
      } catch {
        return;
      }
    }

    const lastDispatched = session.metadata["lastMergeConflictDispatched"] ?? "";

    if (hasConflicts) {
      // Already dispatched for current conflict state — skip
      if (lastDispatched === "true") return;

      const reactionConfig = reactionEngine.getReactionConfigForSession(
        session,
        conflictReactionKey,
      );
      if (
        reactionConfig &&
        reactionConfig.action &&
        (reactionConfig.auto !== false || reactionConfig.action === "notify")
      ) {
        try {
          if (reactionConfig.action === "send-to-agent") {
            const message =
              reactionConfig.message ??
              "Your branch has merge conflicts. Rebase on the default branch and resolve them.";
            await sessionManager.send(session.id, message);
          } else {
            const event = createEvent("merge.conflicts", {
              sessionId: session.id,
              projectId: session.projectId,
              message: `${session.id}: PR has merge conflicts`,
            });
            await notifyHuman(event, reactionConfig.priority ?? "warning");
          }

          updateSessionMetadata(session, {
            lastMergeConflictDispatched: "true",
          });
        } catch {
          // Send failed — will retry on next poll cycle
        }
      }
    } else if (lastDispatched === "true") {
      // Conflicts resolved — clear so we can re-dispatch if they recur
      reactionEngine.clearTracker(session.id, conflictReactionKey);
      updateSessionMetadata(session, {
        lastMergeConflictDispatched: "",
      });
    }
  }

  function pruneReviewBacklogThrottle(currentSessionIds: Set<string>): void {
    for (const sessionId of lastReviewBacklogCheckAt.keys()) {
      if (!currentSessionIds.has(sessionId)) {
        lastReviewBacklogCheckAt.delete(sessionId);
      }
    }
  }

  function clearReviewBacklogThrottle(sessionId: string): void {
    lastReviewBacklogCheckAt.delete(sessionId);
  }

  return {
    maybeDispatchReviewBacklog,
    maybeDispatchCIFailureDetails,
    maybeDispatchMergeConflicts,
    pruneReviewBacklogThrottle,
    clearReviewBacklogThrottle,
  };
}
