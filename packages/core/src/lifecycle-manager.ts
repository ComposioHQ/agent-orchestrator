/**
 * Lifecycle Manager — polling loop + state machine + event dispatch.
 *
 * Periodically polls all sessions and:
 * 1. Detects state transitions (spawning → working → pr_open → etc.)
 * 2. Emits events on transitions
 * 3. Delegates reactions, PR enrichment caching, and backlog dispatch to
 *    focused modules (reaction-engine, pr-enrichment-cache, lifecycle-backlog).
 *
 * Reference: scripts/claude-session-status, scripts/claude-review-check
 */

import {
  SESSION_STATUS,
  ACTIVITY_STATE,
  PR_STATE,
  CI_STATUS,
  TERMINAL_STATUSES,
  type LifecycleManager,
  type OpenCodeSessionManager,
  type SessionId,
  type SessionStatus,
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
import { buildLifecycleMetadataPatch, cloneLifecycle, deriveLegacyStatus } from "./lifecycle-state.js";
import { updateMetadata } from "./metadata.js";
import { getSessionsDir } from "./paths.js";
import { applyDecisionToLifecycle as commitLifecycleDecisionInPlace } from "./lifecycle-transition.js";
import {
  classifyActivitySignal,
  createActivitySignal,
  formatActivitySignalEvidence,
  hasPositiveIdleEvidence,
  isWeakActivityEvidence,
} from "./activity-signal.js";
import {
  isAgentReportFresh,
  mapAgentReportToLifecycle,
  readAgentReport,
} from "./agent-report.js";
import {
  auditAgentReports,
  getReactionKeyForTrigger,
  REPORT_WATCHER_METADATA_KEYS,
} from "./report-watcher.js";
import { createCorrelationId, createProjectObserver } from "./observability.js";
import { resolveNotifierTarget } from "./notifier-resolution.js";
import { resolveAgentSelection, resolveSessionRole } from "./agent-selection.js";
import {
  DETECTING_MAX_ATTEMPTS,
  createDetectingDecision,
  isDetectingTimedOut,
  parseAttemptCount,
  resolvePREnrichmentDecision,
  resolvePRLiveDecision,
  resolveProbeDecision,
  type LifecycleDecision,
} from "./lifecycle-status-decisions.js";
import {
  buildTransitionObservabilityData,
  createEvent,
  eventToReactionKey,
  inferPriority,
  parseDuration,
  prStateToEventType,
  primaryLifecycleReason,
  statusToEventType,
  transitionLogLevel,
} from "./lifecycle-events.js";
import { createPREnrichmentCache } from "./pr-enrichment-cache.js";
import { createReactionEngine } from "./reaction-engine.js";
import { createBacklogDispatchers } from "./lifecycle-backlog.js";

interface DeterminedStatus {
  status: SessionStatus;
  evidence: string;
  detectingAttempts: number;
  /** ISO timestamp when detecting first started. */
  detectingStartedAt?: string;
  /** Hash of evidence for unchanged-evidence detection. */
  detectingEvidenceHash?: string;
}

interface ProbeResult {
  state: "alive" | "dead" | "unknown";
  failed: boolean;
}

export interface LifecycleManagerDeps {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  sessionManager: OpenCodeSessionManager;
  /** When set, only poll sessions belonging to this project. */
  projectId?: string;
}

/** Create a LifecycleManager instance. */
export function createLifecycleManager(deps: LifecycleManagerDeps): LifecycleManager {
  const { config, registry, sessionManager, projectId: scopedProjectId } = deps;
  const observer = createProjectObserver(config, "lifecycle-manager");

  const states = new Map<SessionId, SessionStatus>();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let polling = false; // re-entrancy guard
  let allCompleteEmitted = false; // guard against repeated all_complete

  const prEnrichmentCache = createPREnrichmentCache({
    config,
    registry,
    observer,
    scopedProjectId,
  });

  const reactionEngine = createReactionEngine({
    config,
    sessionManager,
    notifyHuman,
  });

  const backlog = createBacklogDispatchers({
    config,
    registry,
    sessionManager,
    reactionEngine,
    prEnrichmentCache,
    updateSessionMetadata,
    notifyHuman,
  });

  /** Check if idle time exceeds the agent-stuck threshold. */
  function isIdleBeyondThreshold(session: Session, idleTimestamp: Date): boolean {
    const stuckReaction = reactionEngine.getReactionConfigForSession(session, "agent-stuck");
    const thresholdStr = stuckReaction?.threshold;
    if (typeof thresholdStr !== "string") return false;
    const stuckThresholdMs = parseDuration(thresholdStr);
    if (stuckThresholdMs <= 0) return false;
    const idleMs = Date.now() - idleTimestamp.getTime();
    return idleMs > stuckThresholdMs;
  }

  /** Determine current status for a session by polling plugins. */
  async function determineStatus(session: Session): Promise<DeterminedStatus> {
    const project = config.projects[session.projectId];
    if (!project) {
      return {
        status: session.status,
        evidence: "project_missing",
        detectingAttempts: parseAttemptCount(session.metadata["detectingAttempts"]),
      };
    }

    const lifecycle = cloneLifecycle(session.lifecycle);
    const nowIso = new Date().toISOString();
    const agentName = resolveAgentSelection({
      role: resolveSessionRole(
        session.id,
        session.metadata,
        project.sessionPrefix,
        Object.values(config.projects).map((p) => p.sessionPrefix),
      ),
      project,
      defaults: config.defaults,
      persistedAgent: session.metadata["agent"],
    }).agentName;
    const agent = registry.get<Agent>("agent", agentName);
    const scm = project.scm?.plugin ? registry.get<SCM>("scm", project.scm.plugin) : null;

    let detectedIdleTimestamp: Date | null = null;
    let idleWasBlocked = false;
    const canProbeRuntimeIdentity = session.status !== SESSION_STATUS.SPAWNING;
    const currentDetectingAttempts = parseAttemptCount(session.metadata["detectingAttempts"]);
    const currentDetectingStartedAt = session.metadata["detectingStartedAt"] || undefined;
    const currentDetectingEvidenceHash = session.metadata["detectingEvidenceHash"] || undefined;

    const commit = (
      decision: LifecycleDecision = {
        status: deriveLegacyStatus(lifecycle, session.status),
        evidence: "lifecycle_commit",
        detectingAttempts: currentDetectingAttempts,
      },
    ): DeterminedStatus => {
      commitLifecycleDecisionInPlace(lifecycle, decision, nowIso);
      session.lifecycle = lifecycle;
      session.status = decision.status;
      session.activitySignal = activitySignal;
      return {
        status: decision.status,
        evidence: decision.evidence,
        detectingAttempts: decision.detectingAttempts,
        detectingStartedAt: decision.detectingStartedAt,
        detectingEvidenceHash: decision.detectingEvidenceHash,
      };
    };

    let runtimeProbe: ProbeResult = { state: "unknown", failed: false };
    if (session.runtimeHandle && canProbeRuntimeIdentity) {
      const runtime = registry.get<Runtime>("runtime", project.runtime ?? config.defaults.runtime);
      if (runtime) {
        try {
          const alive = await runtime.isAlive(session.runtimeHandle);
          lifecycle.runtime.lastObservedAt = nowIso;
          runtimeProbe = { state: alive ? "alive" : "dead", failed: false };
          if (alive) {
            lifecycle.runtime.state = "alive";
            lifecycle.runtime.reason = "process_running";
          } else {
            lifecycle.runtime.state = "missing";
            lifecycle.runtime.reason =
              session.runtimeHandle.runtimeName === "tmux" ? "tmux_missing" : "process_missing";
          }
        } catch {
          lifecycle.runtime.state = "probe_failed";
          lifecycle.runtime.reason = "probe_error";
          lifecycle.runtime.lastObservedAt = nowIso;
          runtimeProbe = { state: "unknown", failed: true };
        }
      }
    }

    let activitySignal = createActivitySignal("unavailable");
    let processProbe: ProbeResult = { state: "unknown", failed: false };
    let activityEvidence = formatActivitySignalEvidence(activitySignal);

    if (agent && (session.runtimeHandle || session.workspacePath)) {
      try {
        if (
          agent.recordActivity &&
          session.workspacePath &&
          session.runtimeHandle &&
          canProbeRuntimeIdentity
        ) {
          try {
            const runtime = registry.get<Runtime>("runtime", project.runtime ?? config.defaults.runtime);
            const terminalOutput = runtime ? await runtime.getOutput(session.runtimeHandle, 10) : "";
            if (terminalOutput) {
              await agent.recordActivity(session, terminalOutput);
            }
          } catch (error) {
            observer?.recordOperation?.({
              metric: "lifecycle_poll",
              operation: "activity.record",
              outcome: "failure",
              correlationId: createCorrelationId("lifecycle-poll"),
              projectId: session.projectId,
              sessionId: session.id,
              reason: error instanceof Error ? error.message : String(error),
              level: "warn",
            });
          }
        }

        const detectedActivity = await agent.getActivityState(session, config.readyThresholdMs);
        if (detectedActivity) {
          activitySignal = classifyActivitySignal(detectedActivity, "native");
          activityEvidence = formatActivitySignalEvidence(activitySignal);
          lifecycle.runtime.lastObservedAt = nowIso;
          if (lifecycle.runtime.state !== "missing" && lifecycle.runtime.state !== "probe_failed") {
            lifecycle.runtime.state = "alive";
            lifecycle.runtime.reason = "process_running";
          }
          if (detectedActivity.state === "waiting_input") {
            return commit({
              status: SESSION_STATUS.NEEDS_INPUT,
              evidence: activityEvidence,
              detectingAttempts: 0,
              sessionState: "needs_input",
              sessionReason: "awaiting_user_input",
            });
          }
          if (detectedActivity.state === "exited" && canProbeRuntimeIdentity) {
            processProbe = { state: "dead", failed: false };
            lifecycle.runtime.state = "exited";
            lifecycle.runtime.reason = "process_missing";
          }

          if (hasPositiveIdleEvidence(activitySignal)) {
            detectedIdleTimestamp = activitySignal.timestamp;
            idleWasBlocked = activitySignal.activity === "blocked";
          }
        } else if (session.runtimeHandle && canProbeRuntimeIdentity) {
          activitySignal = createActivitySignal("null", { source: "native" });
          activityEvidence = formatActivitySignalEvidence(activitySignal);
          const runtime = registry.get<Runtime>("runtime", project.runtime ?? config.defaults.runtime);
          const terminalOutput = runtime ? await runtime.getOutput(session.runtimeHandle, 10) : "";
          if (terminalOutput) {
            const activity = agent.detectActivity(terminalOutput);
            activitySignal = classifyActivitySignal({ state: activity }, "terminal");
            activityEvidence = formatActivitySignalEvidence(activitySignal);
            if (activity === "waiting_input") {
              return commit({
                status: SESSION_STATUS.NEEDS_INPUT,
                evidence: activityEvidence,
                detectingAttempts: 0,
                sessionState: "needs_input",
                sessionReason: "awaiting_user_input",
              });
            }

            try {
              const processAlive = await agent.isProcessRunning(session.runtimeHandle);
              processProbe = { state: processAlive ? "alive" : "dead", failed: false };
              if (!processAlive) {
                lifecycle.runtime.state = "exited";
                lifecycle.runtime.reason = "process_missing";
                lifecycle.runtime.lastObservedAt = nowIso;
              }
            } catch {
              processProbe = { state: "unknown", failed: true };
            }
          }
        } else {
          activitySignal = createActivitySignal("null", { source: "native" });
          activityEvidence = formatActivitySignalEvidence(activitySignal);
        }
      } catch {
        activitySignal = createActivitySignal("probe_failure", { source: "native" });
        activityEvidence = formatActivitySignalEvidence(activitySignal);
        if (
          lifecycle.session.state === "stuck" ||
          lifecycle.session.state === "needs_input" ||
          lifecycle.session.state === "detecting"
        ) {
          return commit({
            status: session.status,
            evidence: activityEvidence,
            detectingAttempts: currentDetectingAttempts,
          });
        }
        return commit(
          createDetectingDecision({
            currentAttempts: currentDetectingAttempts,
            idleWasBlocked,
            evidence: activityEvidence,
            detectingStartedAt: currentDetectingStartedAt,
            previousEvidenceHash: currentDetectingEvidenceHash,
          }),
        );
      }
    }

    if (
      processProbe.state === "unknown" &&
      session.runtimeHandle &&
      canProbeRuntimeIdentity &&
      agent
    ) {
      try {
        const processAlive = await agent.isProcessRunning(session.runtimeHandle);
        processProbe = { state: processAlive ? "alive" : "dead", failed: false };
        if (!processAlive) {
          lifecycle.runtime.state = "exited";
          lifecycle.runtime.reason = "process_missing";
          lifecycle.runtime.lastObservedAt = nowIso;
        }
      } catch {
        processProbe = { state: "unknown", failed: true };
      }
    }

    const probeDecision = resolveProbeDecision({
      currentAttempts: currentDetectingAttempts,
      runtimeProbe,
      processProbe,
      canProbeRuntimeIdentity,
      activitySignal,
      activityEvidence,
      idleWasBlocked,
      detectingStartedAt: currentDetectingStartedAt,
      previousEvidenceHash: currentDetectingEvidenceHash,
    });
    if (probeDecision) {
      return commit(probeDecision);
    }

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
          lifecycle.pr.state = "open";
          lifecycle.pr.reason = "in_progress";
          lifecycle.pr.number = detectedPR.number;
          lifecycle.pr.url = detectedPR.url;
          lifecycle.pr.lastObservedAt = nowIso;
          const sessionsDir = getSessionsDir(project.storageKey);
          updateMetadata(sessionsDir, session.id, { pr: detectedPR.url });
        }
      } catch (error) {
        observer?.recordOperation?.({
          metric: "lifecycle_poll",
          operation: "scm.detect_pr",
          outcome: "failure",
          correlationId: createCorrelationId("lifecycle-poll"),
          projectId: session.projectId,
          sessionId: session.id,
          reason: error instanceof Error ? error.message : String(error),
          level: "warn",
        });
      }
    }

    if (session.pr && scm) {
      try {
        const prKey = `${session.pr.owner}/${session.pr.repo}#${session.pr.number}`;
        const cachedData = prEnrichmentCache.get(prKey);
        lifecycle.pr.number = session.pr.number;
        lifecycle.pr.url = session.pr.url;
        lifecycle.pr.lastObservedAt = nowIso;
        const shouldEscalateIdleToStuck =
          detectedIdleTimestamp !== null && hasPositiveIdleEvidence(activitySignal)
            ? isIdleBeyondThreshold(session, detectedIdleTimestamp)
            : false;

        if (cachedData) {
          return commit(
            resolvePREnrichmentDecision(cachedData, {
              shouldEscalateIdleToStuck,
              idleWasBlocked,
              activityEvidence,
            }),
          );
        }
        const prState = await scm.getPRState(session.pr);
        if (prState === PR_STATE.MERGED || prState === PR_STATE.CLOSED) {
          return commit(
            resolvePRLiveDecision({
              prState,
              ciStatus: CI_STATUS.NONE,
              reviewDecision: "none",
              mergeable: false,
              shouldEscalateIdleToStuck,
              idleWasBlocked,
              activityEvidence,
            }),
          );
        }

        const ciStatus = await scm.getCISummary(session.pr);
        if (ciStatus === CI_STATUS.FAILING) {
          return commit(
            resolvePRLiveDecision({
              prState,
              ciStatus,
              reviewDecision: "none",
              mergeable: false,
              shouldEscalateIdleToStuck,
              idleWasBlocked,
              activityEvidence,
            }),
          );
        }

        const reviewDecision = await scm.getReviewDecision(session.pr);
        const mergeReady =
          reviewDecision === "approved" || reviewDecision === "none"
            ? await scm.getMergeability(session.pr)
            : { mergeable: false };
        return commit(
          resolvePRLiveDecision({
            prState,
            ciStatus,
            reviewDecision,
            mergeable: mergeReady.mergeable,
            shouldEscalateIdleToStuck,
            idleWasBlocked,
            activityEvidence,
          }),
        );
      } catch (error) {
        observer?.recordOperation?.({
          metric: "lifecycle_poll",
          operation: "scm.poll_pr",
          outcome: "failure",
          correlationId: createCorrelationId("lifecycle-poll"),
          projectId: session.projectId,
          sessionId: session.id,
          reason: error instanceof Error ? error.message : String(error),
          level: "warn",
        });
      }
    }

    // Fresh agent reports outrank weak inference (idle-beyond-threshold /
    // default-to-working) but runtime death, activity waiting_input, and SCM
    // ground truth already short-circuited above. Orchestrator sessions and
    // terminal states are skipped intentionally — `lifecycle.session.kind` is
    // the authoritative source (string-matching role/id suffixes misses
    // numbered orchestrator IDs like `${prefix}-orchestrator-1`).
    const agentReport = readAgentReport(session.metadata);
    if (
      agentReport &&
      isAgentReportFresh(agentReport) &&
      lifecycle.session.kind !== "orchestrator" &&
      lifecycle.session.state !== "terminated" &&
      lifecycle.session.state !== "done"
    ) {
      const mapped = mapAgentReportToLifecycle(agentReport.state);
      return commit({
        status: deriveLegacyStatus(
          {
            ...lifecycle,
            session: {
              ...lifecycle.session,
              state: mapped.sessionState,
              reason: mapped.sessionReason,
            },
          },
          session.status,
        ),
        evidence: `agent_report:${agentReport.state}`,
        detectingAttempts: 0,
        sessionState: mapped.sessionState,
        sessionReason: mapped.sessionReason,
      });
    }

    if (
      detectedIdleTimestamp &&
      hasPositiveIdleEvidence(activitySignal) &&
      isIdleBeyondThreshold(session, detectedIdleTimestamp)
    ) {
      return commit({
        status: SESSION_STATUS.STUCK,
        evidence: `idle_beyond_threshold ${activityEvidence}`,
        detectingAttempts: 0,
        sessionState: "stuck",
        sessionReason: idleWasBlocked ? "error_in_process" : "probe_failure",
      });
    }

    if (
      isWeakActivityEvidence(activitySignal) &&
      (session.status === SESSION_STATUS.DETECTING ||
        session.status === SESSION_STATUS.STUCK ||
        session.status === SESSION_STATUS.NEEDS_INPUT ||
        lifecycle.session.state === "detecting" ||
        lifecycle.session.state === "stuck" ||
        lifecycle.session.state === "needs_input")
    ) {
      const preservingProbeFailureStuck =
        activitySignal.state === "unavailable" &&
        lifecycle.session.state === "stuck" &&
        lifecycle.session.reason === "probe_failure" &&
        runtimeProbe.state === "alive" &&
        !runtimeProbe.failed;

      if (preservingProbeFailureStuck) {
        return commit({
          status: SESSION_STATUS.DETECTING,
          evidence: activityEvidence,
          detectingAttempts: 0,
          sessionState: "detecting",
          sessionReason: "probe_failure",
        });
      }

      return commit({
        status: deriveLegacyStatus(lifecycle, session.status),
        evidence: activityEvidence,
        detectingAttempts: 0,
      });
    }

    if (
      session.status === SESSION_STATUS.SPAWNING ||
      session.status === SESSION_STATUS.DETECTING ||
      session.status === SESSION_STATUS.STUCK ||
      session.status === SESSION_STATUS.NEEDS_INPUT
    ) {
      return commit({
        status: SESSION_STATUS.WORKING,
        evidence: activityEvidence,
        detectingAttempts: 0,
        sessionState: "working",
        sessionReason: "task_in_progress",
      });
    }

    return commit({
      status: session.status,
      evidence: activityEvidence,
      detectingAttempts: 0,
    });
  }

  function updateSessionMetadata(
    session: Session,
    updates: Partial<Record<string, string>>,
  ): void {
    const project = config.projects[session.projectId];
    if (!project) return;

    const sessionsDir = getSessionsDir(project.storageKey);
    const lifecycleUpdates = buildLifecycleMetadataPatch(
      cloneLifecycle(session.lifecycle),
      session.status,
    );
    const mergedUpdates = { ...updates, ...lifecycleUpdates };
    updateMetadata(sessionsDir, session.id, mergedUpdates);
    sessionManager.invalidateCache();

    const cleaned = Object.fromEntries(
      Object.entries(session.metadata).filter(([key]) => {
        const update = mergedUpdates[key];
        return update === undefined || update !== "";
      }),
    );
    for (const [key, value] of Object.entries(mergedUpdates)) {
      if (value === undefined || value === "") continue;
      cleaned[key] = value;
    }
    session.metadata = cleaned;
    session.status = deriveLegacyStatus(session.lifecycle, session.status);
  }

  /** Send a notification to all configured notifiers. */
  async function notifyHuman(event: OrchestratorEvent, priority: EventPriority): Promise<void> {
    const eventWithPriority = { ...event, priority };
    const notifierNames = config.notificationRouting[priority] ?? config.defaults.notifiers;

    for (const name of notifierNames) {
      const target = resolveNotifierTarget(config, name);
      const notifier =
        registry.get<Notifier>("notifier", target.reference) ??
        registry.get<Notifier>("notifier", target.pluginName);
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
   * When a session's PR is merged, tear down its tmux runtime, remove its
   * worktree, and archive its metadata. Guarded by an idleness check so we
   * don't kill an agent mid-task; deferred cases set `mergedPendingCleanupSince`
   * in metadata and retry on subsequent polls until the agent idles or the
   * grace window elapses.
   */
  async function maybeAutoCleanupOnMerge(session: Session): Promise<void> {
    if (session.status !== SESSION_STATUS.MERGED) return;

    // config.lifecycle is typed optional to support hand-constructed
    // configs in tests. When loaded from YAML via Zod, the schema's
    // .default({}) always populates it. The destructure below handles
    // both paths uniformly.
    const { autoCleanupOnMerge = true, mergeCleanupIdleGraceMs: graceMs = 300_000 } =
      config.lifecycle ?? {};
    if (!autoCleanupOnMerge) return;

    // Check for idleness: if the agent is still working, defer cleanup.
    const nowIso = new Date().toISOString();
    const pendingSince = session.metadata["mergedPendingCleanupSince"] || nowIso;
    const pendingSinceMs = Date.parse(pendingSince);
    const graceElapsed = Number.isFinite(pendingSinceMs)
      ? Date.now() - pendingSinceMs >= graceMs
      : false;

    const activity = session.activity;
    const agentIsBusy =
      activity === ACTIVITY_STATE.ACTIVE ||
      activity === ACTIVITY_STATE.WAITING_INPUT ||
      activity === ACTIVITY_STATE.BLOCKED;

    if (agentIsBusy && !graceElapsed) {
      if (!session.metadata["mergedPendingCleanupSince"]) {
        updateSessionMetadata(session, { mergedPendingCleanupSince: nowIso });
      }
      observer.recordOperation({
        metric: "lifecycle_poll",
        operation: "lifecycle.merge_cleanup.deferred",
        outcome: "success",
        correlationId: createCorrelationId("lifecycle-merge-cleanup"),
        projectId: session.projectId,
        sessionId: session.id,
        reason: primaryLifecycleReason(session.lifecycle),
        data: { activity, pendingSince, graceMs },
        level: "info",
      });
      return;
    }

    const correlationId = createCorrelationId("lifecycle-merge-cleanup");
    try {
      const result = await sessionManager.kill(session.id, {
        purgeOpenCode: true,
        reason: "pr_merged",
      });
      observer.recordOperation({
        metric: "lifecycle_poll",
        operation: "lifecycle.merge_cleanup.completed",
        outcome: "success",
        correlationId,
        projectId: session.projectId,
        sessionId: session.id,
        reason: primaryLifecycleReason(session.lifecycle),
        data: {
          cleaned: result.cleaned,
          alreadyTerminated: result.alreadyTerminated,
          graceElapsed,
          activity,
        },
        level: "info",
      });
      states.delete(session.id);
    } catch (err) {
      // Leave `merged` status in place so the next poll retries. Preserve the
      // deferral marker so idempotent retries don't restart the grace clock.
      if (!session.metadata["mergedPendingCleanupSince"]) {
        updateSessionMetadata(session, { mergedPendingCleanupSince: nowIso });
      }
      observer.recordOperation({
        metric: "lifecycle_poll",
        operation: "lifecycle.merge_cleanup.failed",
        outcome: "failure",
        correlationId,
        projectId: session.projectId,
        sessionId: session.id,
        reason: err instanceof Error ? err.message : String(err),
        level: "warn",
      });
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
    const previousLifecycle = cloneLifecycle(session.lifecycle);
    const previousPRState = session.lifecycle.pr.state;
    const assessment = await determineStatus(session);
    const newStatus = assessment.status;
    const lifecycleChanged = session.metadata["statePayload"] !== JSON.stringify(session.lifecycle);
    let transitionReaction: { key: string; result: ReactionResult | null } | undefined;

    const nextLifecycleEvidence = assessment.evidence;
    const nextDetectingAttempts =
      assessment.detectingAttempts > 0 ? String(assessment.detectingAttempts) : "";
    const nextDetectingStartedAt = assessment.detectingStartedAt ?? "";
    const nextDetectingEvidenceHash = assessment.detectingEvidenceHash ?? "";
    // Escalation can happen via attempt limit OR time limit
    const isDetectingEscalated =
      newStatus === SESSION_STATUS.STUCK &&
      (assessment.detectingAttempts > DETECTING_MAX_ATTEMPTS ||
        isDetectingTimedOut(nextDetectingStartedAt));
    const nextDetectingEscalatedAt = isDetectingEscalated
      ? (session.metadata["detectingEscalatedAt"] || new Date().toISOString())
      : "";

    const metadataUpdates: Record<string, string> = {};
    if (session.metadata["lifecycleEvidence"] !== nextLifecycleEvidence) {
      metadataUpdates["lifecycleEvidence"] = nextLifecycleEvidence;
    }
    if ((session.metadata["detectingAttempts"] || "") !== nextDetectingAttempts) {
      metadataUpdates["detectingAttempts"] = nextDetectingAttempts;
    }
    if ((session.metadata["detectingStartedAt"] || "") !== nextDetectingStartedAt) {
      metadataUpdates["detectingStartedAt"] = nextDetectingStartedAt;
    }
    if ((session.metadata["detectingEvidenceHash"] || "") !== nextDetectingEvidenceHash) {
      metadataUpdates["detectingEvidenceHash"] = nextDetectingEvidenceHash;
    }
    if ((session.metadata["detectingEscalatedAt"] || "") !== nextDetectingEscalatedAt) {
      metadataUpdates["detectingEscalatedAt"] = nextDetectingEscalatedAt;
    }
    if (Object.keys(metadataUpdates).length > 0) {
      updateSessionMetadata(session, metadataUpdates);
    }

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
        reason: primaryLifecycleReason(session.lifecycle),
        data: buildTransitionObservabilityData(
          previousLifecycle,
          session.lifecycle,
          oldStatus,
          newStatus,
          assessment.evidence,
          assessment.detectingAttempts,
          true,
        ),
        level: transitionLogLevel(newStatus),
      });

      // Reset allCompleteEmitted when any session becomes active again
      if (!TERMINAL_STATUSES.has(newStatus)) {
        allCompleteEmitted = false;
      }

      // Clear reaction trackers for the old status so retries reset on state changes
      const oldEventType = statusToEventType(undefined, oldStatus);
      if (oldEventType) {
        const oldReactionKey = eventToReactionKey(oldEventType);
        if (oldReactionKey) {
          reactionEngine.clearTracker(session.id, oldReactionKey);
        }
      }

      // Handle transition: notify humans and/or trigger reactions
      const eventType = statusToEventType(oldStatus, newStatus);
      if (eventType) {
        let reactionHandledNotify = false;
        const reactionKey = eventToReactionKey(eventType);

        if (reactionKey) {
          const reactionConfig = reactionEngine.getReactionConfigForSession(session, reactionKey);

          if (reactionConfig && reactionConfig.action) {
            // auto: false skips automated agent actions but still allows notifications
            if (reactionConfig.auto !== false || reactionConfig.action === "notify") {
              const reactionResult = await reactionEngine.executeReaction(
                session.id,
                session.projectId,
                reactionKey,
                reactionConfig,
              );
              transitionReaction = { key: reactionKey, result: reactionResult };
              observer.recordOperation({
                metric: "lifecycle_poll",
                operation: "lifecycle.transition.reaction",
                outcome: reactionResult.success ? "success" : "failure",
                correlationId,
                projectId: session.projectId,
                sessionId: session.id,
                reason: primaryLifecycleReason(session.lifecycle),
                data: buildTransitionObservabilityData(
                  previousLifecycle,
                  session.lifecycle,
                  oldStatus,
                  newStatus,
                  assessment.evidence,
                  assessment.detectingAttempts,
                  true,
                  transitionReaction,
                ),
                level: reactionResult.success ? "info" : "warn",
              });
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
    } else {
      // No transition but track current state
      states.set(session.id, newStatus);
      if (lifecycleChanged) {
        updateSessionMetadata(session, { status: newStatus });
        observer.recordOperation({
          metric: "lifecycle_poll",
          operation: "lifecycle.sync",
          outcome: "success",
          correlationId: createCorrelationId("lifecycle-sync"),
          projectId: session.projectId,
          sessionId: session.id,
          reason: primaryLifecycleReason(session.lifecycle),
          data: buildTransitionObservabilityData(
            previousLifecycle,
            session.lifecycle,
            oldStatus,
            newStatus,
            assessment.evidence,
            assessment.detectingAttempts,
            false,
          ),
          level: transitionLogLevel(newStatus),
        });
      }
    }

    const prEventType = prStateToEventType(previousPRState, session.lifecycle.pr.state);
    if (prEventType) {
      let reactionHandledNotify = false;
      const reactionKey = eventToReactionKey(prEventType);

      if (reactionKey) {
        const reactionConfig = reactionEngine.getReactionConfigForSession(session, reactionKey);
        if (reactionConfig && reactionConfig.action) {
          if (reactionConfig.auto !== false || reactionConfig.action === "notify") {
            await reactionEngine.executeReaction(
              session.id,
              session.projectId,
              reactionKey,
              reactionConfig,
            );
            reactionHandledNotify = true;
          }
        }
      }

      if (!reactionHandledNotify) {
        const prEvent = createEvent(prEventType, {
          sessionId: session.id,
          projectId: session.projectId,
          message: `${session.id}: PR ${previousPRState} → ${session.lifecycle.pr.state}`,
          data: {
            oldPRState: previousPRState,
            newPRState: session.lifecycle.pr.state,
            prNumber: session.lifecycle.pr.number,
            prUrl: session.lifecycle.pr.url,
          },
        });
        await notifyHuman(prEvent, inferPriority(prEventType));
      }
    }

    // Pin first quality summary for title stability
    if (
      session.agentInfo?.summary &&
      !session.agentInfo.summaryIsFallback &&
      !session.metadata["pinnedSummary"]
    ) {
      const trimmed = session.agentInfo.summary.replace(/[\n\r]/g, " ").trim();
      if (trimmed.length >= 5) {
        try {
          updateSessionMetadata(session, { pinnedSummary: trimmed });
        } catch {
          // Non-critical: title just won't be pinned this cycle
        }
      }
    }

    await Promise.allSettled([
      backlog.maybeDispatchReviewBacklog(session, oldStatus, newStatus, transitionReaction),
      backlog.maybeDispatchCIFailureDetails(session, oldStatus, newStatus, transitionReaction),
      backlog.maybeDispatchMergeConflicts(session, newStatus),
    ]);

    // Report watcher: audit agent reports for issues (#140)
    await auditAndReactToReports(session);

    // PR-merge auto-cleanup: tear down runtime + worktree + archive metadata
    // once the agent is idle (or grace window elapses). Runs last so reactions
    // and notifications observe the live session before it is destroyed.
    await maybeAutoCleanupOnMerge(session);
  }

  /**
   * Audit agent reports and trigger reactions when issues are detected.
   * Called at the end of each checkSession cycle.
   */
  async function auditAndReactToReports(session: Session): Promise<void> {
    const auditResult = auditAgentReports(session);
    const now = new Date().toISOString();

    // If no trigger, clear any active trigger metadata
    if (!auditResult || !auditResult.trigger) {
      const hadActiveTrigger = session.metadata[REPORT_WATCHER_METADATA_KEYS.ACTIVE_TRIGGER];
      if (hadActiveTrigger) {
        updateSessionMetadata(session, {
          [REPORT_WATCHER_METADATA_KEYS.LAST_AUDITED_AT]: now,
          [REPORT_WATCHER_METADATA_KEYS.ACTIVE_TRIGGER]: "",
          [REPORT_WATCHER_METADATA_KEYS.TRIGGER_ACTIVATED_AT]: "",
          [REPORT_WATCHER_METADATA_KEYS.TRIGGER_COUNT]: "",
        });
      }
      return;
    }

    const reactionKey = getReactionKeyForTrigger(auditResult.trigger);
    const reactionConfig = reactionEngine.getReactionConfigForSession(session, reactionKey);

    // Update audit metadata
    const currentTriggerCount = parseInt(
      session.metadata[REPORT_WATCHER_METADATA_KEYS.TRIGGER_COUNT] ?? "0",
      10,
    );
    const isNewTrigger =
      session.metadata[REPORT_WATCHER_METADATA_KEYS.ACTIVE_TRIGGER] !== auditResult.trigger;

    updateSessionMetadata(session, {
      [REPORT_WATCHER_METADATA_KEYS.LAST_AUDITED_AT]: now,
      [REPORT_WATCHER_METADATA_KEYS.ACTIVE_TRIGGER]: auditResult.trigger,
      [REPORT_WATCHER_METADATA_KEYS.TRIGGER_ACTIVATED_AT]: isNewTrigger
        ? now
        : (session.metadata[REPORT_WATCHER_METADATA_KEYS.TRIGGER_ACTIVATED_AT] ?? now),
      [REPORT_WATCHER_METADATA_KEYS.TRIGGER_COUNT]: String(
        isNewTrigger ? 1 : currentTriggerCount + 1,
      ),
    });

    // Log the audit finding
    observer.recordOperation({
      metric: "lifecycle_poll",
      operation: "report_watcher.audit",
      outcome: "success",
      correlationId: createCorrelationId("report-watcher"),
      projectId: session.projectId,
      sessionId: session.id,
      reason: auditResult.trigger,
      data: {
        trigger: auditResult.trigger,
        message: auditResult.message,
        timeSinceSpawnMs: auditResult.timeSinceSpawnMs,
        timeSinceReportMs: auditResult.timeSinceReportMs,
        reportState: auditResult.report?.state,
      },
      level: "warn",
    });

    // Execute reaction if configured
    if (isNewTrigger && reactionConfig && reactionConfig.auto !== false) {
      await reactionEngine.executeReaction(session.id, session.projectId, reactionKey, reactionConfig);
    }
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
        if (!TERMINAL_STATUSES.has(s.status)) return true;
        const tracked = states.get(s.id);
        return tracked !== undefined && tracked !== s.status;
      });

      // Prime the per-poll PR enrichment cache before session checks so
      // downstream status/reaction logic can reuse batch GraphQL data.
      await prEnrichmentCache.populate(sessionsToCheck);

      // Poll all sessions concurrently
      await Promise.allSettled(sessionsToCheck.map((s) => checkSession(s)));

      // Prune stale entries from states, reactionTrackers, and the review-backlog throttle
      // for sessions that no longer appear in the session list (e.g., after kill/cleanup)
      const currentSessionIds = new Set(sessions.map((s) => s.id));
      for (const trackedId of states.keys()) {
        if (!currentSessionIds.has(trackedId)) {
          states.delete(trackedId);
        }
      }
      reactionEngine.pruneTrackers(currentSessionIds);
      backlog.pruneReviewBacklogThrottle(currentSessionIds);

      // Check if all sessions are complete (trigger reaction only once)
      const activeSessions = sessions.filter((s) => !TERMINAL_STATUSES.has(s.status));
      if (sessions.length > 0 && activeSessions.length === 0 && !allCompleteEmitted) {
        allCompleteEmitted = true;

        // Execute all-complete reaction if configured
        const reactionKey = eventToReactionKey("summary.all_complete");
        if (reactionKey) {
          const reactionConfig = config.reactions[reactionKey];
          if (reactionConfig && reactionConfig.action) {
            if (reactionConfig.auto !== false || reactionConfig.action === "notify") {
              await reactionEngine.executeReaction(
                "system",
                "all",
                reactionKey,
                reactionConfig as ReactionConfig,
              );
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
