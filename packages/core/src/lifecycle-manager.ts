/**
 * Lifecycle Manager — state machine + polling loop + reaction engine.
 *
 * Periodically polls all sessions and:
 * 1. Detects state transitions (spawning → working → pr_open → etc.)
 * 2. Emits events on transitions
 * 3. Triggers reactions (auto-handle CI failures, review comments, etc.)
 * 4. Escalates to human notification when auto-handling fails
 *
 * Reference: scripts/claude-session-status, scripts/claude-review-check
 */

import { randomUUID } from "node:crypto";
import {
  SESSION_STATUS,
  PR_STATE,
  CI_STATUS,
  type LifecycleManager,
  type SessionManager,
  type SessionId,
  type SessionStatus,
  type EventType,
  type OrchestratorEvent,
  type OrchestratorConfig,
  type ProjectConfig,
  type ReactionConfig,
  type ReactionResult,
  type PluginRegistry,
  type Runtime,
  type Agent,
  type SCM,
  type Notifier,
  type Session,
  type EventPriority,
} from "./types.js";
import { updateMetadata } from "./metadata.js";
import { getSessionsDir } from "./paths.js";
import { MainBranchTracker } from "./main-branch-tracker.js";

/** Parse a duration string like "10m", "30s", "1h" to milliseconds. */
function parseDuration(str: string): number {
  const match = str.trim().toLowerCase().match(/^(\d+)(s|m|h)$/);
  if (!match) return 0;
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case "s":
      return value * 1000;
    case "m":
      return value * 60_000;
    case "h":
      return value * 3_600_000;
    default:
      return 0;
  }
}

const SESSION_STATUS_VALUES: ReadonlySet<SessionStatus> = new Set(Object.values(SESSION_STATUS));

function isSessionStatus(value: unknown): value is SessionStatus {
  return typeof value === "string" && SESSION_STATUS_VALUES.has(value as SessionStatus);
}

type ResolvedReactionConfig = Partial<ReactionConfig>;
type ActionableReactionConfig = ResolvedReactionConfig & Pick<ReactionConfig, "action">;

function hasReactionAction(
  reactionConfig: ResolvedReactionConfig | null,
): reactionConfig is ActionableReactionConfig {
  return reactionConfig !== null && typeof reactionConfig.action === "string";
}

/** Infer a reasonable priority from event type. */
function inferPriority(type: EventType): EventPriority {
  if (type.includes("stuck") || type.includes("needs_input") || type.includes("errored")) {
    return "urgent";
  }
  if (type.startsWith("summary.")) {
    return "info";
  }
  if (
    type.includes("approved") ||
    type.includes("ready") ||
    type.includes("merged") ||
    type.includes("completed")
  ) {
    return "action";
  }
  if (
    type.includes("fail") ||
    type.includes("changes_requested") ||
    type.includes("conflicts") ||
    type.includes("comments_unresolved")
  ) {
    return "warning";
  }
  return "info";
}

/** Create an OrchestratorEvent with defaults filled in. */
function createEvent(
  type: EventType,
  opts: {
    sessionId: SessionId;
    projectId: string;
    message: string;
    priority?: EventPriority;
    data?: Record<string, unknown>;
  },
): OrchestratorEvent {
  return {
    id: randomUUID(),
    type,
    priority: opts.priority ?? inferPriority(type),
    sessionId: opts.sessionId,
    projectId: opts.projectId,
    timestamp: new Date(),
    message: opts.message,
    data: opts.data ?? {},
  };
}

/** Determine which event type corresponds to a status transition. */
function statusToEventType(_from: SessionStatus | undefined, to: SessionStatus): EventType | null {
  switch (to) {
    case "working":
      return "session.working";
    case "pr_open":
      return "pr.created";
    case "ci_failed":
      return "ci.failing";
    case "review_pending":
      return "review.pending";
    case "changes_requested":
      return "review.changes_requested";
    case "review_comments_unresolved":
      return "review.comments_unresolved";
    case "approved":
      return "review.approved";
    case "mergeable":
      return "merge.ready";
    case "merged":
      return "merge.completed";
    case "needs_input":
      return "session.needs_input";
    case "stuck":
      return "session.stuck";
    case "errored":
      return "session.errored";
    case "killed":
      return "session.killed";
    default:
      return null;
  }
}

/** Map event type to reaction config key. */
function eventToReactionKey(eventType: EventType): string | null {
  switch (eventType) {
    case "ci.failing":
      return "ci-failed";
    case "review.changes_requested":
      return "changes-requested";
    case "review.comments_unresolved":
      return "review-comments";
    case "automated_review.found":
      return "bugbot-comments";
    case "merge.conflicts":
      return "merge-conflicts";
    case "pr.rebase_conflict":
      return "rebase-conflicts";
    case "merge.ready":
      return "approved-and-green";
    case "session.stuck":
      return "agent-stuck";
    case "session.needs_input":
      return "agent-needs-input";
    case "session.killed":
      return "agent-exited";
    case "summary.all_complete":
      return "all-complete";
    default:
      return null;
  }
}

export interface LifecycleManagerDeps {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  sessionManager: SessionManager;
}

/** Track attempt counts for reactions per session. */
interface ReactionTracker {
  attempts: number;
  firstTriggered: Date;
}

/**
 * Build a lifecycle manager for polling session state and triggering reactions.
 *
 * @param deps - Required orchestrator dependencies.
 * @returns A lifecycle manager instance that can start/stop polling and force a session check.
 * @throws {TypeError} When required dependencies are missing.
 */
export function createLifecycleManager(deps: LifecycleManagerDeps): LifecycleManager {
  if (!deps || typeof deps !== "object") {
    throw new TypeError("createLifecycleManager requires a dependency object.");
  }

  const { config, registry, sessionManager } = deps;
  if (!config) {
    throw new TypeError("createLifecycleManager requires deps.config.");
  }
  if (!registry) {
    throw new TypeError("createLifecycleManager requires deps.registry.");
  }
  if (!sessionManager) {
    throw new TypeError("createLifecycleManager requires deps.sessionManager.");
  }

  const states = new Map<SessionId, SessionStatus>();
  const reactionTrackers = new Map<string, ReactionTracker>(); // "sessionId:reactionKey"
  const mainBranchTracker = new MainBranchTracker();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let polling = false; // re-entrancy guard
  let allCompleteEmitted = false; // guard against repeated all_complete
  // Cache pending comments per session during a poll cycle to avoid redundant API calls
  const pendingCommentsCache = new Map<SessionId, Awaited<ReturnType<SCM["getPendingComments"]>>>();

  /** Get merged reaction config (project overrides + global defaults). */
  function getReactionConfig(
    reactionKey: string,
    project: ProjectConfig | undefined,
  ): ResolvedReactionConfig | null {
    const globalReaction = config.reactions[reactionKey];
    if (!project) return globalReaction ?? null;
    const projectReaction = project.reactions?.[reactionKey];
    const merged = projectReaction ? { ...globalReaction, ...projectReaction } : globalReaction;
    return merged ?? null;
  }

  /** Determine current status for a session by polling plugins. */
  async function determineStatus(session: Session): Promise<SessionStatus> {
    const project = config.projects[session.projectId];
    if (!project) return session.status;

    const agentName = session.metadata["agent"] ?? project.agent ?? config.defaults.agent;
    const agent = registry.get<Agent>("agent", agentName);
    const scm = project.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;

    // 1. Check if runtime is alive
    if (session.runtimeHandle) {
      const runtime = registry.get<Runtime>("runtime", project.runtime ?? config.defaults.runtime);
      if (runtime) {
        const alive = await runtime.isAlive(session.runtimeHandle).catch(() => true);
        if (!alive) return "killed";
      }
    }

    // 2. Check agent activity via terminal output + process liveness
    if (agent && session.runtimeHandle) {
      try {
        const runtime = registry.get<Runtime>(
          "runtime",
          project.runtime ?? config.defaults.runtime,
        );
        const terminalOutput = runtime ? await runtime.getOutput(session.runtimeHandle, 10) : "";
        // Only trust detectActivity when we actually have terminal output;
        // empty output means the runtime probe failed, not that the agent exited.
        if (terminalOutput) {
          const activity = agent.detectActivity(terminalOutput);
          // When the agent is waiting for input AND has a PR, do NOT return
          // early — fall through to step 4 so CI/review status is checked.
          // The reaction engine can then send the agent a message to fix CI.
          if (activity === "waiting_input" && !session.pr) return "needs_input";

          // Check whether the agent process is still alive. Some agents
          // (codex, aider, opencode) return "active" for any non-empty
          // terminal output, including the shell prompt visible after exit.
          // Checking isProcessRunning for both "idle" and "active" ensures
          // exit detection works regardless of the agent's classifier.
          const processAlive = await agent.isProcessRunning(session.runtimeHandle);
          if (!processAlive) return "killed";
        }
      } catch {
        // On probe failure, preserve current stuck/needs_input state rather
        // than letting the fallback at the bottom coerce them to "working"
        if (
          session.status === SESSION_STATUS.STUCK ||
          session.status === SESSION_STATUS.NEEDS_INPUT
        ) {
          return session.status;
        }
      }
    }

    // 3. Auto-detect PR by branch if metadata.pr is missing.
    //    This is critical for agents without auto-hook systems (Codex, Aider,
    //    OpenCode) that can't reliably write pr=<url> to metadata on their own.
    if (!session.pr && scm && session.branch) {
      try {
        const detectedPR = await scm.detectPR(session, project);
        if (detectedPR) {
          session.pr = detectedPR;
          // Persist PR URL so subsequent polls don't need to re-query.
          // Don't write status here — step 4 below will determine the
          // correct status (merged, ci_failed, etc.) on this same cycle.
          const sessionsDir = getSessionsDir(config.configPath, project.path);
          updateMetadata(sessionsDir, session.id, { pr: detectedPR.url });
        }
      } catch {
        // SCM detection failed — will retry next poll
      }
    }

    // 4. Check PR state if PR exists
    if (session.pr && scm) {
      try {
        const prState = await scm.getPRState(session.pr);
        if (prState === PR_STATE.MERGED) return "merged";
        if (prState === PR_STATE.CLOSED) return "killed";

        // Check CI
        const ciStatus = await scm.getCISummary(session.pr);
        if (ciStatus === CI_STATUS.FAILING) return "ci_failed";

        // Check reviews
        const reviewDecision = await scm.getReviewDecision(session.pr);
        if (reviewDecision === "changes_requested") return "changes_requested";
        if (reviewDecision === "approved") {
          // Check merge readiness
          const mergeReady = await scm.getMergeability(session.pr);
          if (mergeReady.mergeable) {
            // Verify no pending review comments before declaring mergeable
            try {
              const pendingComments = await scm.getPendingComments(session.pr);
              pendingCommentsCache.set(session.id, pendingComments);
              if (pendingComments.length > 0) {
                // Update seen-tracking for comment dedup
                const currentCommentIds = pendingComments.map((c) => c.id).join(",");
                const seenIds = session.metadata?.["reviewCommentsSeen"] || "";
                if (currentCommentIds !== seenIds) {
                  const sessionsDir = getSessionsDir(config.configPath, project.path);
                  updateMetadata(sessionsDir, session.id, {
                    reviewCommentsSeen: currentCommentIds,
                  });
                }
                return "review_comments_unresolved";
              }
            } catch {
              // If comment check fails, fall through to mergeable
            }
            return "mergeable";
          }
          return "approved";
        }
        if (reviewDecision === "pending") return "review_pending";

        // Check for unresolved review comments even without a review decision
        try {
          const pendingComments = await scm.getPendingComments(session.pr);
          pendingCommentsCache.set(session.id, pendingComments);
          if (pendingComments.length > 0) {
            const currentCommentIds = pendingComments.map((c) => c.id).join(",");
            const seenIds = session.metadata?.["reviewCommentsSeen"] || "";
            if (currentCommentIds !== seenIds) {
              const sessionsDir = getSessionsDir(config.configPath, project.path);
              updateMetadata(sessionsDir, session.id, {
                reviewCommentsSeen: currentCommentIds,
              });
            }
            return "review_comments_unresolved";
          }
        } catch {
          // getPendingComments failed — don't change status
        }

        return "pr_open";
      } catch {
        // SCM check failed — keep current status
      }
    }

    // 5. Default: if agent is active, it's working
    if (
      session.status === "spawning" ||
      session.status === SESSION_STATUS.STUCK ||
      session.status === SESSION_STATUS.NEEDS_INPUT
    ) {
      return "working";
    }
    return session.status;
  }

  /** Execute a reaction for a session. */
  async function executeReaction(
    sessionId: SessionId,
    projectId: string,
    reactionKey: string,
    reactionConfig: ActionableReactionConfig,
  ): Promise<ReactionResult> {
    const trackerKey = `${sessionId}:${reactionKey}`;
    let tracker = reactionTrackers.get(trackerKey);

    if (!tracker) {
      tracker = { attempts: 0, firstTriggered: new Date() };
      reactionTrackers.set(trackerKey, tracker);
    }

    // Increment attempts before checking escalation
    tracker.attempts++;

    // Check if we should escalate
    const maxRetries =
      typeof reactionConfig.retries === "number" &&
      Number.isFinite(reactionConfig.retries) &&
      reactionConfig.retries >= 0
        ? Math.floor(reactionConfig.retries)
        : Infinity;
    const escalateAfter = reactionConfig.escalateAfter;
    let shouldEscalate = false;

    if (tracker.attempts > maxRetries) {
      shouldEscalate = true;
    }

    if (typeof escalateAfter === "string") {
      const durationMs = parseDuration(escalateAfter);
      if (durationMs > 0 && Date.now() - tracker.firstTriggered.getTime() > durationMs) {
        shouldEscalate = true;
      }
    }

    if (
      typeof escalateAfter === "number" &&
      Number.isFinite(escalateAfter) &&
      escalateAfter >= 0 &&
      tracker.attempts > Math.floor(escalateAfter)
    ) {
      shouldEscalate = true;
    }

    if (shouldEscalate) {
      // Escalate to human
      const event = createEvent("reaction.escalated", {
        sessionId,
        projectId,
        message: `Reaction '${reactionKey}' escalated after ${tracker.attempts} attempts`,
        data: { reactionKey, attempts: tracker.attempts },
      });
      await notifyHuman(event, reactionConfig.priority ?? "urgent");
      return {
        reactionType: reactionKey,
        success: true,
        action: "escalated",
        escalated: true,
      };
    }

    // Execute the reaction action
    const action = reactionConfig.action;

    switch (action) {
      case "send-to-agent": {
        if (reactionConfig.message) {
          try {
            await sessionManager.send(sessionId, reactionConfig.message);

            return {
              reactionType: reactionKey,
              success: true,
              action: "send-to-agent",
              message: reactionConfig.message,
              escalated: false,
            };
          } catch {
            // Send failed — allow retry on next poll cycle (don't escalate immediately)
            return {
              reactionType: reactionKey,
              success: false,
              action: "send-to-agent",
              escalated: false,
            };
          }
        }
        break;
      }

      case "notify": {
        const event = createEvent("reaction.triggered", {
          sessionId,
          projectId,
          message: `Reaction '${reactionKey}' triggered notification`,
          data: { reactionKey },
        });
        await notifyHuman(event, reactionConfig.priority ?? "info");
        return {
          reactionType: reactionKey,
          success: true,
          action: "notify",
          escalated: false,
        };
      }

      case "auto-merge": {
        // Auto-merge is handled by the SCM plugin
        // For now, just notify
        const event = createEvent("reaction.triggered", {
          sessionId,
          projectId,
          message: `Reaction '${reactionKey}' triggered auto-merge`,
          data: { reactionKey },
        });
        await notifyHuman(event, "action");
        return {
          reactionType: reactionKey,
          success: true,
          action: "auto-merge",
          escalated: false,
        };
      }
    }

    return {
      reactionType: reactionKey,
      success: false,
      action,
      escalated: false,
    };
  }

  /** Send a notification to all configured notifiers. */
  async function notifyHuman(event: OrchestratorEvent, priority: EventPriority): Promise<void> {
    const eventWithPriority = { ...event, priority };
    const notifierNames = config.notificationRouting[priority] ?? config.defaults.notifiers;

    for (const name of notifierNames) {
      const notifier = registry.get<Notifier>("notifier", name);
      if (notifier) {
        try {
          await notifier.notify(eventWithPriority);
        } catch {
          // Notifier failed — not much we can do
        }
      }
    }
  }

  /** Poll a single session and handle state transitions. */
  async function checkSession(session: Session): Promise<void> {
    // Use tracked state if available; otherwise use the persisted metadata status
    // (not session.status, which list() may have already overwritten for dead runtimes).
    // This ensures transitions are detected after a lifecycle manager restart.
    const tracked = states.get(session.id);
    const metadataStatus = session.metadata?.["status"];
    const persistedStatus = isSessionStatus(metadataStatus) ? metadataStatus : undefined;
    const oldStatus = tracked ?? persistedStatus ?? session.status;
    const newStatus = await determineStatus(session);

    if (newStatus !== oldStatus) {
      // State transition detected
      states.set(session.id, newStatus);

      // Update metadata — session.projectId is the config key (e.g., "my-app")
      const project = config.projects[session.projectId];
      if (project) {
        const sessionsDir = getSessionsDir(config.configPath, project.path);
        updateMetadata(sessionsDir, session.id, { status: newStatus });
      }

      // Reset allCompleteEmitted when any session becomes active again
      if (newStatus !== "merged" && newStatus !== "killed") {
        allCompleteEmitted = false;
      }

      // Clear reaction trackers for the old status so retries reset on state changes
      const oldEventType = statusToEventType(undefined, oldStatus);
      if (oldEventType) {
        const oldReactionKey = eventToReactionKey(oldEventType);
        if (oldReactionKey) {
          reactionTrackers.delete(`${session.id}:${oldReactionKey}`);
        }
      }

      // Handle transition: notify humans and/or trigger reactions
      const eventType = statusToEventType(oldStatus, newStatus);
      if (eventType) {
        let reactionHandledNotify = false;
        const reactionKey = eventToReactionKey(eventType);

        if (reactionKey) {
          // Merge project-specific overrides with global defaults
          const project = config.projects[session.projectId];
          const reactionConfig = getReactionConfig(reactionKey, project);

          if (hasReactionAction(reactionConfig)) {
            // auto: false skips automated agent actions but still allows notifications
            if (reactionConfig.auto !== false || reactionConfig.action === "notify") {
              await executeReaction(
                session.id,
                session.projectId,
                reactionKey,
                reactionConfig,
              );
              // Reaction is handling this event — suppress immediate human notification.
              // "send-to-agent" retries + escalates on its own; "notify"/"auto-merge"
              // already call notifyHuman internally. Notifying here would bypass the
              // delayed escalation behaviour configured via retries/escalateAfter.
              reactionHandledNotify = true;
            }
          }
        }

        // For significant transitions not already notified by a reaction, notify humans
        if (!reactionHandledNotify) {
          const priority = inferPriority(eventType);
          if (priority !== "info") {
            const event = createEvent(eventType, {
              sessionId: session.id,
              projectId: session.projectId,
              message: `${session.id}: ${oldStatus} → ${newStatus}`,
              data: { oldStatus, newStatus },
            });
            await notifyHuman(event, priority);
          }
        }
      }
    } else {
      // No transition but track current state
      states.set(session.id, newStatus);

      // Special case: session stays in review_comments_unresolved but
      // determineStatus() detected new comments (updated reviewCommentsSeen).
      // Re-trigger the review-comments reaction so the agent addresses them.
      if (
        newStatus === "review_comments_unresolved" &&
        oldStatus === "review_comments_unresolved" &&
        session.pr
      ) {
        const pendingComments = pendingCommentsCache.get(session.id);
        if (pendingComments && pendingComments.length > 0) {
          const currentCommentIds = pendingComments.map((c) => c.id).join(",");
          const seenIds = session.metadata?.["reviewCommentsSeen"] || "";
          // Only re-trigger if comment set changed (determineStatus already updated metadata)
          if (currentCommentIds !== seenIds) {
            const reactionKey = "review-comments";
            const project = config.projects[session.projectId];
            const globalReaction = config.reactions[reactionKey];
            const projectReaction = project?.reactions?.[reactionKey];
            const reactionConfig = projectReaction
              ? { ...globalReaction, ...projectReaction }
              : globalReaction;
            if (hasReactionAction(reactionConfig)) {
              if (reactionConfig.auto !== false || reactionConfig.action === "notify") {
                await executeReaction(
                  session.id,
                  session.projectId,
                  reactionKey,
                  reactionConfig,
                );
              }
            }
          }
        }
      }
    }
  }

  /** Check for main branch updates and trigger rebases. */
  async function checkMainBranchUpdates(sessions: Session[]): Promise<void> {
    // Group sessions by project (only those with open PRs)
    const projectSessions = new Map<string, Session[]>();
    for (const session of sessions) {
      if (!session.pr || session.status === "merged" || session.status === "killed") {
        continue;
      }
      const list = projectSessions.get(session.projectId) ?? [];
      list.push(session);
      projectSessions.set(session.projectId, list);
    }

    // Check each project's main branch
    for (const [projectId, projectSessionsList] of projectSessions.entries()) {
      const project = config.projects[projectId];
      if (!project) continue;

      const scm = project.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;
      if (!scm || !scm.rebaseAndPush) continue;

      try {
        // Check if main advanced
        const result = await mainBranchTracker.checkMainAdvanced(project, projectId, scm);
        if (!result.advanced) continue;

        // Trigger rebases for all open PRs, passing the main branch SHA
        await rebaseAllSessions(projectSessionsList, project, scm, result.newSha);
      } catch {
        // Continue with other projects
      }
    }
  }

  /** Rebase all sessions for a project. */
  async function rebaseAllSessions(
    sessions: Session[],
    project: ProjectConfig,
    scm: SCM,
    mainBranchSHA: string,
  ): Promise<void> {
    const agent = registry.get<Agent>("agent", project.agent ?? config.defaults.agent);

    for (const session of sessions) {
      try {
        // Skip if agent is actively processing
        if (agent && session.runtimeHandle) {
          try {
            const activity = await agent.getActivityState(session);
            if (activity && activity.state === "active") continue;
          } catch {
            continue; // Can't determine - skip to be safe
          }
        }

        if (!session.workspacePath || !session.pr || !scm.rebaseAndPush) continue;

        const sessionsDir = getSessionsDir(config.configPath, project.path);

        // Attempt rebase
        const result = await scm.rebaseAndPush({
          workspacePath: session.workspacePath,
          branch: session.pr.branch,
          baseBranch: project.defaultBranch,
          remoteName: "origin",
        });

        if (result.success) {
          // Silent success - update metadata and clear error fields
          updateMetadata(sessionsDir, session.id, {
            lastRebaseTime: new Date().toISOString(),
            lastRebaseMainSHA: mainBranchSHA,
            rebaseStatus: "clean",
            rebaseError: "", // Clear stale error from previous failure
            lastRebaseAttempt: "", // Clear stale attempt timestamp
          });

          // Clear reaction tracker for rebase-conflicts (prevents stale state on re-conflict)
          reactionTrackers.delete(`${session.id}:rebase-conflicts`);

          // Emit low-priority info event
          const event = createEvent("pr.rebased", {
            sessionId: session.id,
            projectId: session.projectId,
            message: `Rebased ${session.id} onto ${project.defaultBranch}`,
            priority: "info",
          });
          await notifyHuman(event, "info");
        } else if (result.conflicted) {
          // Conflicts - invoke reaction engine for proper agent message + escalation
          updateMetadata(sessionsDir, session.id, {
            rebaseStatus: "conflicted",
            lastRebaseAttempt: new Date().toISOString(),
          });

          // Get reaction config (merge project overrides with defaults)
          const reactionKey = "rebase-conflicts";
          const reactionConfig = getReactionConfig(reactionKey, project);

          if (reactionConfig && reactionConfig.action) {
            // Execute reaction (sends to agent, handles escalation)
            await executeReaction(
              session.id,
              session.projectId,
              reactionKey,
              reactionConfig as ReactionConfig,
            );
          } else {
            // Fallback if reaction not configured
            const event = createEvent("pr.rebase_conflict", {
              sessionId: session.id,
              projectId: session.projectId,
              message: `${session.id}: Rebase conflicts with ${project.defaultBranch}`,
              priority: "urgent",
              data: { prUrl: session.pr.url },
            });
            await notifyHuman(event, "urgent");
          }
        } else {
          // Other errors - log to metadata and notify
          updateMetadata(sessionsDir, session.id, {
            rebaseStatus: "error",
            rebaseError: result.error ?? "Unknown error",
            lastRebaseAttempt: new Date().toISOString(),
          });

          // Emit error event for visibility
          const event = createEvent("pr.rebase_error", {
            sessionId: session.id,
            projectId: session.projectId,
            message: `${session.id}: Rebase error - ${result.error ?? "Unknown error"}`,
            priority: "warning",
            data: { error: result.error, prUrl: session.pr.url },
          });
          await notifyHuman(event, "warning");
        }
      } catch {
        // Per-session error - continue with remaining sessions
        // (e.g., updateMetadata I/O failure, notifier errors)
        continue;
      }
    }
  }

  /** Check sessions with rebase conflicts and re-trigger reactions for escalation. */
  async function checkRebaseConflicts(sessions: Session[]): Promise<void> {
    for (const session of sessions) {
      try {
        // Skip terminal sessions
        if (session.status === "merged" || session.status === "killed") continue;

        // Only check sessions with conflicted rebase status
        const rebaseStatus = session.metadata?.["rebaseStatus"];
        if (rebaseStatus !== "conflicted") continue;

        // Get project config
        const project = config.projects[session.projectId];
        if (!project) continue;

        // Get reaction config (merge project overrides with defaults)
        const reactionKey = "rebase-conflicts";
        const reactionConfig = getReactionConfig(reactionKey, project);

        if (hasReactionAction(reactionConfig)) {
          // Check if reaction already triggered (to prevent spam)
          const trackerKey = `${session.id}:${reactionKey}`;
          const tracker = reactionTrackers.get(trackerKey);

          // Skip if reaction was recently triggered and escalation threshold hasn't been met
          if (tracker && reactionConfig.escalateAfter) {
            if (typeof reactionConfig.escalateAfter === "string") {
              // String: time duration (e.g., "30m")
              const escalateDuration = parseDuration(reactionConfig.escalateAfter);
              const elapsed = Date.now() - tracker.firstTriggered.getTime();
              if (escalateDuration > 0 && elapsed < escalateDuration) {
                continue; // Skip - not enough time has passed
              }
            } else {
              // Number: attempt count (e.g., 2 means escalate after 2 attempts)
              if (tracker.attempts <= reactionConfig.escalateAfter) {
                continue; // Skip - not enough attempts yet
              }
            }
          }

          // Execute reaction (first time or ready to escalate)
          await executeReaction(
            session.id,
            session.projectId,
            reactionKey,
            reactionConfig,
          );
        }
      } catch {
        // Continue with other sessions
        continue;
      }
    }
  }

  /** Run one polling cycle across all sessions. */
  async function pollAll(): Promise<void> {
    // Re-entrancy guard: skip if previous poll is still running
    if (polling) return;
    polling = true;

    try {
      let sessions = await sessionManager.list();

      // Check for main branch advancement and trigger rebases
      await checkMainBranchUpdates(sessions);

      // Reload sessions after rebase updates to avoid stale metadata
      sessions = await sessionManager.list();

      // Re-evaluate sessions with rebase conflicts (for escalation)
      await checkRebaseConflicts(sessions);

      // Include sessions that are active OR whose status changed from what we last saw
      // (e.g., list() detected a dead runtime and marked it "killed" — we need to
      // process that transition even though the new status is terminal)
      const sessionsToCheck = sessions.filter((s) => {
        if (s.status !== "merged" && s.status !== "killed") return true;
        const tracked = states.get(s.id);
        return tracked !== undefined && tracked !== s.status;
      });

      // Poll all sessions concurrently
      await Promise.allSettled(sessionsToCheck.map((s) => checkSession(s)));

      // Prune stale entries from states and reactionTrackers for sessions
      // that no longer appear in the session list (e.g., after kill/cleanup)
      const currentSessionIds = new Set(sessions.map((s) => s.id));
      for (const trackedId of states.keys()) {
        if (!currentSessionIds.has(trackedId)) {
          states.delete(trackedId);
        }
      }
      for (const trackerKey of reactionTrackers.keys()) {
        const sessionId = trackerKey.split(":")[0];
        if (sessionId && !currentSessionIds.has(sessionId)) {
          reactionTrackers.delete(trackerKey);
        }
      }

      // Check if all sessions are complete (trigger reaction only once)
      const activeSessions = sessions.filter((s) => s.status !== "merged" && s.status !== "killed");
      if (sessions.length > 0 && activeSessions.length === 0 && !allCompleteEmitted) {
        allCompleteEmitted = true;

        // Execute all-complete reaction if configured
        const reactionKey = eventToReactionKey("summary.all_complete");
        if (reactionKey) {
          const reactionConfig = config.reactions[reactionKey];
          if (hasReactionAction(reactionConfig)) {
            if (reactionConfig.auto !== false || reactionConfig.action === "notify") {
              await executeReaction("system", "all", reactionKey, reactionConfig);
            }
          }
        }
      }
    } catch {
      // Poll cycle failed — will retry next interval
    } finally {
      polling = false;
      pendingCommentsCache.clear();
    }
  }

  return {
    start(intervalMs = 30_000): void {
      if (pollTimer) return; // Already running
      if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
        throw new RangeError(
          `LifecycleManager.start(intervalMs) requires a positive number of milliseconds, received: ${String(intervalMs)}`,
        );
      }
      pollTimer = setInterval(() => void pollAll(), intervalMs);
      // Run immediately on start
      void pollAll();
    },

    stop(): void {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    },

    getStates(): Map<SessionId, SessionStatus> {
      return new Map(states);
    },

    async check(sessionId: SessionId): Promise<void> {
      if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
        throw new Error("LifecycleManager.check(sessionId) requires a non-empty session ID.");
      }
      const session = await sessionManager.get(sessionId);
      if (!session) {
        throw new Error(
          `LifecycleManager.check("${sessionId}") failed: session was not found in session manager.`,
        );
      }
      await checkSession(session);
    },
  };
}
