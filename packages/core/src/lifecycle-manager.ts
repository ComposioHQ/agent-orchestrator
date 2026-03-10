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
  resolveMergeMethod,
  type CIStatus,
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
  lastReactionFiredAtMs: number;
  escalatedAtMs?: number;
}

interface LifecyclePollStats {
  pollId: string;
  startedAtMs: number;
  totalSessions: number;
  checkedSessions: number;
  activeSessions: number;
  transitions: number;
  errors: number;
  notificationsSent: number;
  notificationFailures: number;
}

type LifecycleLogLevel = "info" | "error";

function serializeLogValue(value: unknown): unknown {
  if (value instanceof Error) {
    const cause = value.cause === undefined ? undefined : serializeLogValue(value.cause);
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack } : {}),
      ...(cause !== undefined ? { cause } : {}),
    };
  }

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
}

function serializeLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, serializeLogValue(value)]),
  );
}

function logLifecycle(
  level: LifecycleLogLevel,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      scope: "lifecycle",
      level,
      event,
      ...serializeLogFields(fields),
    }),
  );
}

function incrementPollError(pollStats?: LifecyclePollStats): void {
  if (pollStats) {
    pollStats.errors += 1;
  }
}

function createPollStats(): LifecyclePollStats {
  return {
    pollId: randomUUID(),
    startedAtMs: Date.now(),
    totalSessions: 0,
    checkedSessions: 0,
    activeSessions: 0,
    transitions: 0,
    errors: 0,
    notificationsSent: 0,
    notificationFailures: 0,
  };
}

const OPEN_PR_STATUS_POLL_INTERVAL_MS = 60_000;
const DEFAULT_CI_REACTION_REFIRE_INTERVAL_MS = 120_000;
const DEFAULT_REACTION_REFIRE_INTERVAL_MS = 300_000;

interface OpenPREvaluation {
  status: SessionStatus;
  ciStatus: CIStatus;
}

function parseTimestampMs(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isOpenPRStatusPollDue(session: Session): boolean {
  const lastPollAtMs = parseTimestampMs(session.metadata["lastPrStatusPollAt"]);
  if (lastPollAtMs === null) return true;
  return Date.now() - lastPollAtMs >= OPEN_PR_STATUS_POLL_INTERVAL_MS;
}

function shouldOverridePreservedPRStatus(status: SessionStatus): boolean {
  return (
    status === SESSION_STATUS.MERGED ||
    status === SESSION_STATUS.KILLED ||
    status === SESSION_STATUS.CI_FAILED ||
    status === SESSION_STATUS.CHANGES_REQUESTED ||
    status === SESSION_STATUS.MERGEABLE
  );
}

function getPersistentReactionKey(status: SessionStatus): string | null {
  switch (status) {
    case SESSION_STATUS.CI_FAILED:
      return "ci-failed";
    case SESSION_STATUS.CHANGES_REQUESTED:
      return "changes-requested";
    case SESSION_STATUS.STUCK:
      return "agent-stuck";
    default:
      return null;
  }
}

function getReactionRefireIntervalMs(
  reactionKey: string,
  reactionConfig: ReactionConfig,
): number {
  if (typeof reactionConfig.refireIntervalMs === "number") {
    return reactionConfig.refireIntervalMs;
  }

  if (reactionKey === "ci-failed") {
    return DEFAULT_CI_REACTION_REFIRE_INTERVAL_MS;
  }

  return DEFAULT_REACTION_REFIRE_INTERVAL_MS;
}

/** Create a LifecycleManager instance. */
export function createLifecycleManager(deps: LifecycleManagerDeps): LifecycleManager {
  const { config, registry, sessionManager, projectId: scopedProjectId } = deps;

  const states = new Map<SessionId, SessionStatus>();
  const reactionTrackers = new Map<string, ReactionTracker>(); // "sessionId:reactionKey"
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let polling = false; // re-entrancy guard
  let allCompleteEmitted = false; // guard against repeated all_complete

  function getOrCreateReactionTracker(sessionId: SessionId, reactionKey: string): ReactionTracker {
    const trackerKey = `${sessionId}:${reactionKey}`;
    let tracker = reactionTrackers.get(trackerKey);

    if (!tracker) {
      tracker = {
        attempts: 0,
        firstTriggered: new Date(),
        lastReactionFiredAtMs: 0,
      };
      reactionTrackers.set(trackerKey, tracker);
    }

    return tracker;
  }

  async function buildSendToAgentMessage(
    sessionId: SessionId,
    projectId: string,
    reactionKey: string,
    reactionConfig: ReactionConfig,
    pollStats?: LifecyclePollStats,
    session?: Session,
  ): Promise<string | null> {
    if (reactionConfig.message) {
      return reactionConfig.message;
    }

    if (reactionKey !== "ci-failed") {
      return null;
    }

    const fallbackMessage =
      "CI has failed on your PR. Please check the CI logs, fix the issue, and push.";
    const currentSession = session ?? (await sessionManager.get(sessionId));

    if (!currentSession?.pr) {
      return fallbackMessage;
    }

    const project = config.projects[currentSession.projectId] ?? config.projects[projectId];
    if (!project?.scm) {
      return fallbackMessage;
    }

    const scm = registry.get<SCM>("scm", project.scm.plugin);
    if (!scm?.getCIFailureLogs) {
      return fallbackMessage;
    }

    try {
      const logs = await scm.getCIFailureLogs(currentSession.pr);
      if (!logs) {
        return fallbackMessage;
      }

      return `CI failed on your PR. Here are the failure logs:\n\n${logs}\n\nPlease fix the failing test(s) and push.`;
    } catch (error) {
      incrementPollError(pollStats);
      logLifecycle("error", "reaction.ci_logs.failed", {
        pollId: pollStats?.pollId,
        projectId: currentSession.projectId,
        sessionId,
        reactionKey,
        pr: currentSession.pr,
        error,
      });
      return fallbackMessage;
    }
  }

  async function maybeRefirePersistentReaction(
    session: Session,
    status: SessionStatus,
    pollStats?: LifecyclePollStats,
  ): Promise<void> {
    const reactionKey = getPersistentReactionKey(status);
    if (!reactionKey) {
      return;
    }

    const reactionConfig = getReactionConfigForSession(session, reactionKey);
    if (!reactionConfig?.action) {
      return;
    }

    if (reactionConfig.auto === false && reactionConfig.action !== "notify") {
      return;
    }

    const tracker = reactionTrackers.get(`${session.id}:${reactionKey}`);
    if (!tracker || tracker.escalatedAtMs !== undefined) {
      return;
    }

    const refireIntervalMs = getReactionRefireIntervalMs(reactionKey, reactionConfig);
    if (Date.now() - tracker.lastReactionFiredAtMs < refireIntervalMs) {
      return;
    }

    await executeReaction(
      session.id,
      session.projectId,
      reactionKey,
      reactionConfig,
      pollStats,
      session,
    );
  }

  /** Check if idle time exceeds the agent-stuck threshold. */
  function isIdleBeyondThreshold(session: Session, idleTimestamp: Date): boolean {
    const stuckReaction =
      config.projects[session.projectId]?.reactions?.["agent-stuck"] ??
      config.reactions["agent-stuck"];
    const thresholdStr = (stuckReaction as Record<string, unknown> | undefined)?.threshold;
    if (typeof thresholdStr !== "string") return false;
    const stuckThresholdMs = parseDuration(thresholdStr);
    if (stuckThresholdMs <= 0) return false;
    const idleMs = Date.now() - idleTimestamp.getTime();
    return idleMs > stuckThresholdMs;
  }

  async function evaluateOpenPR(session: Session, scm: SCM): Promise<OpenPREvaluation> {
    if (!session.pr) {
      return {
        status: SESSION_STATUS.WORKING,
        ciStatus: CI_STATUS.NONE,
      };
    }

    const prState = await scm.getPRState(session.pr);
    if (prState === PR_STATE.MERGED) {
      return {
        status: SESSION_STATUS.MERGED,
        ciStatus: CI_STATUS.NONE,
      };
    }
    if (prState === PR_STATE.CLOSED) {
      return {
        status: SESSION_STATUS.KILLED,
        ciStatus: CI_STATUS.NONE,
      };
    }

    const ciStatus = await scm.getCISummary(session.pr);
    if (ciStatus === CI_STATUS.FAILING) {
      return {
        status: SESSION_STATUS.CI_FAILED,
        ciStatus,
      };
    }

    const reviewDecision = await scm.getReviewDecision(session.pr);
    if (reviewDecision === "changes_requested") {
      return {
        status: SESSION_STATUS.CHANGES_REQUESTED,
        ciStatus,
      };
    }

    if (reviewDecision === "approved" || reviewDecision === "none") {
      const mergeReady = await scm.getMergeability(session.pr);
      if (mergeReady.mergeable) {
        return {
          status: SESSION_STATUS.MERGEABLE,
          ciStatus,
        };
      }

      if (reviewDecision === "approved") {
        return {
          status: SESSION_STATUS.APPROVED,
          ciStatus,
        };
      }
    }

    if (reviewDecision === "pending") {
      return {
        status: SESSION_STATUS.REVIEW_PENDING,
        ciStatus,
      };
    }

    return {
      status: SESSION_STATUS.PR_OPEN,
      ciStatus,
    };
  }

  /** Determine current status for a session by polling plugins. */
  async function determineStatus(
    session: Session,
    currentStatus: SessionStatus,
    pollStats?: LifecyclePollStats,
  ): Promise<SessionStatus> {
    const project = config.projects[session.projectId];
    if (!project) return currentStatus;

    const agentName = session.metadata["agent"] ?? project.agent ?? config.defaults.agent;
    const agent = registry.get<Agent>("agent", agentName);
    const scm = project.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;
    const scmPlugin = project.scm?.plugin ?? "unknown";

    // Track activity state across steps so stuck detection can run after PR checks
    let detectedIdleTimestamp: Date | null = null;
    let preserveCurrentStatus = false;

    // 1. Check if runtime is alive
    if (session.runtimeHandle) {
      const runtime = registry.get<Runtime>("runtime", project.runtime ?? config.defaults.runtime);
      if (runtime) {
        const alive = await runtime.isAlive(session.runtimeHandle).catch((error: unknown) => {
          incrementPollError(pollStats);
          logLifecycle("error", "runtime.health_check.failed", {
            pollId: pollStats?.pollId,
            projectId: session.projectId,
            sessionId: session.id,
            runtimeName: project.runtime ?? config.defaults.runtime,
            error,
          });
          return true;
        });
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

          // Stuck detection: if agent is idle/blocked beyond the configured threshold,
          // transition to "stuck" so the agent-stuck reaction can fire.
          // BUT: if the session already has a PR, fall through to step 4 so
          // merge-readiness is checked first. Without this, stuck detection
          // short-circuits before the PR state checks and "mergeable" is
          // never reached — causing the pipeline to stall.
          if (
            (activityState.state === "idle" || activityState.state === "blocked") &&
            activityState.timestamp
          ) {
            if (isIdleBeyondThreshold(session, activityState.timestamp) && !session.pr) {
              return "stuck";
            }
            // Store idle timestamp for post-PR-check stuck detection (step 4b)
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
      } catch (error) {
        incrementPollError(pollStats);
        logLifecycle("error", "agent.activity_check.failed", {
          pollId: pollStats?.pollId,
          projectId: session.projectId,
          sessionId: session.id,
          agentName,
          error,
        });
        // On probe failure, preserve current stuck/needs_input state rather
        // than letting the fallback at the bottom coerce them to "working"
        if (
          currentStatus === SESSION_STATUS.STUCK ||
          currentStatus === SESSION_STATUS.NEEDS_INPUT
        ) {
          if (!session.pr) {
            return currentStatus;
          }

          preserveCurrentStatus = true;
        }
      }
    }

    // 3. Auto-detect PR by branch if metadata.pr is missing.
    //    This is critical for agents without auto-hook systems (Codex, Aider,
    //    OpenCode) that can't reliably write pr=<url> to metadata on their own.
    if (!session.pr && scm && session.branch && session.metadata["prAutoDetect"] !== "off") {
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
      } catch (error) {
        incrementPollError(pollStats);
        logLifecycle("error", "scm.pr_detect.failed", {
          pollId: pollStats?.pollId,
          projectId: session.projectId,
          sessionId: session.id,
          scm: scmPlugin,
          branch: session.branch,
          error,
        });
        // SCM detection failed — will retry next poll
      }
    }

    // 4. Check PR state if PR exists
    if (session.pr && scm) {
      if (!isOpenPRStatusPollDue(session)) {
        if (
          detectedIdleTimestamp &&
          isIdleBeyondThreshold(session, detectedIdleTimestamp) &&
          currentStatus === SESSION_STATUS.PR_OPEN
        ) {
          return SESSION_STATUS.STUCK;
        }

        return currentStatus;
      }

      try {
        const openPREvaluation = await evaluateOpenPR(session, scm);
        updateSessionMetadata(session, {
          lastPrStatusPollAt: new Date().toISOString(),
          lastPrCiStatus: openPREvaluation.ciStatus,
        });

        if (shouldOverridePreservedPRStatus(openPREvaluation.status)) {
          return openPREvaluation.status;
        }

        if (preserveCurrentStatus) {
          return currentStatus;
        }

        if (openPREvaluation.status === SESSION_STATUS.APPROVED) {
          return SESSION_STATUS.APPROVED;
        }

        if (openPREvaluation.status === SESSION_STATUS.REVIEW_PENDING) {
          return SESSION_STATUS.REVIEW_PENDING;
        }

        // 4b. Post-PR stuck detection: agent has a PR open but is idle beyond
        // threshold. This catches the case where step 2's stuck check was
        // bypassed (getActivityState returned null) or the idle timestamp
        // wasn't available during step 2 but the session has been at pr_open
        // for a long time. Without this, sessions get stuck at "pr_open" forever.
        if (detectedIdleTimestamp && isIdleBeyondThreshold(session, detectedIdleTimestamp)) {
          return SESSION_STATUS.STUCK;
        }

        return openPREvaluation.status;
      } catch (error) {
        incrementPollError(pollStats);
        logLifecycle("error", "scm.pr_check.failed", {
          pollId: pollStats?.pollId,
          projectId: session.projectId,
          sessionId: session.id,
          scm: scmPlugin,
          pr: session.pr,
          error,
        });
        if (preserveCurrentStatus) {
          return currentStatus;
        }
      }
    }

    if (preserveCurrentStatus) {
      return currentStatus;
    }

    // 5. Post-all stuck detection: if we detected idle in step 2 but had no PR,
    // still check stuck threshold. This handles agents that finish without creating a PR.
    if (detectedIdleTimestamp && isIdleBeyondThreshold(session, detectedIdleTimestamp)) {
      return "stuck";
    }

    // 6. Default: if agent is active, it's working
    if (
      currentStatus === SESSION_STATUS.SPAWNING ||
      currentStatus === SESSION_STATUS.STUCK ||
      currentStatus === SESSION_STATUS.NEEDS_INPUT
    ) {
      return SESSION_STATUS.WORKING;
    }
    return currentStatus;
  }

  /** Execute a reaction for a session. */
  async function executeReaction(
    sessionId: SessionId,
    projectId: string,
    reactionKey: string,
    reactionConfig: ReactionConfig,
    pollStats?: LifecyclePollStats,
    session?: Session,
  ): Promise<ReactionResult> {
    const tracker = getOrCreateReactionTracker(sessionId, reactionKey);
    const nowMs = Date.now();

    // Increment attempts before checking escalation
    tracker.attempts++;
    tracker.lastReactionFiredAtMs = nowMs;

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
      tracker.escalatedAtMs = nowMs;

      // Escalate to human
      const event = createEvent("reaction.escalated", {
        sessionId,
        projectId,
        message: `Reaction '${reactionKey}' escalated after ${tracker.attempts} attempts`,
        data: { reactionKey, attempts: tracker.attempts },
      });
      logLifecycle("info", "reaction.escalated", {
        pollId: pollStats?.pollId,
        projectId,
        sessionId,
        reactionKey,
        attempts: tracker.attempts,
      });
      await notifyHuman(event, reactionConfig.priority ?? "urgent", pollStats);
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
        const message = await buildSendToAgentMessage(
          sessionId,
          projectId,
          reactionKey,
          reactionConfig,
          pollStats,
          session,
        );

        if (message) {
          try {
            await sessionManager.send(sessionId, message);
            logLifecycle("info", "reaction.sent_to_agent", {
              pollId: pollStats?.pollId,
              projectId,
              sessionId,
              reactionKey,
              action,
            });

            return {
              reactionType: reactionKey,
              success: true,
              action: "send-to-agent",
              message,
              escalated: false,
            };
          } catch (error) {
            incrementPollError(pollStats);
            logLifecycle("error", "reaction.send_to_agent.failed", {
              pollId: pollStats?.pollId,
              projectId,
              sessionId,
              reactionKey,
              action,
              error,
            });
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
        await notifyHuman(event, reactionConfig.priority ?? "info", pollStats);
        return {
          reactionType: reactionKey,
          success: true,
          action: "notify",
          escalated: false,
        };
      }

      case "auto-merge": {
        const project = config.projects[projectId];
        const scm = project?.scm ? registry.get<SCM>("scm", project.scm.plugin) : null;
        const mergeMethod = resolveMergeMethod(project?.scm);

        if (!session?.pr || !project || !scm) {
          incrementPollError(pollStats);
          logLifecycle("error", "reaction.auto_merge.unavailable", {
            pollId: pollStats?.pollId,
            projectId,
            sessionId,
            reactionKey,
            hasProject: Boolean(project),
            hasPR: Boolean(session?.pr),
            hasSCM: Boolean(scm),
            mergeMethod,
          });
          const event = createEvent("reaction.triggered", {
            sessionId,
            projectId,
            message: `Auto-merge could not run for reaction '${reactionKey}'. Manual intervention required.`,
            data: { reactionKey, mergeMethod },
          });
          await notifyHuman(event, "urgent", pollStats);
          return {
            reactionType: reactionKey,
            success: false,
            action: "auto-merge",
            message: "Auto-merge unavailable",
            escalated: true,
          };
        }

        try {
          await scm.mergePR(session.pr, mergeMethod);
          clearReactionTracker(session.id, reactionKey);
          logLifecycle("info", "reaction.auto_merge.completed", {
            pollId: pollStats?.pollId,
            projectId,
            sessionId,
            reactionKey,
            prNumber: session.pr.number,
            mergeMethod,
          });
          const event = createEvent("merge.completed", {
            sessionId,
            projectId,
            message: `${sessionId}: auto-merged PR #${session.pr.number}`,
            data: {
              reactionKey,
              prNumber: session.pr.number,
              prUrl: session.pr.url,
              mergeMethod,
            },
          });
          await notifyHuman(event, inferPriority(event.type), pollStats);
          return {
            reactionType: reactionKey,
            success: true,
            action: "auto-merge",
            message: `Merged PR #${session.pr.number} with ${mergeMethod}`,
            escalated: false,
            resultingStatus: SESSION_STATUS.MERGED,
          };
        } catch (error) {
          incrementPollError(pollStats);
          logLifecycle("error", "reaction.auto_merge.failed", {
            pollId: pollStats?.pollId,
            projectId,
            sessionId,
            reactionKey,
            prNumber: session.pr.number,
            mergeMethod,
            error,
          });
          const message = error instanceof Error ? error.message : String(error);
          const event = createEvent("reaction.triggered", {
            sessionId,
            projectId,
            message: `Auto-merge failed for PR #${session.pr.number}. Manual intervention required.`,
            data: {
              reactionKey,
              prNumber: session.pr.number,
              prUrl: session.pr.url,
              mergeMethod,
              error: message,
            },
          });
          await notifyHuman(event, "urgent", pollStats);
          return {
            reactionType: reactionKey,
            success: false,
            action: "auto-merge",
            message,
            escalated: true,
          };
        }
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
    pollStats?: LifecyclePollStats,
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
        lastPrStatusPollAt: "",
        lastPrCiStatus: "",
      });
      return;
    }

    const [pendingResult, automatedResult] = await Promise.allSettled([
      scm.getPendingComments(session.pr),
      scm.getAutomatedComments(session.pr),
    ]);

    // null means "failed to fetch" — preserve existing metadata.
    // [] means "confirmed no comments" — safe to clear.
    if (pendingResult.status === "rejected") {
      incrementPollError(pollStats);
      logLifecycle("error", "review.pending_comments.failed", {
        pollId: pollStats?.pollId,
        projectId: session.projectId,
        sessionId: session.id,
        pr: session.pr,
        error: pendingResult.reason,
      });
    }
    if (automatedResult.status === "rejected") {
      incrementPollError(pollStats);
      logLifecycle("error", "review.automated_comments.failed", {
        pollId: pollStats?.pollId,
        projectId: session.projectId,
        sessionId: session.id,
        pr: session.pr,
        error: automatedResult.reason,
      });
    }

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
            pollStats,
            session,
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
            pollStats,
            session,
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
  async function notifyHuman(
    event: OrchestratorEvent,
    priority: EventPriority,
    pollStats?: LifecyclePollStats,
  ): Promise<void> {
    const eventWithPriority = { ...event, priority };
    const notifierNames = config.notificationRouting[priority] ?? config.defaults.notifiers;

    if (notifierNames.length === 0) {
      logLifecycle("info", "notification.skipped", {
        pollId: pollStats?.pollId,
        projectId: event.projectId,
        sessionId: event.sessionId,
        priority,
        eventType: event.type,
        reason: "no_notifiers_configured",
      });
      return;
    }

    for (const name of notifierNames) {
      const notifier = registry.get<Notifier>("notifier", name);
      if (!notifier) {
        incrementPollError(pollStats);
        if (pollStats) {
          pollStats.notificationFailures += 1;
        }
        logLifecycle("error", "notification.missing_notifier", {
          pollId: pollStats?.pollId,
          projectId: event.projectId,
          sessionId: event.sessionId,
          notifier: name,
          priority,
          eventType: event.type,
        });
        continue;
      }

      try {
        await notifier.notify(eventWithPriority);
        if (pollStats) {
          pollStats.notificationsSent += 1;
        }
        logLifecycle("info", "notification.sent", {
          pollId: pollStats?.pollId,
          projectId: event.projectId,
          sessionId: event.sessionId,
          notifier: name,
          priority,
          eventType: event.type,
        });
      } catch (error) {
        incrementPollError(pollStats);
        if (pollStats) {
          pollStats.notificationFailures += 1;
        }
        logLifecycle("error", "notification.failed", {
          pollId: pollStats?.pollId,
          projectId: event.projectId,
          sessionId: event.sessionId,
          notifier: name,
          priority,
          eventType: event.type,
          error,
        });
      }
    }
  }

  /** Poll a single session and handle state transitions. */
  async function checkSession(session: Session, pollStats?: LifecyclePollStats): Promise<void> {
    // Use tracked state if available; otherwise use the persisted metadata status
    // (not session.status, which list() may have already overwritten for dead runtimes).
    // This ensures transitions are detected after a lifecycle manager restart.
    const tracked = states.get(session.id);
    const oldStatus =
      tracked ?? ((session.metadata?.["status"] as SessionStatus | undefined) || session.status);
    let newStatus = await determineStatus(session, oldStatus, pollStats);
    let transitionReaction: { key: string; result: ReactionResult | null } | undefined;

    if (newStatus !== oldStatus) {
      if (pollStats) {
        pollStats.transitions += 1;
      }

      const eventType = statusToEventType(oldStatus, newStatus);
      const reactionKey = eventType ? eventToReactionKey(eventType) : null;
      logLifecycle("info", "session.transition", {
        pollId: pollStats?.pollId,
        projectId: session.projectId,
        sessionId: session.id,
        oldStatus,
        newStatus,
        eventType,
        reactionKey,
      });

      // State transition detected
      states.set(session.id, newStatus);
      updateSessionMetadata(session, { status: newStatus });

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
      if (eventType) {
        let reactionHandledNotify = false;

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
                pollStats,
                session,
              );
              transitionReaction = { key: reactionKey, result: reactionResult };

              if (
                reactionResult.resultingStatus &&
                reactionResult.resultingStatus !== newStatus
              ) {
                const finalStatus = reactionResult.resultingStatus;
                const finalEventType = statusToEventType(newStatus, finalStatus);
                const finalReactionKey = finalEventType ? eventToReactionKey(finalEventType) : null;

                if (pollStats) {
                  pollStats.transitions += 1;
                }

                logLifecycle("info", "session.transition", {
                  pollId: pollStats?.pollId,
                  projectId: session.projectId,
                  sessionId: session.id,
                  oldStatus: newStatus,
                  newStatus: finalStatus,
                  eventType: finalEventType,
                  reactionKey: finalReactionKey,
                  triggeredBy: reactionKey,
                });

                newStatus = finalStatus;
                states.set(session.id, finalStatus);
                updateSessionMetadata(session, { status: finalStatus });
              }

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
          await notifyHuman(event, priority, pollStats);
        }
      }
    } else {
      // No transition but track current state
      states.set(session.id, newStatus);
    }

    await maybeDispatchReviewBacklog(session, oldStatus, newStatus, transitionReaction, pollStats);

    if (newStatus === oldStatus) {
      await maybeRefirePersistentReaction(session, newStatus, pollStats);
    }
  }

  /** Run one polling cycle across all sessions. */
  async function pollAll(): Promise<void> {
    // Re-entrancy guard: skip if previous poll is still running
    if (polling) {
      logLifecycle("info", "poll.skipped", {
        projectId: scopedProjectId ?? "all",
        reason: "previous_poll_still_running",
      });
      return;
    }
    polling = true;
    const pollStats = createPollStats();

    logLifecycle("info", "poll.start", {
      pollId: pollStats.pollId,
      projectId: scopedProjectId ?? "all",
    });

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

      const activeSessions = sessions.filter((s) => s.status !== "merged" && s.status !== "killed");
      pollStats.totalSessions = sessions.length;
      pollStats.checkedSessions = sessionsToCheck.length;
      pollStats.activeSessions = activeSessions.length;

      logLifecycle("info", "poll.sessions_loaded", {
        pollId: pollStats.pollId,
        projectId: scopedProjectId ?? "all",
        totalSessions: pollStats.totalSessions,
        checkedSessions: pollStats.checkedSessions,
        activeSessions: pollStats.activeSessions,
      });

      // Poll all sessions concurrently
      const results = await Promise.allSettled(
        sessionsToCheck.map((s) => checkSession(s, pollStats)),
      );
      for (const [index, result] of results.entries()) {
        if (result.status === "rejected") {
          incrementPollError(pollStats);
          logLifecycle("error", "poll.session_failed", {
            pollId: pollStats.pollId,
            projectId: sessionsToCheck[index]?.projectId,
            sessionId: sessionsToCheck[index]?.id,
            error: result.reason,
          });
        }
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
      if (sessions.length > 0 && activeSessions.length === 0 && !allCompleteEmitted) {
        allCompleteEmitted = true;

        // Execute all-complete reaction if configured
        const reactionKey = eventToReactionKey("summary.all_complete");
        if (reactionKey) {
          const reactionConfig = config.reactions[reactionKey];
          if (reactionConfig && reactionConfig.action) {
            if (reactionConfig.auto !== false || reactionConfig.action === "notify") {
              await executeReaction(
                "system",
                "all",
                reactionKey,
                reactionConfig as ReactionConfig,
                pollStats,
              );
            }
          }
        }
      }
    } catch (err) {
      incrementPollError(pollStats);
      logLifecycle("error", "poll.failed", {
        pollId: pollStats.pollId,
        projectId: scopedProjectId ?? "all",
        error: err,
      });
    } finally {
      logLifecycle("info", "poll.end", {
        pollId: pollStats.pollId,
        projectId: scopedProjectId ?? "all",
        totalSessions: pollStats.totalSessions,
        checkedSessions: pollStats.checkedSessions,
        activeSessions: pollStats.activeSessions,
        transitions: pollStats.transitions,
        errors: pollStats.errors,
        notificationsSent: pollStats.notificationsSent,
        notificationFailures: pollStats.notificationFailures,
        durationMs: Date.now() - pollStats.startedAtMs,
      });
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
