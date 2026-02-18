/**
 * Lifecycle Manager — state machine + polling loop + reaction engine.
 *
 * Periodically polls all sessions and:
 * 1. Detects state transitions (spawning → working → pr_open → etc.)
 * 2. Emits events on transitions (logged to JSONL event log)
 * 3. Triggers reactions (auto-handle CI failures, review comments, bugbot, etc.)
 * 4. Re-triggers reactions for persistent conditions (CI still failing, etc.)
 * 5. Escalates to human notification when auto-handling fails
 *
 * Event sources polled each cycle:
 * - Runtime liveness (is the agent process still running?)
 * - Agent activity state (active / ready / idle / stuck / waiting_input)
 * - PR state (open / merged / closed)
 * - CI checks summary (passing / failing / pending)
 * - Review decision (approved / changes_requested / pending)
 * - Automated review comments / bugbot comments (getAutomatedComments)
 *
 * Note: Human review comment polling (getPendingComments) is handled by the
 * review-comments reaction (ao-48). See: eventToReactionKey for "changes-requested".
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
  type ReactionConfig,
  type ReactionResult,
  type PluginRegistry,
  type Runtime,
  type Agent,
  type SCM,
  type Notifier,
  type Session,
  type EventPriority,
  type EventLog,
  type ProjectConfig as _ProjectConfig,
} from "./types.js";
import { updateMetadata } from "./metadata.js";
import { getSessionsDir, getEventLogPath } from "./paths.js";
import { createEventLog } from "./event-log.js";

/** Parse a duration string like "10m", "30s", "1h" to milliseconds. */
function parseDuration(str: string): number {
  const match = str.match(/^(\d+)(s|m|h)$/);
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
  if (type.includes("fail") || type.includes("changes_requested") || type.includes("conflicts")) {
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
    case "automated_review.found":
      return "bugbot-comments";
    case "merge.conflicts":
      return "merge-conflicts";
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

/**
 * States where we should re-trigger reactions if the session stays stuck.
 * These are "actionable" states — the agent should fix them.
 */
const RETRIGGER_STATES: ReadonlySet<SessionStatus> = new Set([
  "ci_failed",
  "changes_requested",
  "stuck",
  "needs_input",
]);

export interface LifecycleManagerDeps {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  sessionManager: SessionManager;
  /** Optional event log for auditing all emitted events. Defaults to file-based log at getEventLogPath(config.configPath). */
  eventLog?: EventLog;
}

/** Track attempt counts and timing for reactions per session. */
interface ReactionTracker {
  attempts: number;
  firstTriggered: Date;
  /** When the reaction was last attempted (for retrigger cooldown). */
  lastAttemptAt: Date;
  /**
   * True once the reaction has escalated to human notification.
   * Prevents checkPersistentConditions from re-escalating on every retrigger
   * cycle after the escalation threshold is reached.
   */
  escalated: boolean;
}

/** Create a LifecycleManager instance. */
export function createLifecycleManager(deps: LifecycleManagerDeps): LifecycleManager {
  const { config, registry, sessionManager } = deps;
  const eventLog = deps.eventLog ?? createEventLog(getEventLogPath(config.configPath));

  const states = new Map<SessionId, SessionStatus>();
  const reactionTrackers = new Map<string, ReactionTracker>(); // "sessionId:reactionKey"
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let polling = false; // re-entrancy guard
  let allCompleteEmitted = false; // guard against repeated all_complete

  /**
   * Fingerprints of automated (bot) comments seen per session.
   * Key: sessionId, Value: sorted comma-joined comment IDs.
   * Prevents re-triggering the bugbot-comments reaction for the same set of comments.
   */
  const automatedCommentFingerprints = new Map<SessionId, string>();

  /** Determine current status for a session by polling plugins. */
  async function determineStatus(session: Session): Promise<SessionStatus> {
    const project = config.projects[session.projectId];
    if (!project) return session.status;

    const agent = registry.get<Agent>("agent", project.agent ?? config.defaults.agent);
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
          if (activity === "waiting_input") return "needs_input";

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

    // 3. Check PR state if PR exists
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
          if (mergeReady.mergeable) return "mergeable";
          return "approved";
        }
        if (reviewDecision === "pending") return "review_pending";

        return "pr_open";
      } catch {
        // SCM check failed — keep current status
      }
    }

    // 4. Default: if agent is active, it's working
    if (
      session.status === "spawning" ||
      session.status === SESSION_STATUS.STUCK ||
      session.status === SESSION_STATUS.NEEDS_INPUT
    ) {
      return "working";
    }
    return session.status;
  }

  /**
   * Get the effective reaction config for a session, merging project overrides
   * with global defaults (project wins on any key that is set).
   */
  function getEffectiveReactionConfig(
    session: Session,
    reactionKey: string,
  ): ReactionConfig | null {
    const project = config.projects[session.projectId];
    const globalReaction = config.reactions[reactionKey];
    const projectReaction = project?.reactions?.[reactionKey];
    if (!globalReaction && !projectReaction) return null;
    if (projectReaction) return { ...globalReaction, ...projectReaction } as ReactionConfig;
    return globalReaction ?? null;
  }

  /** Execute a reaction for a session. */
  async function executeReaction(
    sessionId: SessionId,
    projectId: string,
    reactionKey: string,
    reactionConfig: ReactionConfig,
  ): Promise<ReactionResult> {
    const trackerKey = `${sessionId}:${reactionKey}`;
    let tracker = reactionTrackers.get(trackerKey);

    if (!tracker) {
      const now = new Date();
      tracker = { attempts: 0, firstTriggered: now, lastAttemptAt: now, escalated: false };
      reactionTrackers.set(trackerKey, tracker);
    }

    // Increment attempts before checking escalation
    tracker.attempts++;
    tracker.lastAttemptAt = new Date();

    // Check if we should escalate
    const maxRetries = reactionConfig.retries ?? Infinity;
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

    if (typeof escalateAfter === "number" && tracker.attempts > escalateAfter) {
      shouldEscalate = true;
    }

    if (shouldEscalate) {
      // Mark escalated so checkPersistentConditions won't keep re-escalating on every
      // retrigger cycle after the threshold is reached.
      tracker.escalated = true;

      // Escalate to human
      const event = createEvent("reaction.escalated", {
        sessionId,
        projectId,
        message: `Reaction '${reactionKey}' escalated after ${tracker.attempts} attempts`,
        data: { reactionKey, attempts: tracker.attempts },
      });
      eventLog.log(event);
      await notifyHuman(event, reactionConfig.priority ?? "urgent");
      return {
        reactionType: reactionKey,
        success: true,
        action: "escalated",
        escalated: true,
      };
    }

    // Execute the reaction action
    const action = reactionConfig.action ?? "notify";

    switch (action) {
      case "send-to-agent": {
        if (reactionConfig.message) {
          try {
            await sessionManager.send(sessionId, reactionConfig.message);
            const event = createEvent("reaction.triggered", {
              sessionId,
              projectId,
              message: `Reaction '${reactionKey}' sent message to agent (attempt ${tracker.attempts})`,
              data: { reactionKey, attempts: tracker.attempts },
            });
            eventLog.log(event);
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
        eventLog.log(event);
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
        eventLog.log(event);
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

  /**
   * Check for automated (bot) review comments on a PR and trigger the
   * bugbot-comments reaction when new comments appear.
   *
   * Deduplication: tracks a fingerprint (sorted comment IDs) per session.
   * The reaction only fires when new comments appear that we haven't seen before.
   * When the comment set changes (e.g., after agent fixes some), we retrigger
   * with the new set.
   */
  async function checkAutomatedComments(session: Session): Promise<void> {
    if (!session.pr) return;
    const project = config.projects[session.projectId];
    if (!project?.scm) return;
    const scm = registry.get<SCM>("scm", project.scm.plugin);
    if (!scm) return;

    let comments;
    try {
      comments = await scm.getAutomatedComments(session.pr);
    } catch {
      return; // SCM error — skip this cycle
    }

    if (comments.length === 0) {
      // No automated comments — clear fingerprint and reaction tracker so future bot
      // comments are treated as new. Without clearing the tracker, tracker.escalated
      // persists permanently and the escalation guards on both fingerprint paths would
      // silently block all future reactions for genuinely new/different bot comments.
      automatedCommentFingerprints.delete(session.id);
      reactionTrackers.delete(`${session.id}:bugbot-comments`);
      return;
    }

    // Compute fingerprint from sorted comment IDs
    const fingerprint = comments
      .map((c) => c.id)
      .sort()
      .join(",");
    const lastFingerprint = automatedCommentFingerprints.get(session.id);

    if (fingerprint === lastFingerprint) {
      // Same comments as before. Check whether retriggerAfter has elapsed so we
      // can re-notify the agent about unresolved bot feedback even when no new
      // comments have appeared (the status-based checkPersistentConditions path
      // does not cover this because no SessionStatus maps to "automated_review.found").
      const reactionKey = "bugbot-comments";
      const reactionConfig = getEffectiveReactionConfig(session, reactionKey);
      if (!reactionConfig?.retriggerAfter) return;
      const retriggerMs = parseDuration(reactionConfig.retriggerAfter);
      if (retriggerMs <= 0) return;
      const tracker = reactionTrackers.get(`${session.id}:${reactionKey}`);
      if (!tracker) return; // Never reacted yet — nothing to retrigger
      // Once escalated, stop retrying — human has been notified (mirrors the guard
      // in checkPersistentConditions to prevent infinite re-escalation spam).
      if (tracker.escalated) return;
      if (Date.now() - tracker.lastAttemptAt.getTime() < retriggerMs) return;
      // Fall through to retrigger the reaction with the same comment set
    }

    // New or changed automated comments — update fingerprint and trigger reaction
    automatedCommentFingerprints.set(session.id, fingerprint);

    const event = createEvent("automated_review.found", {
      sessionId: session.id,
      projectId: session.projectId,
      message: `${comments.length} automated review comment(s) on PR #${session.pr.number}`,
      priority: "warning",
      data: {
        prNumber: session.pr.number,
        count: comments.length,
        comments: comments.map((c) => ({
          id: c.id,
          botName: c.botName,
          severity: c.severity,
          path: c.path,
          url: c.url,
        })),
      },
    });
    eventLog.log(event);

    const reactionKey = "bugbot-comments";
    const reactionConfig = getEffectiveReactionConfig(session, reactionKey);
    if (reactionConfig && reactionConfig.action && reactionConfig.auto !== false) {
      // Guard against re-escalation even when fingerprint changes (e.g. state transitions
      // clear the fingerprint so re-detected identical comments look "new"). Without this,
      // every state transition followed by the same bot comments bypasses the escalation
      // guard that the "same fingerprint" retrigger path correctly enforces (line 539).
      const tracker = reactionTrackers.get(`${session.id}:${reactionKey}`);
      if (tracker?.escalated) return;
      await executeReaction(session.id, session.projectId, reactionKey, reactionConfig);
    } else {
      // No configured reaction, notify-only, or auto: false — surface to human.
      // Mirrors the transition-based path (lines 708-714) which falls through to
      // notifyHuman whenever the automated action is skipped (including auto: false).
      await notifyHuman(event, event.priority);
    }
  }

  /**
   * Re-trigger reactions for sessions that stay in a problematic state without
   * transitioning. This handles the case where an agent received the initial
   * "CI is failing" message but didn't fix it — we want to retry after a delay
   * rather than silently giving up.
   *
   * Only fires when:
   * 1. The session is in a RETRIGGER_STATE (ci_failed, changes_requested, etc.)
   * 2. A reaction was previously triggered for this state (tracker exists)
   * 3. Enough time has passed since the last attempt (retriggerAfter cooldown)
   * 4. The reaction is configured with retriggerAfter (opt-in)
   */
  async function checkPersistentConditions(
    session: Session,
    status: SessionStatus,
  ): Promise<void> {
    if (!RETRIGGER_STATES.has(status)) return;

    const eventType = statusToEventType(undefined, status);
    if (!eventType) return;

    const reactionKey = eventToReactionKey(eventType);
    if (!reactionKey) return;

    const reactionConfig = getEffectiveReactionConfig(session, reactionKey);
    if (!reactionConfig?.retriggerAfter) return; // Opt-in only
    if (reactionConfig.auto === false) return;
    if (reactionConfig.action !== "send-to-agent") return; // Only retrigger agent sends

    const trackerKey = `${session.id}:${reactionKey}`;
    const tracker = reactionTrackers.get(trackerKey);
    if (!tracker) return; // Never triggered before — initial trigger happens on state transition

    // Once escalated, stop retrying — human has been notified.
    // Without this guard, every retrigger cycle after the escalation threshold
    // would re-escalate, producing notification spam.
    if (tracker.escalated) return;

    const retriggerMs = parseDuration(reactionConfig.retriggerAfter);
    if (retriggerMs <= 0) return;

    const timeSinceLastAttempt = Date.now() - tracker.lastAttemptAt.getTime();
    if (timeSinceLastAttempt < retriggerMs) return; // Too soon

    // Re-trigger: agent is still stuck in the same bad state
    await executeReaction(session.id, session.projectId, reactionKey, reactionConfig);
  }

  /** Poll a single session and handle state transitions. */
  async function checkSession(session: Session): Promise<void> {
    // Use tracked state if available; otherwise use the persisted metadata status
    // (not session.status, which list() may have already overwritten for dead runtimes).
    // This ensures transitions are detected after a lifecycle manager restart.
    const tracked = states.get(session.id);
    const oldStatus =
      tracked ?? ((session.metadata?.["status"] as SessionStatus | undefined) || session.status);
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

      // Clear reaction trackers for the old status so retries reset on state changes.
      const oldEventType = statusToEventType(undefined, oldStatus);
      if (oldEventType) {
        const oldReactionKey = eventToReactionKey(oldEventType);
        if (oldReactionKey) {
          reactionTrackers.delete(`${session.id}:${oldReactionKey}`);
        }
      }

      // Clear automated comment fingerprint on any state transition so that
      // persistent bot comments retrigger after an agent pushes a fix (even
      // if the fix doesn't resolve all bot feedback).
      automatedCommentFingerprints.delete(session.id);

      // Handle transition: notify humans and/or trigger reactions
      const eventType = statusToEventType(oldStatus, newStatus);
      if (eventType) {
        // Emit transition event to log FIRST so the audit trail shows cause before
        // effects. executeReaction will append its own reaction.triggered/escalated
        // entries, which must appear after this root-cause event.
        const event = createEvent(eventType, {
          sessionId: session.id,
          projectId: session.projectId,
          message: `${session.id}: ${oldStatus} → ${newStatus}`,
          data: { oldStatus, newStatus },
        });
        eventLog.log(event);

        let reactionHandledNotify = false;
        const reactionKey = eventToReactionKey(eventType);

        if (reactionKey) {
          const reactionConfig = getEffectiveReactionConfig(session, reactionKey);

          if (reactionConfig && reactionConfig.action) {
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
            await notifyHuman(event, priority);
          }
        }
      }
    } else {
      // No status transition — track current state
      states.set(session.id, newStatus);

      // Check for automated review comments (bot/linter feedback) each poll cycle.
      // Deduplication is handled inside checkAutomatedComments via fingerprinting.
      await checkAutomatedComments(session);

      // Check if we should re-trigger a reaction for persistent problematic conditions
      // (e.g., CI has been failing for 10 minutes and agent hasn't fixed it yet).
      await checkPersistentConditions(session, newStatus);
    }
  }

  /** Run one polling cycle across all sessions. */
  async function pollAll(): Promise<void> {
    // Re-entrancy guard: skip if previous poll is still running
    if (polling) return;
    polling = true;

    try {
      const sessions = await sessionManager.list();

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
      for (const sessionId of automatedCommentFingerprints.keys()) {
        if (!currentSessionIds.has(sessionId)) {
          automatedCommentFingerprints.delete(sessionId);
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
          if (reactionConfig && reactionConfig.action) {
            const event = createEvent("summary.all_complete", {
              sessionId: "system",
              projectId: "all",
              message: `All ${sessions.length} session(s) complete`,
              priority: "info",
              data: { totalSessions: sessions.length },
            });
            eventLog.log(event);
            if (reactionConfig.auto !== false || reactionConfig.action === "notify") {
              await executeReaction("system", "all", reactionKey, reactionConfig as ReactionConfig);
            }
          }
        }
      }
    } catch {
      // Poll cycle failed — will retry next interval
    } finally {
      polling = false;
    }
  }

  return {
    start(intervalMs = 30_000): void {
      if (pollTimer) return; // Already running
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
      const session = await sessionManager.get(sessionId);
      if (!session) throw new Error(`Session ${sessionId} not found`);
      await checkSession(session);
    },
  };
}
