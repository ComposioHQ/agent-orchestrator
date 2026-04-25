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
  ACTIVITY_STATE,
  SESSION_STATUS,
  TERMINAL_STATUSES,
  type LifecycleManager,
  type OpenCodeSessionManager,
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
  type CanonicalSessionLifecycle,
  type EventPriority,
  type ProjectConfig as _ProjectConfig,
  type PREnrichmentData,
  type CICheck,
  type ReviewComment,
  type ReviewSummary,
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

function prStateToEventType(
  from: Session["lifecycle"]["pr"]["state"],
  to: Session["lifecycle"]["pr"]["state"],
): EventType | null {
  if (from === to) return null;
  switch (to) {
    case "closed":
      return "pr.closed";
    default:
      return null;
  }
}

/** Map event type to reaction config key. */
function eventToReactionKey(eventType: EventType): string | null {
  switch (eventType) {
    case "pr.closed":
      return "pr-closed";
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

function splitEvidenceSignals(evidence: string): string[] {
  return evidence
    .split(/\s+/)
    .map((signal) => signal.trim())
    .filter((signal) => signal.length > 0);
}

function primaryLifecycleReason(lifecycle: CanonicalSessionLifecycle): string {
  if (lifecycle.session.state === "detecting") return lifecycle.session.reason;
  if (lifecycle.pr.reason !== "not_created" && lifecycle.pr.reason !== "in_progress") {
    return lifecycle.pr.reason;
  }
  if (lifecycle.runtime.reason !== "process_running") {
    return lifecycle.runtime.reason;
  }
  return lifecycle.session.reason;
}

function buildTransitionObservabilityData(
  previous: CanonicalSessionLifecycle,
  next: CanonicalSessionLifecycle,
  oldStatus: SessionStatus,
  newStatus: SessionStatus,
  evidence: string,
  detectingAttempts: number,
  statusTransition: boolean,
  reaction?: { key: string; result: ReactionResult | null },
): Record<string, unknown> {
  return {
    oldStatus,
    newStatus,
    statusTransition,
    previousSessionState: previous.session.state,
    newSessionState: next.session.state,
    previousSessionReason: previous.session.reason,
    newSessionReason: next.session.reason,
    previousPRState: previous.pr.state,
    newPRState: next.pr.state,
    previousPRReason: previous.pr.reason,
    newPRReason: next.pr.reason,
    previousRuntimeState: previous.runtime.state,
    newRuntimeState: next.runtime.state,
    previousRuntimeReason: previous.runtime.reason,
    newRuntimeReason: next.runtime.reason,
    primaryReason: primaryLifecycleReason(next),
    evidence,
    signalsConsulted: splitEvidenceSignals(evidence),
    detectingAttempts,
    recoveryAction: reaction?.result?.action ?? null,
    reactionKey: reaction?.key ?? null,
    reactionSuccess: reaction?.result?.success ?? null,
    escalated: reaction?.result?.escalated ?? null,
  };
}

export interface LifecycleManagerDeps {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  sessionManager: OpenCodeSessionManager;
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

  /**
   * Cache for PR enrichment data within a single poll cycle.
   * Cleared at the start of each pollAll() call.
   * Key format: "${owner}/${repo}#${number}"
   */
  const prEnrichmentCache = new Map<string, PREnrichmentData>();

  /** Repos where Guard 1 returned 304 in the current poll — safe to skip detectPR. */
  let prListUnchangedRepos = new Set<string>();

  /**
   * Per-session timestamp of last review backlog API check.
   * Used to throttle review thread checks to at most once per 2 minutes.
   * In-memory only — resets on restart (acceptable since it's a rate-limit hint, not state).
   */
  const lastReviewBacklogCheckAt = new Map<SessionId, number>();

  /** Throttle interval for review backlog API calls (2 minutes). */
  const REVIEW_BACKLOG_THROTTLE_MS = 2 * 60 * 1000;

  /**
   * Populate the PR enrichment cache using batch GraphQL queries.
   * This is called once per poll cycle to fetch data for all PRs efficiently.
   */
  async function populatePREnrichmentCache(sessions: Session[]): Promise<void> {
    // Clear previous cache
    prEnrichmentCache.clear();
    prListUnchangedRepos = new Set();

    // Collect all unique PRs and repos keyed by their owning session's project/plugin.
    // Repos are collected from ALL sessions (not just ones with PRs) so Guard 1 runs
    // for every active repo — enabling detectPR gating even when no PRs exist yet.
    const prsByPlugin = new Map<string, Array<NonNullable<Session["pr"]>>>();
    const reposByPlugin = new Map<string, Set<string>>();
    const seenPRKeys = new Set<string>();
    for (const session of sessions) {
      const project = config.projects[session.projectId];
      if (!project?.scm?.plugin || !project.repo) continue;

      const pluginKey = project.scm.plugin;
      if (!prsByPlugin.has(pluginKey)) {
        prsByPlugin.set(pluginKey, []);
      }
      if (!reposByPlugin.has(pluginKey)) {
        reposByPlugin.set(pluginKey, new Set());
      }
      reposByPlugin.get(pluginKey)!.add(project.repo);

      if (!session.pr) continue;

      const prKey = `${session.pr.owner}/${session.pr.repo}#${session.pr.number}`;
      if (seenPRKeys.has(prKey)) continue;
      seenPRKeys.add(prKey);

      const pluginPRs = prsByPlugin.get(pluginKey);
      if (pluginPRs) {
        pluginPRs.push(session.pr);
      }
    }

    // Fetch enrichment data and run Guard 1 for all active repos
    for (const [pluginKey, pluginPRs] of prsByPlugin) {
      const scm = registry.get<SCM>("scm", pluginKey);
      if (!scm?.enrichSessionsPRBatch) continue;

      const pluginRepos = [...(reposByPlugin.get(pluginKey) ?? [])];
      const batchStartTime = Date.now();
      try {
        const enrichmentData = await scm.enrichSessionsPRBatch(
          pluginPRs,
          {
            recordSuccess(_data) {
              const batchDuration = Date.now() - batchStartTime;
              observer?.recordOperation({
                metric: "graphql_batch",
                operation: "batch_enrichment",
                correlationId: createCorrelationId("graphql-batch"),
                outcome: "success",
                projectId: scopedProjectId,
                durationMs: batchDuration,
                data: {
                  plugin: pluginKey,
                  prCount: pluginPRs.length,
                  prKeys: pluginPRs.map((pr) => `${pr.owner}/${pr.repo}#${pr.number}`),
                },
                level: "info",
              });
            },
            recordFailure(data) {
              const batchDuration = Date.now() - batchStartTime;
              observer?.recordOperation({
                metric: "graphql_batch",
                operation: "batch_enrichment",
                correlationId: createCorrelationId("graphql-batch"),
                outcome: "failure",
                reason: data.error,
                level: "warn",
                data: {
                  plugin: pluginKey,
                  prCount: pluginPRs.length,
                  error: data.error,
                  durationMs: batchDuration,
                },
              });
            },
            log(level, message) {
              observer?.recordDiagnostic?.({
                operation: "batch_enrichment.log",
                correlationId: createCorrelationId("graphql-batch"),
                projectId: scopedProjectId,
                message,
                level,
                data: {
                  plugin: pluginKey,
                  source: "ao-graphql-batch",
                },
              });
            },
            reportPRListUnchangedRepos(repos) {
              for (const repo of repos) {
                prListUnchangedRepos.add(repo);
              }
            },
          },
          pluginRepos,
        );

        // Merge into cache
        for (const [key, data] of enrichmentData) {
          prEnrichmentCache.set(key, data);
        }
      } catch (err) {
        // Batch fetch failed - individual calls will still work
        const errorMsg = err instanceof Error ? err.message : String(err);
        const batchCorrelationId = createCorrelationId("batch-enrichment");
        observer?.recordOperation?.({
          metric: "lifecycle_poll",
          operation: "batch_enrichment",
          correlationId: batchCorrelationId,
          outcome: "failure",
          reason: errorMsg,
          level: "warn",
          data: { plugin: pluginKey, prCount: pluginPRs.length },
        });
      }
    }

    // Discover PRs for sessions that don't have one yet.
    // Only run detectPR when Guard 1 returned 200 (repo's PR list changed).
    // When Guard 1 returned 304, the repo is in prListUnchangedRepos — no new PRs exist.
    for (const session of sessions) {
      if (session.pr) continue;
      if (!session.branch) continue;
      if (session.metadata["prAutoDetect"] === "off") continue;
      if (session.metadata["role"] === "orchestrator" || session.id.endsWith("-orchestrator")) continue;

      const project = config.projects[session.projectId];
      if (!project?.repo || !project.scm?.plugin) continue;

      // Skip if Guard 1 confirmed no PR list changes for this repo
      if (prListUnchangedRepos.has(project.repo)) continue;

      const scm = registry.get<SCM>("scm", project.scm.plugin);
      if (!scm?.detectPR) continue;

      try {
        const detectedPR = await scm.detectPR(session, project);
        if (detectedPR) {
          session.pr = detectedPR;
          const sessionsDir = getSessionsDir(project.storageKey);
          updateMetadata(sessionsDir, session.id, { pr: detectedPR.url });
        }
      } catch (error) {
        observer?.recordOperation?.({
          metric: "lifecycle_poll",
          operation: "scm.detect_pr",
          outcome: "failure",
          correlationId: createCorrelationId("detect-pr"),
          projectId: session.projectId,
          sessionId: session.id,
          reason: error instanceof Error ? error.message : String(error),
          level: "warn",
        });
      }
    }
  }

  /**
   * Persist batch enrichment data to session metadata files.
   * The web dashboard reads this instead of calling GitHub API.
   */
  function persistPREnrichmentToMetadata(sessions: Session[]): void {
    for (const session of sessions) {
      if (!session.pr) continue;
      const project = config.projects[session.projectId];
      if (!project) continue;

      const prKey = `${session.pr.owner}/${session.pr.repo}#${session.pr.number}`;
      const cached = prEnrichmentCache.get(prKey);
      if (!cached) continue;

      const blob = JSON.stringify({
        state: cached.state,
        ciStatus: cached.ciStatus,
        reviewDecision: cached.reviewDecision,
        mergeable: cached.mergeable,
        title: cached.title,
        additions: cached.additions,
        deletions: cached.deletions,
        isDraft: cached.isDraft,
        hasConflicts: cached.hasConflicts,
        isBehind: cached.isBehind,
        blockers: cached.blockers,
        ciChecks: cached.ciChecks?.map((c) => ({
          name: c.name,
          status: c.status,
          url: c.url,
        })),
        enrichedAt: new Date().toISOString(),
      });

      if (session.metadata["prEnrichment"] === blob) continue;

      const sessionsDir = getSessionsDir(project.storageKey);
      updateMetadata(sessionsDir, session.id, { prEnrichment: blob });
      session.metadata["prEnrichment"] = blob;
    }
  }

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

    // detectPR is handled in populatePREnrichmentCache (gated by Guard 1 ETag).
    // By this point, session.pr is already set if a PR was discovered.

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

        // Batch enrichment cache miss — fall back to getPRState for terminal
        // states (merged/closed) only. Detecting these promptly prevents
        // delayed cleanup. Non-terminal state updates wait for the next batch
        // cycle (30s) to avoid ~110 individual REST calls per 15-min window.
        try {
          const prState = await scm.getPRState(session.pr);
          if (prState === "merged" || prState === "closed") {
            return commit(
              resolvePRLiveDecision({
                prState,
                ciStatus: "none",
                reviewDecision: "none",
                mergeable: false,
                shouldEscalateIdleToStuck,
                idleWasBlocked,
                activityEvidence,
              }),
            );
          }
        } catch {
          // Best-effort — batch will retry next cycle
        }
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

    const scm = project.scm?.plugin ? registry.get<SCM>("scm", project.scm.plugin) : null;
    if (!scm) return;

    const humanReactionKey = "changes-requested";
    const automatedReactionKey = "bugbot-comments";

    if (TERMINAL_STATUSES.has(newStatus) || session.lifecycle.pr.state !== "open") {
      clearReactionTracker(session.id, humanReactionKey);
      clearReactionTracker(session.id, automatedReactionKey);
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
    // (getReviewThreads) consumes API quota on every poll.
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

    // Single GraphQL call for all review threads (human + bot) + review summaries.
    // Split locally by isBot for separate reaction pipelines.
    let allThreads: ReviewComment[] | null = null;
    let reviewSummaries: ReviewSummary[] = [];
    try {
      if (scm.getReviewThreads) {
        const result = await scm.getReviewThreads(session.pr);
        allThreads = result.threads;
        reviewSummaries = result.reviews;
      } else {
        // Fallback for SCM plugins that don't implement getReviewThreads yet
        allThreads = await scm.getPendingComments(session.pr);
      }
    } catch {
      // Failed to fetch — preserve existing metadata
    }

    // Persist review comments + summaries to metadata for dashboard consumption
    if (allThreads !== null) {
      const unresolved = allThreads.filter((c) => !c.isBot);
      const reviewBlob = JSON.stringify({
        unresolvedThreads: unresolved.length,
        unresolvedComments: unresolved.map((c) => ({
          url: c.url,
          path: c.path ?? "",
          author: c.author,
          body: c.body,
        })),
        reviews: reviewSummaries.map((r) => ({
          author: r.author,
          state: r.state,
          body: r.body,
        })),
        commentsUpdatedAt: new Date().toISOString(),
      });
      if (session.metadata["prReviewComments"] !== reviewBlob) {
        updateSessionMetadata(session, { prReviewComments: reviewBlob });
      }
    }

    const pendingComments = allThreads
      ? allThreads.filter((c) => !c.isBot)
      : null;
    const automatedComments = allThreads
      ? allThreads.filter((c) => c.isBot)
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
          const enrichedConfig = {
            ...reactionConfig,
            message: formatReviewCommentsMessage(pendingComments, "reviewer", reviewSummaries),
          };
          const result = await executeReaction(
            session.id,
            session.projectId,
            humanReactionKey,
            enrichedConfig,
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
          const enrichedConfig = {
            ...reactionConfig,
            message: formatReviewCommentsMessage(automatedComments, "bot"),
          };
          const result = await executeReaction(
            session.id,
            session.projectId,
            automatedReactionKey,
            enrichedConfig,
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
   * Format review comments into a message with inline data for the agent.
   * Includes file, line, author, body, and URL so the agent doesn't need
   * to re-fetch via gh api.
   */
  function formatReviewCommentsMessage(
    comments: ReviewComment[],
    source: "reviewer" | "bot",
    reviews: ReviewSummary[] = [],
  ): string {
    const lines: string[] = [];

    // Prepend review summaries (the body submitted with "Changes requested" / "Approve")
    const nonEmptyReviews = reviews.filter((r) => r.body && r.body.trim().length > 0);
    if (nonEmptyReviews.length > 0) {
      for (const r of nonEmptyReviews) {
        lines.push(`Review by @${r.author} (${r.state}):`);
        lines.push(`"${r.body.trim()}"`, "");
      }
    }

    const header =
      source === "reviewer"
        ? `The following ${comments.length} unresolved review comment(s) are on your PR (as of just now). You should not need to re-fetch this data unless you need additional context.`
        : `The following ${comments.length} automated review comment(s) are on your PR (as of just now). You should not need to re-fetch this data unless you need additional context.`;
    lines.push(header, "");
    for (let i = 0; i < comments.length; i++) {
      const c = comments[i];
      const location = c.path ? `${c.path}${c.line ? `:${c.line}` : ""}` : "(general)";
      lines.push(`${i + 1}. ${location} (@${c.author}): "${c.body}"`);
      if (c.url) lines.push(`   ${c.url}`);
      if (c.threadId) lines.push(`   Thread ID: ${c.threadId}`);
    }
    lines.push("", "Address each comment, push fixes. Use the thread ID to resolve each thread directly after pushing. You should not need to re-fetch review data unless you need additional context beyond what is provided here.");
    return lines.join("\n");
  }

  /**
   * Format CI check failures into a human-readable message for the agent.
   * Includes check names, statuses, and links for debugging.
   */
  function formatCIFailureMessage(failedChecks: CICheck[]): string {
    const lines = [
      "CI checks are failing on your PR. Here are the failed checks:",
      "",
    ];
    for (const check of failedChecks) {
      const status = check.conclusion ?? check.status;
      const link = check.url ? ` — ${check.url}` : "";
      lines.push(`- **${check.name}**: ${status}${link}`);
    }
    lines.push(
      "",
      "Investigate the failures, fix the issues, and push again.",
    );
    return lines.join("\n");
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
      clearReactionTracker(session.id, conflictReactionKey);
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

    if (!cachedData) {
      // No batch data — skip this cycle, batch will populate on next cycle (30s)
      return;
    }
    const hasConflicts = cachedData.hasConflicts ?? false;

    const lastDispatched = session.metadata["lastMergeConflictDispatched"] ?? "";

    if (hasConflicts) {
      // Already dispatched for current conflict state — skip
      if (lastDispatched === "true") return;

      const reactionConfig = getReactionConfigForSession(session, conflictReactionKey);
      if (
        reactionConfig &&
        reactionConfig.action &&
        (reactionConfig.auto !== false || reactionConfig.action === "notify")
      ) {
        try {
          if (reactionConfig.action === "send-to-agent") {
            const baseBranch = session.pr.baseBranch ?? "the default branch";
            const behindNote = cachedData.isBehind ? ` is behind ${baseBranch} and` : "";
            const message =
              reactionConfig.message ??
              `Your PR branch${behindNote} has merge conflicts with ${baseBranch}. Rebase your branch on ${baseBranch}, resolve the conflicts, and push. You should not need to call gh for merge status unless you need additional context — this information is current.`;
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
      clearReactionTracker(session.id, conflictReactionKey);
      updateSessionMetadata(session, {
        lastMergeConflictDispatched: "",
      });
    }
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
          clearReactionTracker(session.id, oldReactionKey);
        }
      }

      // Handle transition: notify humans and/or trigger reactions
      const eventType = statusToEventType(oldStatus, newStatus);
      if (eventType) {
        let reactionHandledNotify = false;
        const reactionKey = eventToReactionKey(eventType);

        if (reactionKey) {
          let reactionConfig = getReactionConfigForSession(session, reactionKey);

          // Enrich CI failure message with actual check details from batch cache
          if (reactionKey === "ci-failed" && session.pr && reactionConfig) {
            const prKey = `${session.pr.owner}/${session.pr.repo}#${session.pr.number}`;
            const cachedData = prEnrichmentCache.get(prKey);
            if (cachedData?.ciChecks) {
              const failedChecks = cachedData.ciChecks.filter((c) => c.status === "failed");
              if (failedChecks.length > 0) {
                reactionConfig = { ...reactionConfig, message: formatCIFailureMessage(failedChecks) };
              }
            }
          }

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
        const reactionConfig = getReactionConfigForSession(session, reactionKey);
        if (reactionConfig && reactionConfig.action) {
          if (reactionConfig.auto !== false || reactionConfig.action === "notify") {
            await executeReaction(session.id, session.projectId, reactionKey, reactionConfig);
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
      maybeDispatchReviewBacklog(session, oldStatus, newStatus, transitionReaction),
      maybeDispatchMergeConflicts(session, newStatus),
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
    const reactionConfig = getReactionConfigForSession(session, reactionKey);

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
      await executeReaction(session.id, session.projectId, reactionKey, reactionConfig);
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
      await populatePREnrichmentCache(sessionsToCheck);

      // Poll all sessions concurrently
      await Promise.allSettled(sessionsToCheck.map((s) => checkSession(s)));

      // Persist batch enrichment data to session metadata files so the
      // web dashboard can read it without calling GitHub API.
      persistPREnrichmentToMetadata(sessionsToCheck);

      // Prune stale entries from states, reactionTrackers, and lastReviewBacklogCheckAt
      // for sessions that no longer appear in the session list (e.g., after kill/cleanup)
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
      for (const sessionId of lastReviewBacklogCheckAt.keys()) {
        if (!currentSessionIds.has(sessionId)) {
          lastReviewBacklogCheckAt.delete(sessionId);
        }
      }

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
      // Populate batch enrichment cache for this session's PR so
      // checkSession can read from cache (no individual REST fallback).
      await populatePREnrichmentCache([session]);
      await checkSession(session);
    },
  };
}
