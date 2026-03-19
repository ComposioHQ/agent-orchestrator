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
    sessionId: SessionId,
    projectId: string,
    reactionKey: string,
    reactionConfig: ReactionConfig,
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
    const action = reactionConfig.action ?? "notify";

    switch (action) {
      case "send-to-agent": {
        if (reactionConfig.message) {
          // On first trigger, also notify the human so they know a reaction
          // was dispatched (e.g. "CI failed — agent notified").  Subsequent
          // retries stay silent until escalation.
          if (tracker.attempts === 1) {
            const firstTriggerEvent = createEvent("reaction.triggered", {
              sessionId,
              projectId,
              message: `${reactionKey}: dispatching to agent (${sessionId})`,
              data: { reactionKey, action: "send-to-agent", attempt: 1 },
            });
            await notifyHuman(firstTriggerEvent, reactionConfig.priority ?? "info");
          }

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

  function clearReactionTracker(sessionId: SessionId, reactionKey: string): void {
    reactionTrackers.delete(`${sessionId}:${reactionKey}`);
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
      clearReactionTracker(session.id, humanReactionKey);
      clearReactionTracker(session.id, automatedReactionKey);
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
        clearReactionTracker(session.id, humanReactionKey);
      }
      if (pendingFingerprint !== lastPendingFingerprint) {
        updateSessionMetadata(session, {
          lastPendingReviewFingerprint: pendingFingerprint,
        });
      }

      if (!pendingFingerprint) {
        clearReactionTracker(session.id, humanReactionKey);
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
        clearReactionTracker(session.id, automatedReactionKey);
        updateSessionMetadata(session, {
          lastAutomatedReviewFingerprint: automatedFingerprint,
        });
      }

      if (!automatedFingerprint) {
        clearReactionTracker(session.id, automatedReactionKey);
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

  /** Send a notification to all configured notifiers. */
  async function notifyHuman(event: OrchestratorEvent, priority: EventPriority): Promise<void> {
    const eventWithPriority = { ...event, priority };
    const notifierNames = config.notificationRouting[priority] ?? config.defaults.notifiers;

    for (const name of notifierNames) {
      const notifier = registry.get<Notifier>("notifier", name);
      if (notifier) {
        try {
          await notifier.notify(eventWithPriority);
        } catch (err) {
          // Log notifier failures so they are visible in observability output
          // instead of being silently swallowed.
          observer.recordOperation({
            metric: "lifecycle_poll",
            operation: "notifyHuman",
            outcome: "failure",
            correlationId: createCorrelationId("notify-error"),
            projectId: event.projectId ?? "unknown",
            sessionId: event.sessionId ?? "unknown",
            data: {
              notifier: name,
              eventType: event.type,
              error: err instanceof Error ? err.message : String(err),
            },
            level: "error",
          });
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
          clearReactionTracker(session.id, oldReactionKey);
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
          await notifyHuman(event, priority);
        }
      }

      // Clean up runtime and workspace for terminal sessions.
      // When lifecycle detects a "merged" or "killed" transition, the metadata
      // is updated but the runtime (tmux) and workspace (worktree) are left
      // running.  This causes zombie sessions that consume resources and confuse
      // status output.  Calling sessionManager.kill() tears down runtime +
      // workspace and archives the metadata — the same thing `ao session kill`
      // does manually.
      if (newStatus === "merged" || newStatus === "killed") {
        try {
          await sessionManager.kill(session.id);
        } catch {
          // Session may already be partially cleaned up — not critical
        }
      }
    } else {
      // No transition but track current state
      states.set(session.id, newStatus);
    }

    await maybeDispatchReviewBacklog(session, oldStatus, newStatus, transitionReaction);
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
          if (reactionConfig && reactionConfig.action) {
            if (reactionConfig.auto !== false || reactionConfig.action === "notify") {
              await executeReaction("system", "all", reactionKey, reactionConfig as ReactionConfig);
            }
          }
        }
      }
      if (scopedProjectId) {
        observer.recordOperation({
          metric: "lifecycle_poll",
          operation: "lifecycle.poll",
          outcome: "success",
          correlationId,
          projectId: scopedProjectId,
          durationMs: Date.now() - startedAt,
          data: { sessionCount: sessions.length, activeSessionCount: activeSessions.length },
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
