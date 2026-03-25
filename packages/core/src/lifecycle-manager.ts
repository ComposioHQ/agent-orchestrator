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
  type ReactionConfig,
  type ReactionResult,
  type PluginRegistry,
  type Runtime,
  type Agent,
  type SCM,
  type Notifier,
  type Session,
  type EventPriority,
  type ProjectConfig as _ProjectConfig,
} from "./types.js";
import { updateMetadata } from "./metadata.js";
import { getSessionsDir } from "./paths.js";
import { createCorrelationId, createProjectObserver } from "./observability.js";
import { resolveAgentSelection, resolveSessionRole } from "./agent-selection.js";

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

function transitionLogLevel(status: SessionStatus): "info" | "warn" | "error" {
  const eventType = statusToEventType(undefined, status);
  if (!eventType) {
    return "info";
  }
  const priority = inferPriority(eventType);
  if (priority === "urgent") {
    return "error";
  }
  if (priority === "warning") {
    return "warn";
  }
  return "info";
}

export interface LifecycleManagerDeps {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  sessionManager: SessionManager;
  /** When set, only poll sessions belonging to this project. */
  projectId?: string;
}

/** Track attempt counts for reactions per session. */
interface ReactionTracker {
  attempts: number;
  firstTriggered: Date;
  unresolvedNotifierSignature?: string;
}

interface NotificationTarget {
  name: string;
  notifier: Notifier;
}

interface NotificationPlan {
  notifierNames: string[];
  resolvedTargets: NotificationTarget[];
  signature: string;
}

/** Create a LifecycleManager instance. */
export function createLifecycleManager(deps: LifecycleManagerDeps): LifecycleManager {
  const { config, registry, sessionManager, projectId: scopedProjectId } = deps;
  const observer = createProjectObserver(config, "lifecycle-manager");

  const states = new Map<SessionId, SessionStatus>();
  const reactionTrackers = new Map<string, ReactionTracker>(); // "sessionId:reactionKey"
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let polling = false; // re-entrancy guard
  let allCompleteEmitted = false; // guard against repeated all_complete

  /** Check if idle time exceeds the agent-stuck threshold. */
  function isIdleBeyondThreshold(session: Session, idleTimestamp: Date): boolean {
    const stuckReaction = getReactionConfigForSession(session, "agent-stuck");
    const thresholdStr = stuckReaction?.threshold;
    if (typeof thresholdStr !== "string") return false;
    const stuckThresholdMs = parseDuration(thresholdStr);
    if (stuckThresholdMs <= 0) return false;
    const idleMs = Date.now() - idleTimestamp.getTime();
    return idleMs > stuckThresholdMs;
  }

  /** Determine current status for a session by polling plugins. */
  async function determineStatus(session: Session): Promise<SessionStatus> {
    const project = config.projects[session.projectId];
    if (!project) return session.status;

    const agentName = resolveAgentSelection({
      role: resolveSessionRole(session.id, session.metadata),
      project,
      defaults: config.defaults,
      persistedAgent: session.metadata["agent"],
    }).agentName;
    const agent = registry.get<Agent>("agent", agentName);
    const scm = project.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;

    // Track activity state across steps so stuck detection can run after PR checks
    let detectedIdleTimestamp: Date | null = null;

    // 1. Check if runtime is alive
    if (session.runtimeHandle) {
      const runtime = registry.get<Runtime>("runtime", project.runtime ?? config.defaults.runtime);
      if (runtime) {
        const alive = await runtime.isAlive(session.runtimeHandle).catch(() => true);
        if (!alive) return "killed";
      }
    }

    // 2. Check agent activity — prefer JSONL-based detection (runtime-agnostic)
    if (agent && session.runtimeHandle) {
      try {
        // Try JSONL-based activity detection first (reads agent's session files directly)
        const activityState = await agent.getActivityState(session, config.readyThresholdMs);
        if (activityState) {
          if (activityState.state === "waiting_input") return "needs_input";
          if (activityState.state === "exited") return "killed";

          if (
            (activityState.state === "idle" || activityState.state === "blocked") &&
            activityState.timestamp
          ) {
            detectedIdleTimestamp = activityState.timestamp;
          }

          // active/ready/idle (below threshold)/blocked (below threshold) —
          // proceed to PR checks below
        } else {
          // getActivityState returned null — fall back to terminal output parsing
          const runtime = registry.get<Runtime>(
            "runtime",
            project.runtime ?? config.defaults.runtime,
          );
          const terminalOutput = runtime ? await runtime.getOutput(session.runtimeHandle, 10) : "";
          if (terminalOutput) {
            const activity = agent.detectActivity(terminalOutput);
            if (activity === "waiting_input") return "needs_input";

            const processAlive = await agent.isProcessRunning(session.runtimeHandle);
            if (!processAlive) return "killed";
          }
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
    //    Skip orchestrator sessions — they sit on the base branch (e.g. master)
    //    and should never own a PR.
    if (
      !session.pr &&
      scm &&
      session.branch &&
      session.metadata["prAutoDetect"] !== "off" &&
      session.metadata["role"] !== "orchestrator" &&
      !session.id.endsWith("-orchestrator")
    ) {
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
        if (reviewDecision === "approved" || reviewDecision === "none") {
          // Check merge readiness — treat "none" (no reviewers required)
          // the same as "approved" so CI-green PRs reach "mergeable" status
          // and fire the merge.ready event / approved-and-green reaction.
          const mergeReady = await scm.getMergeability(session.pr);
          if (mergeReady.mergeable) return "mergeable";
          if (reviewDecision === "approved") return "approved";
        }
        if (reviewDecision === "pending") return "review_pending";

        // 4b. Post-PR stuck detection: agent has a PR open but is idle beyond
        // threshold. This catches the case where step 2's stuck check was
        // bypassed (getActivityState returned null) or the idle timestamp
        // wasn't available during step 2 but the session has been at pr_open
        // for a long time. Without this, sessions get stuck at "pr_open" forever.
        if (detectedIdleTimestamp && isIdleBeyondThreshold(session, detectedIdleTimestamp)) {
          return "stuck";
        }

        return "pr_open";
      } catch {
        // SCM check failed — keep current status
      }
    }

    // 5. Post-all stuck detection: if we detected idle in step 2 but had no PR,
    // still check stuck threshold. This handles agents that finish without creating a PR.
    if (detectedIdleTimestamp && isIdleBeyondThreshold(session, detectedIdleTimestamp)) {
      return "stuck";
    }

    // 6. Default: if agent is active, it's working
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
    session: Session | null,
    sessionId: SessionId,
    projectId: string,
    reactionKey: string,
    reactionConfig: ReactionConfig,
  ): Promise<ReactionResult> {
    const tracker = getReactionTracker(session, sessionId, reactionKey);
    const action = reactionConfig.action ?? "notify";
    const nextAttempt = tracker.attempts + 1;
    const shouldEscalate = shouldEscalateReaction(tracker, reactionConfig, nextAttempt);

    let notificationPriority: EventPriority | null = null;
    if (shouldEscalate) {
      notificationPriority = reactionConfig.priority ?? "urgent";
    } else if (action === "notify") {
      notificationPriority = reactionConfig.priority ?? "info";
    } else if (action === "auto-merge") {
      notificationPriority = "action";
    }

    const notificationAction = shouldEscalate ? "escalated" : action;
    const notificationPlan = notificationPriority
      ? resolveNotificationPlan(notificationPriority)
      : null;

    if (notificationPlan && shouldSkipUnresolvedNotification(tracker, notificationPlan)) {
      return {
        reactionType: reactionKey,
        success: false,
        action: notificationAction,
        escalated: shouldEscalate,
      };
    }

    tracker.attempts = nextAttempt;
    if (notificationPlan) {
      if (
        notificationPlan.notifierNames.length > 0 &&
        notificationPlan.resolvedTargets.length === 0
      ) {
        tracker.unresolvedNotifierSignature = notificationPlan.signature;
        persistReactionTracker(session, sessionId, reactionKey, tracker);
        return {
          reactionType: reactionKey,
          success: false,
          action: notificationAction,
          escalated: shouldEscalate,
        };
      }
      tracker.unresolvedNotifierSignature = undefined;
    } else {
      tracker.unresolvedNotifierSignature = undefined;
    }
    cacheReactionTracker(sessionId, reactionKey, tracker);

    if (shouldEscalate) {
      // Escalate to human
      const event = createEvent("reaction.escalated", {
        sessionId,
        projectId,
        message: `Reaction '${reactionKey}' escalated after ${tracker.attempts} attempts`,
        data: { reactionKey, attempts: tracker.attempts },
      });
      const delivered = await notifyHuman(
        event,
        reactionConfig.priority ?? "urgent",
        notificationPlan ?? undefined,
        session,
      );
      if (delivered) {
        clearReactionTracker(sessionId, reactionKey, session);
      } else {
        persistReactionTracker(session, sessionId, reactionKey, tracker);
      }
      return {
        reactionType: reactionKey,
        success: delivered,
        action: "escalated",
        escalated: true,
      };
    }

    switch (action) {
      case "send-to-agent": {
        if (reactionConfig.message) {
          try {
            await sessionManager.send(sessionId, reactionConfig.message);
            clearReactionTracker(sessionId, reactionKey, session);

            return {
              reactionType: reactionKey,
              success: true,
              action: "send-to-agent",
              message: reactionConfig.message,
              escalated: false,
            };
          } catch {
            // Send failed — allow retry on next poll cycle (don't escalate immediately)
            persistReactionTracker(session, sessionId, reactionKey, tracker);
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
        const delivered = await notifyHuman(
          event,
          reactionConfig.priority ?? "info",
          notificationPlan ?? undefined,
          session,
        );
        if (delivered) {
          clearReactionTracker(sessionId, reactionKey, session);
        } else {
          persistReactionTracker(session, sessionId, reactionKey, tracker);
        }
        return {
          reactionType: reactionKey,
          success: delivered,
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
        const delivered = await notifyHuman(event, "action", notificationPlan ?? undefined, session);
        if (delivered) {
          clearReactionTracker(sessionId, reactionKey, session);
        } else {
          persistReactionTracker(session, sessionId, reactionKey, tracker);
        }
        return {
          reactionType: reactionKey,
          success: delivered,
          action: "auto-merge",
          escalated: false,
        };
      }
    }

    persistReactionTracker(session, sessionId, reactionKey, tracker);
    return {
      reactionType: reactionKey,
      success: false,
      action,
      escalated: false,
    };
  }

  function getReactionConfigForSession(
    session: Session,
    reactionKey: string,
  ): ReactionConfig | null {
    const project = config.projects[session.projectId];
    const globalReaction = config.reactions[reactionKey];
    const projectReaction = project?.reactions?.[reactionKey];
    const reactionConfig = projectReaction
      ? { ...globalReaction, ...projectReaction }
      : globalReaction;
    return reactionConfig ? (reactionConfig as ReactionConfig) : null;
  }

  function updateSessionMetadata(session: Session, updates: Partial<Record<string, string>>): void {
    const project = config.projects[session.projectId];
    if (!project) return;

    const sessionsDir = getSessionsDir(config.configPath, project.path);
    updateMetadata(sessionsDir, session.id, updates);

    const cleaned = Object.fromEntries(
      Object.entries(session.metadata).filter(([key]) => {
        const update = updates[key];
        return update === undefined || update !== "";
      }),
    );
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined || value === "") continue;
      cleaned[key] = value;
    }
    session.metadata = cleaned;
  }

  function reactionTrackerMetadataKey(
    reactionKey: string,
    field: "attempts" | "firstTriggeredAt" | "unresolvedNotifierSignature",
  ): string {
    return `reaction.${reactionKey}.${field}`;
  }

  function shouldEscalateReaction(
    tracker: ReactionTracker,
    reactionConfig: ReactionConfig,
    attempts: number,
  ): boolean {
    const maxRetries = reactionConfig.retries ?? Infinity;
    const escalateAfter = reactionConfig.escalateAfter;
    let shouldEscalate = attempts > maxRetries;

    if (typeof escalateAfter === "string") {
      const durationMs = parseDuration(escalateAfter);
      if (durationMs > 0 && Date.now() - tracker.firstTriggered.getTime() > durationMs) {
        shouldEscalate = true;
      }
    }

    if (typeof escalateAfter === "number" && attempts > escalateAfter) {
      shouldEscalate = true;
    }

    return shouldEscalate;
  }

  function resolveNotificationPlan(priority: EventPriority): NotificationPlan {
    const notifierNames = config.notificationRouting[priority] ?? config.defaults.notifiers;
    const resolvedTargets: NotificationTarget[] = [];

    for (const name of notifierNames) {
      const notifier = registry.get<Notifier>("notifier", name);
      if (notifier) {
        resolvedTargets.push({ name, notifier });
      }
    }

    return {
      notifierNames,
      resolvedTargets,
      signature: notifierNames.join(","),
    };
  }

  function shouldSkipUnresolvedNotification(
    tracker: ReactionTracker,
    plan: NotificationPlan,
  ): boolean {
    return (
      plan.notifierNames.length > 0 &&
      plan.resolvedTargets.length === 0 &&
      tracker.unresolvedNotifierSignature === plan.signature
    );
  }

  function hasReactionTrackerState(session: Session, reactionKey: string): boolean {
    return (
      reactionTrackers.has(`${session.id}:${reactionKey}`) ||
      session.metadata[reactionTrackerMetadataKey(reactionKey, "attempts")] !== undefined ||
      session.metadata[reactionTrackerMetadataKey(reactionKey, "firstTriggeredAt")] !== undefined ||
      session.metadata[reactionTrackerMetadataKey(reactionKey, "unresolvedNotifierSignature")] !==
        undefined
    );
  }

  function getReactionTracker(
    session: Session | null,
    sessionId: SessionId,
    reactionKey: string,
  ): ReactionTracker {
    const trackerKey = `${sessionId}:${reactionKey}`;
    const tracked = reactionTrackers.get(trackerKey);
    if (tracked) {
      return tracked;
    }

    const persistedAttempts = session
      ? Number.parseInt(session.metadata[reactionTrackerMetadataKey(reactionKey, "attempts")] ?? "0", 10)
      : 0;
    const persistedFirstTriggeredAt = session?.metadata[
      reactionTrackerMetadataKey(reactionKey, "firstTriggeredAt")
    ];
    const persistedUnresolvedNotifierSignature = session?.metadata[
      reactionTrackerMetadataKey(reactionKey, "unresolvedNotifierSignature")
    ];
    const parsedFirstTriggered = persistedFirstTriggeredAt
      ? new Date(persistedFirstTriggeredAt)
      : new Date();

    const tracker: ReactionTracker = {
      attempts: Number.isFinite(persistedAttempts) ? persistedAttempts : 0,
      firstTriggered:
        Number.isNaN(parsedFirstTriggered.getTime()) ? new Date() : parsedFirstTriggered,
      unresolvedNotifierSignature: persistedUnresolvedNotifierSignature,
    };
    reactionTrackers.set(trackerKey, tracker);
    return tracker;
  }

  function persistReactionTracker(
    session: Session | null,
    sessionId: SessionId,
    reactionKey: string,
    tracker: ReactionTracker,
  ): void {
    cacheReactionTracker(sessionId, reactionKey, tracker);
    if (!session) {
      return;
    }

    updateSessionMetadata(session, {
      [reactionTrackerMetadataKey(reactionKey, "attempts")]: String(tracker.attempts),
      [reactionTrackerMetadataKey(reactionKey, "firstTriggeredAt")]:
        tracker.firstTriggered.toISOString(),
      [reactionTrackerMetadataKey(reactionKey, "unresolvedNotifierSignature")]:
        tracker.unresolvedNotifierSignature ?? "",
    });
  }

  function cacheReactionTracker(
    sessionId: SessionId,
    reactionKey: string,
    tracker: ReactionTracker,
  ): void {
    reactionTrackers.set(`${sessionId}:${reactionKey}`, tracker);
  }

  function clearReactionTracker(
    sessionId: SessionId,
    reactionKey: string,
    session?: Session | null,
  ): void {
    reactionTrackers.delete(`${sessionId}:${reactionKey}`);
    if (!session) {
      return;
    }

    updateSessionMetadata(session, {
      [reactionTrackerMetadataKey(reactionKey, "attempts")]: "",
      [reactionTrackerMetadataKey(reactionKey, "firstTriggeredAt")]: "",
      [reactionTrackerMetadataKey(reactionKey, "unresolvedNotifierSignature")]: "",
    });
  }

  function notifierMetadataKey(notifierName: string, field: string): string {
    return `notifier.${notifierName}.${field}`;
  }

  function sanitizeNotifierReason(error: unknown): string {
    return (error instanceof Error ? error.message : String(error))
      .replace(/[\r\n]+/g, " ")
      .trim()
      .slice(0, 200);
  }

  function recordNotifierOutcome(
    projectId: string,
    session: Session | null,
    notifierName: string,
    event: OrchestratorEvent,
    priority: EventPriority,
    outcome: "success" | "failure",
    error?: unknown,
  ): void {
    const correlationId = createCorrelationId("notifier");
    const timestamp = new Date().toISOString();
    const reason = outcome === "failure" ? sanitizeNotifierReason(error) : undefined;

    observer.recordOperation({
      metric: "notification",
      operation: "notifier.notify",
      outcome,
      correlationId,
      projectId,
      sessionId: event.sessionId,
      reason,
      data: {
        notifier: notifierName,
        eventType: event.type,
        priority,
      },
      level: outcome === "failure" ? "error" : "info",
    });

    if (!session) {
      return;
    }

    const currentFailures = Number.parseInt(
      session.metadata[notifierMetadataKey(notifierName, "consecutiveFailures")] ?? "0",
      10,
    );

    updateSessionMetadata(session, {
      [notifierMetadataKey(notifierName, "status")]: outcome === "failure" ? "warn" : "ok",
      [notifierMetadataKey(notifierName, "lastEventType")]: event.type,
      [notifierMetadataKey(notifierName, "lastPriority")]: priority,
      [notifierMetadataKey(notifierName, "consecutiveFailures")]:
        outcome === "failure" ? String(currentFailures + 1) : "0",
      [notifierMetadataKey(notifierName, "lastFailureAt")]: outcome === "failure" ? timestamp : "",
      [notifierMetadataKey(notifierName, "lastFailureReason")]: outcome === "failure" ? reason! : "",
      ...(outcome === "success"
        ? { [notifierMetadataKey(notifierName, "lastSuccessAt")]: timestamp }
        : {}),
    });
  }

  function logNotifierOutcomeRecordingError(
    notifierName: string,
    event: OrchestratorEvent,
    error: unknown,
  ): void {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[ao] failed to record notifier outcome for ${notifierName} on ${event.type} (${event.sessionId}): ${reason}\n`,
    );
  }

  function recordSessionCheckFailure(
    session: Session,
    correlationId: string,
    error: unknown,
  ): void {
    const reason = error instanceof Error ? error.message : String(error);
    observer.recordOperation({
      metric: "lifecycle_poll",
      operation: "lifecycle.check",
      outcome: "failure",
      correlationId,
      projectId: session.projectId,
      sessionId: session.id,
      reason,
      data: {
        phase: "poll",
      },
      level: "error",
    });
    observer.setHealth({
      surface: "lifecycle.session-check",
      status: "error",
      projectId: session.projectId,
      correlationId,
      reason,
      details: {
        projectId: session.projectId,
        sessionId: session.id,
      },
    });
    process.stderr.write(`[ao] lifecycle check failed for ${session.id}: ${reason}\n`);
  }

  function makeFingerprint(ids: string[]): string {
    return [...ids].sort().join(",");
  }

  async function maybeDispatchReviewBacklog(
    session: Session,
    oldStatus: SessionStatus,
    newStatus: SessionStatus,
    transitionReaction?: { key: string; result: ReactionResult | null },
  ): Promise<void> {
    const project = config.projects[session.projectId];
    if (!project || !session.pr) return;

    const scm = project.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;
    if (!scm) return;

    const humanReactionKey = "changes-requested";
    const automatedReactionKey = "bugbot-comments";

    if (newStatus === "merged" || newStatus === "killed") {
      clearReactionTracker(session.id, humanReactionKey, session);
      clearReactionTracker(session.id, automatedReactionKey, session);
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
        clearReactionTracker(session.id, humanReactionKey, session);
      }
      if (pendingFingerprint !== lastPendingFingerprint) {
        updateSessionMetadata(session, {
          lastPendingReviewFingerprint: pendingFingerprint,
        });
      }

      if (!pendingFingerprint) {
        clearReactionTracker(session.id, humanReactionKey, session);
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
        const reactionConfig = getReactionConfigForSession(session, humanReactionKey);
        if (
          reactionConfig &&
          reactionConfig.action &&
          (reactionConfig.auto !== false || reactionConfig.action === "notify")
        ) {
          const result = await executeReaction(
            session,
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
      const automatedFingerprint = makeFingerprint(automatedComments.map((comment) => comment.id));
      const lastAutomatedFingerprint = session.metadata["lastAutomatedReviewFingerprint"] ?? "";
      const lastAutomatedDispatchHash = session.metadata["lastAutomatedReviewDispatchHash"] ?? "";

      if (automatedFingerprint !== lastAutomatedFingerprint) {
        clearReactionTracker(session.id, automatedReactionKey, session);
        updateSessionMetadata(session, {
          lastAutomatedReviewFingerprint: automatedFingerprint,
        });
      }

      if (!automatedFingerprint) {
        clearReactionTracker(session.id, automatedReactionKey, session);
        updateSessionMetadata(session, {
          lastAutomatedReviewFingerprint: "",
          lastAutomatedReviewDispatchHash: "",
          lastAutomatedReviewDispatchAt: "",
        });
      } else if (automatedFingerprint !== lastAutomatedDispatchHash) {
        const reactionConfig = getReactionConfigForSession(session, automatedReactionKey);
        if (
          reactionConfig &&
          reactionConfig.action &&
          (reactionConfig.auto !== false || reactionConfig.action === "notify")
        ) {
          const result = await executeReaction(
            session,
            session.id,
            session.projectId,
            automatedReactionKey,
            reactionConfig,
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

  async function maybeRetryMergeableReaction(
    session: Session,
    oldStatus: SessionStatus,
    newStatus: SessionStatus,
  ): Promise<void> {
    const reactionKey = "approved-and-green";
    if (newStatus !== "mergeable" || oldStatus !== newStatus) {
      return;
    }
    if (!hasReactionTrackerState(session, reactionKey)) {
      return;
    }

    const reactionConfig = getReactionConfigForSession(session, reactionKey);
    if (
      !reactionConfig ||
      !reactionConfig.action ||
      (reactionConfig.auto === false && reactionConfig.action !== "notify")
    ) {
      return;
    }

    await executeReaction(session, session.id, session.projectId, reactionKey, reactionConfig);
  }

  /** Send a notification to all configured notifiers. */
  async function notifyHuman(
    event: OrchestratorEvent,
    priority: EventPriority,
    plan?: NotificationPlan,
    session?: Session | null,
  ): Promise<boolean> {
    const eventWithPriority = { ...event, priority };
    const notificationPlan = plan ?? resolveNotificationPlan(priority);
    const trackedSession = session ?? (await sessionManager.get(event.sessionId).catch(() => null));
    let delivered = false;

    for (const { name, notifier } of notificationPlan.resolvedTargets) {
      let outcome: "success" | "failure" = "success";
      let notifyError: unknown;
      try {
        await notifier.notify(eventWithPriority);
        delivered = true;
      } catch (error) {
        outcome = "failure";
        notifyError = error;
      }

      try {
        recordNotifierOutcome(
          event.projectId,
          trackedSession,
          name,
          eventWithPriority,
          priority,
          outcome,
          notifyError,
        );
      } catch (recordError) {
        logNotifierOutcomeRecordingError(name, eventWithPriority, recordError);
      }
    }

    return delivered;
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
    let transitionReaction: { key: string; result: ReactionResult | null } | undefined;

    if (newStatus !== oldStatus) {
      const correlationId = createCorrelationId("lifecycle-transition");
      // State transition detected
      states.set(session.id, newStatus);
      updateSessionMetadata(session, { status: newStatus });
      observer.recordOperation({
        metric: "lifecycle_poll",
        operation: "lifecycle.transition",
        outcome: "success",
        correlationId,
        projectId: session.projectId,
        sessionId: session.id,
        data: { oldStatus, newStatus },
        level: transitionLogLevel(newStatus),
      });

      // Reset allCompleteEmitted when any session becomes active again
      if (newStatus !== "merged" && newStatus !== "killed") {
        allCompleteEmitted = false;
      }

      // Clear reaction trackers for the old status so retries reset on state changes
      const oldEventType = statusToEventType(undefined, oldStatus);
      if (oldEventType) {
        const oldReactionKey = eventToReactionKey(oldEventType);
        if (oldReactionKey) {
          clearReactionTracker(session.id, oldReactionKey, session);
        }
      }

      // Handle transition: notify humans and/or trigger reactions
      const eventType = statusToEventType(oldStatus, newStatus);
      if (eventType) {
        let reactionHandledNotify = false;
        const reactionKey = eventToReactionKey(eventType);

        if (reactionKey) {
          const reactionConfig = getReactionConfigForSession(session, reactionKey);

          if (reactionConfig && reactionConfig.action) {
            // auto: false skips automated agent actions but still allows notifications
            if (reactionConfig.auto !== false || reactionConfig.action === "notify") {
              const reactionResult = await executeReaction(
                session,
                session.id,
                session.projectId,
                reactionKey,
                reactionConfig,
              );
              transitionReaction = { key: reactionKey, result: reactionResult };
              // Reaction is handling this event — suppress immediate human notification.
              // "send-to-agent" retries + escalates on its own; "notify"/"auto-merge"
              // already call notifyHuman internally. Notifying here would bypass the
              // delayed escalation behaviour configured via retries/escalateAfter.
              reactionHandledNotify = true;
            }
          }
        }

        // For transitions not already notified by a reaction, notify humans.
        // All priorities (including "info") are routed through notificationRouting
        // so the config controls which notifiers receive each priority level.
        if (!reactionHandledNotify) {
          const priority = inferPriority(eventType);
          const event = createEvent(eventType, {
            sessionId: session.id,
            projectId: session.projectId,
            message: `${session.id}: ${oldStatus} → ${newStatus}`,
            data: { oldStatus, newStatus },
          });
          await notifyHuman(event, priority, undefined, session);
        }
      }
    } else {
      // No transition but track current state
      states.set(session.id, newStatus);
    }

    await maybeDispatchReviewBacklog(session, oldStatus, newStatus, transitionReaction);
    await maybeRetryMergeableReaction(session, oldStatus, newStatus);
  }

  /** Run one polling cycle across all sessions. */
  async function pollAll(): Promise<void> {
    const correlationId = createCorrelationId("lifecycle-poll");
    const startedAt = Date.now();
    // Re-entrancy guard: skip if previous poll is still running
    if (polling) return;
    polling = true;

    try {
      const sessions = await sessionManager.list(scopedProjectId);

      // Include sessions that are active OR whose status changed from what we last saw
      // (e.g., list() detected a dead runtime and marked it "killed" — we need to
      // process that transition even though the new status is terminal)
      const sessionsToCheck = sessions.filter((s) => {
        if (s.status !== "merged" && s.status !== "killed") return true;
        const tracked = states.get(s.id);
        return tracked !== undefined && tracked !== s.status;
      });

      // Poll all sessions concurrently and record individual failures so one
      // bad session cannot disappear behind the batch-level success path.
      const pollResults = await Promise.allSettled(sessionsToCheck.map((s) => checkSession(s)));
      let failedSessionCount = 0;
      for (const [index, result] of pollResults.entries()) {
        if (result.status !== "rejected") continue;
        failedSessionCount++;
        const session = sessionsToCheck[index];
        if (!session) continue;
        recordSessionCheckFailure(session, correlationId, result.reason);
      }

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
        let emitAllComplete = true;

        // Execute all-complete reaction if configured
        const reactionKey = eventToReactionKey("summary.all_complete");
        if (reactionKey) {
          const reactionConfig = config.reactions[reactionKey];
          if (reactionConfig && reactionConfig.action) {
            if (reactionConfig.auto !== false || reactionConfig.action === "notify") {
              const result = await executeReaction(
                null,
                "system",
                "all",
                reactionKey,
                reactionConfig as ReactionConfig,
              );
              emitAllComplete = result.success;
            }
          }
        }
        allCompleteEmitted = emitAllComplete;
      }
      if (scopedProjectId) {
        observer.recordOperation({
          metric: "lifecycle_poll",
          operation: "lifecycle.poll",
          outcome: "success",
          correlationId,
          projectId: scopedProjectId,
          durationMs: Date.now() - startedAt,
          data: {
            sessionCount: sessions.length,
            activeSessionCount: activeSessions.length,
            failedSessionCount,
          },
          level: "info",
        });
        observer.setHealth({
          surface: "lifecycle.worker",
          status: "ok",
          projectId: scopedProjectId,
          correlationId,
          details: {
            projectId: scopedProjectId,
            sessionCount: sessions.length,
            activeSessionCount: activeSessions.length,
            failedSessionCount,
          },
        });
      }
    } catch (err) {
      const errorReason = err instanceof Error ? err.message : String(err);
      observer.recordOperation({
        metric: "lifecycle_poll",
        operation: "lifecycle.poll",
        outcome: "failure",
        correlationId,
        projectId: scopedProjectId,
        durationMs: Date.now() - startedAt,
        reason: errorReason,
        level: "error",
      });
      observer.setHealth({
        surface: "lifecycle.worker",
        status: "error",
        projectId: scopedProjectId,
        correlationId,
        reason: errorReason,
        details: scopedProjectId ? { projectId: scopedProjectId } : { projectScope: "all" },
      });
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
