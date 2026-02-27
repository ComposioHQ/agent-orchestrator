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
import { resolve as resolvePath } from "node:path";
import {
  SESSION_STATUS,
  TERMINAL_STATUSES,
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
  type Tracker,
  type SCM,
  type Workspace,
  type Notifier,
  type Session,
  type IssueUpdate,
  type EventPriority,
  type ProjectConfig as _ProjectConfig,
} from "./types.js";
import { updateMetadata } from "./metadata.js";
import { expandHome, getSessionsDir } from "./paths.js";

const VERIFY_STATUS_REQUIRED = "work_verify_pass_full";
const BROWSER_VERIFY_KEY = "verify_browser_status";
const BROWSER_VERIFY_PASS_VALUE = "work_verify_browser_pass";
const DEFAULT_QUEUE_PICKUP_INTERVAL_SEC = 60;
const DEFAULT_QUEUE_PICKUP_STATE = "Todo";
const DEFAULT_QUEUE_PICKUP_MAX_ACTIVE_SESSIONS = 8;
const DEFAULT_QUEUE_PICKUP_MAX_SPAWN_PER_CYCLE = 4;
const DEFAULT_MERGE_METHOD = "squash";
const DEFAULT_MERGE_RETRY_COOLDOWN_SEC = 300;
const DEFAULT_COMPLETION_EVIDENCE_PATTERN = "AC Evidence:|검증 근거:";
const CODEX_RATE_LIMIT_PROMPT_REGEX = /approaching rate limits/i;
const CODEX_RATE_LIMIT_OPTION_REGEX = /switch to gpt-[\w.-]+-codex-mini/i;
const CODEX_RATE_LIMIT_CONFIRM_REGEX = /press enter to confirm or esc to go back/i;
const CODEX_RATE_LIMIT_AUTODISMISS_KEY = "codex_rate_limit_prompt_autodismissed_at";
const CODEX_RATE_LIMIT_AUTODISMISS_CHOICE_KEY = "codex_rate_limit_prompt_autodismiss_choice";
const CODEX_RATE_LIMIT_AUTODISMISS_COOLDOWN_MS = 60_000;
const STUCK_RECOVERY_DETECTED_AT_KEY = "stuck_recovery_detected_at";
const STUCK_RECOVERY_LAST_SENT_AT_KEY = "stuck_recovery_last_sent_at";

interface MergeGateConfigResolved {
  enabled: boolean;
  method: "merge" | "squash" | "rebase";
  retryCooldownSec: number;
  strict: {
    requireVerifyMarker: boolean;
    requireBrowserMarker: boolean;
    requireApprovedReviewOrNoRequests: boolean;
    requireNoUnresolvedThreads: boolean;
    requirePassingChecks: boolean;
    requireCompletionDryRun: boolean;
  };
}

interface CompletionGateConfigResolved {
  enabled: boolean;
  evidencePattern: string;
  syncChecklistFromEvidence: boolean;
}

interface StuckRecoveryConfigResolved {
  enabled: boolean;
  pattern: string;
  thresholdSec: number;
  cooldownSec: number;
  message: string;
}

function getQueuePickupConfig(project: _ProjectConfig): {
  enabled: boolean;
  intervalSec: number;
  pickupStateName: string;
  transitionStateName?: string;
  requireAoMetaQueued: boolean;
  maxActiveSessions: number;
  maxSpawnPerCycle: number;
} {
  const queuePickup = project.automation?.queuePickup;
  return {
    enabled: queuePickup?.enabled ?? true,
    intervalSec: queuePickup?.intervalSec ?? DEFAULT_QUEUE_PICKUP_INTERVAL_SEC,
    pickupStateName: queuePickup?.pickupStateName ?? DEFAULT_QUEUE_PICKUP_STATE,
    transitionStateName: queuePickup?.transitionStateName,
    requireAoMetaQueued: queuePickup?.requireAoMetaQueued ?? true,
    maxActiveSessions: queuePickup?.maxActiveSessions ?? DEFAULT_QUEUE_PICKUP_MAX_ACTIVE_SESSIONS,
    maxSpawnPerCycle: queuePickup?.maxSpawnPerCycle ?? DEFAULT_QUEUE_PICKUP_MAX_SPAWN_PER_CYCLE,
  };
}

function getMergeGateConfig(project: _ProjectConfig): MergeGateConfigResolved {
  const mergeGate = project.automation?.mergeGate;
  return {
    enabled: mergeGate?.enabled ?? true,
    method: mergeGate?.method ?? DEFAULT_MERGE_METHOD,
    retryCooldownSec: mergeGate?.retryCooldownSec ?? DEFAULT_MERGE_RETRY_COOLDOWN_SEC,
    strict: {
      requireVerifyMarker: mergeGate?.strict?.requireVerifyMarker ?? true,
      requireBrowserMarker: mergeGate?.strict?.requireBrowserMarker ?? true,
      requireApprovedReviewOrNoRequests:
        mergeGate?.strict?.requireApprovedReviewOrNoRequests ?? true,
      requireNoUnresolvedThreads: mergeGate?.strict?.requireNoUnresolvedThreads ?? true,
      requirePassingChecks: mergeGate?.strict?.requirePassingChecks ?? true,
      requireCompletionDryRun: mergeGate?.strict?.requireCompletionDryRun ?? true,
    },
  };
}

function getCompletionGateConfig(project: _ProjectConfig): CompletionGateConfigResolved {
  const completionGate = project.automation?.completionGate;
  return {
    enabled: completionGate?.enabled ?? true,
    evidencePattern: completionGate?.evidencePattern ?? DEFAULT_COMPLETION_EVIDENCE_PATTERN,
    syncChecklistFromEvidence: completionGate?.syncChecklistFromEvidence ?? false,
  };
}

function getStuckRecoveryConfig(project: _ProjectConfig): StuckRecoveryConfigResolved {
  const stuckRecovery = project.automation?.stuckRecovery;
  return {
    enabled: stuckRecovery?.enabled ?? true,
    pattern: stuckRecovery?.pattern ?? "Write tests for @filename",
    thresholdSec: stuckRecovery?.thresholdSec ?? 600,
    cooldownSec: stuckRecovery?.cooldownSec ?? 300,
    message:
      stuckRecovery?.message ??
      "Infer the concrete target file from issue context and proceed without asking for @filename.",
  };
}

function getAutomationMode(project: _ProjectConfig): "standard" | "local-only" {
  return project.automation?.mode ?? "local-only";
}

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

/** Map event type to reaction config keys. */
function eventToReactionKeys(eventType: EventType): string[] {
  const keys: string[] = [];

  switch (eventType) {
    case "ci.failing":
      keys.push("ci-failed");
      break;
    case "review.changes_requested":
      keys.push("changes-requested");
      break;
    case "automated_review.found":
      keys.push("bugbot-comments");
      break;
    case "merge.conflicts":
      keys.push("merge-conflicts");
      break;
    case "merge.ready":
      keys.push("approved-and-green");
      break;
    case "session.stuck":
      keys.push("agent-stuck");
      break;
    case "session.needs_input":
      keys.push("agent-needs-input");
      break;
    case "session.killed":
      keys.push("agent-exited");
      break;
    case "merge.completed":
      keys.push("issue-completed");
      break;
    case "summary.all_complete":
      keys.push("all-complete");
      break;
  }

  switch (eventType) {
    case "pr.created":
      keys.push("issue-progress-pr-opened");
      break;
    case "review.pending":
    case "review.changes_requested":
    case "review.approved":
    case "merge.ready":
      keys.push("issue-progress-review-updated");
      break;
  }

  return keys;
}

function reactionKeyToProgressStage(reactionKey: string): "pr_opened" | "review_updated" | null {
  if (reactionKey === "issue-progress-pr-opened") return "pr_opened";
  if (reactionKey === "issue-progress-review-updated") return "review_updated";
  return null;
}

function summarizeProgressEvent(eventType?: EventType): string {
  switch (eventType) {
    case "pr.created":
      return "PR created";
    case "review.pending":
      return "review pending";
    case "review.changes_requested":
      return "changes requested";
    case "review.approved":
      return "review approved";
    case "merge.ready":
      return "ready to merge";
    default:
      return "status updated";
  }
}

function normalizeSingleLineText(input: string, maxLength = 240): string {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function extractProgressSection(terminalOutput: string, headings: string[]): string | null {
  if (!terminalOutput.trim()) return null;
  const lines = terminalOutput.split("\n");
  const headingSet = headings.map((heading) => heading.toLowerCase());
  const stopPattern =
    /^(개발 요약:|development summary:|개발 구현:|implementation(?: details)?:|검증:|verification:|원하시면|if you want|›|•|gpt-)/i;

  for (let i = lines.length - 1; i >= 0; i--) {
    const current = lines[i].trim();
    if (!current) continue;

    const lower = current.toLowerCase();
    if (!headingSet.some((heading) => lower.startsWith(heading))) continue;

    const collected: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = lines[j].trim();
      if (!candidate) {
        if (collected.length > 0) break;
        continue;
      }
      if (stopPattern.test(candidate)) break;
      collected.push(candidate.replace(/^[-*]\s+/, ""));
      if (collected.length >= 4) break;
    }

    const summary = normalizeSingleLineText(collected.join(" "));
    if (summary) return summary;
  }

  return null;
}

interface ChecklistSummary {
  total: number;
  checked: number;
  unchecked: number;
  updatedMarkdown: string;
}

/**
 * Analyze markdown task-list checkboxes across the whole document.
 * Ignores lines inside fenced code blocks (``` / ~~~).
 */
function summarizeChecklist(markdown: string): ChecklistSummary {
  const lines = markdown.split("\n");
  let inFence = false;
  let fenceChar: "`" | "~" | "" = "";
  let total = 0;
  let checked = 0;
  let unchecked = 0;

  const updatedLines = lines.map((line) => {
    const trimmed = line.trimStart();
    const fenceMatch = trimmed.match(/^(```+|~~~+)/);
    if (fenceMatch) {
      const nextFenceChar = fenceMatch[1].startsWith("`") ? "`" : "~";
      if (!inFence) {
        inFence = true;
        fenceChar = nextFenceChar;
      } else if (fenceChar === nextFenceChar) {
        inFence = false;
        fenceChar = "";
      }
      return line;
    }

    if (inFence) return line;

    const checkboxMatch = line.match(/^(\s*(?:[-*]|\d+\.)\s+\[)( |x|X)(\]\s*.*)$/);
    if (!checkboxMatch) return line;

    total++;
    const mark = checkboxMatch[2].toLowerCase();
    if (mark === "x") {
      checked++;
      return line;
    }

    unchecked++;
    return `${checkboxMatch[1]}x${checkboxMatch[3]}`;
  });

  return {
    total,
    checked,
    unchecked,
    updatedMarkdown: updatedLines.join("\n"),
  };
}

function hasQueuedAoMeta(description: string): boolean {
  if (!description) return false;
  const normalized = description.replace(/\r\n/g, "\n");
  return /AO_META[\s\S]{0,2000}?["']?pipeline["']?\s*[:=]\s*["']?queued["']?/i.test(
    normalized,
  );
}

function extractConflictingWorktreePath(message: string): string | null {
  const branchInUseMatch = message.match(/already used by worktree at '([^']+)'/i);
  if (branchInUseMatch?.[1]) return branchInUseMatch[1];

  const existingPathMatch = message.match(/fatal:\s*'([^']+)'\s+already exists/i);
  if (existingPathMatch?.[1]) return existingPathMatch[1];

  return null;
}

function buildEvidenceRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

interface CompletionGateEvaluation {
  ok: boolean;
  reason?: string;
  checklist: ChecklistSummary;
  evidenceMatched: boolean;
  canAutoSyncChecklist: boolean;
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

interface ReactionExecutionContext {
  eventType?: EventType;
  oldStatus?: SessionStatus;
  newStatus?: SessionStatus;
}

/** Create a LifecycleManager instance. */
export function createLifecycleManager(deps: LifecycleManagerDeps): LifecycleManager {
  const { config, registry, sessionManager } = deps;
  const queuePickupDebugEnabled =
    process.env["AO_QUEUE_PICKUP_LOG"] === "1" || process.env["AO_DEBUG"] === "1";

  const states = new Map<SessionId, SessionStatus>();
  const reactionTrackers = new Map<string, ReactionTracker>(); // "sessionId:reactionKey"
  const mergeRetryCooldownUntil = new Map<SessionId, number>();
  const queuePickupLastRunAt = new Map<string, number>();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let polling = false; // re-entrancy guard
  let allCompleteEmitted = false; // guard against repeated all_complete

  function isManagedWorktreePath(projectId: string, maybePath: string): boolean {
    if (!maybePath) return false;
    const worktreeRoot = resolvePath(expandHome("~/.worktrees"));
    const projectRoot = resolvePath(worktreeRoot, projectId);
    const targetPath = resolvePath(maybePath);
    return targetPath === projectRoot || targetPath.startsWith(`${projectRoot}/`);
  }

  function hasCodexRateLimitPrompt(terminalOutput: string): boolean {
    if (!terminalOutput.trim()) return false;
    const hasPrompt = CODEX_RATE_LIMIT_PROMPT_REGEX.test(terminalOutput);
    const hasChoice = CODEX_RATE_LIMIT_OPTION_REGEX.test(terminalOutput);
    const hasConfirm = CODEX_RATE_LIMIT_CONFIRM_REGEX.test(terminalOutput);
    return hasPrompt && (hasChoice || hasConfirm);
  }

  async function evaluateStuckRecovery(
    session: Session,
    project: _ProjectConfig,
    terminalOutput: string,
  ): Promise<boolean> {
    const stuckRecovery = getStuckRecoveryConfig(project);
    if (!stuckRecovery.enabled || !terminalOutput.trim()) return false;

    let patternRegex: RegExp;
    try {
      patternRegex = new RegExp(stuckRecovery.pattern, "i");
    } catch {
      return false;
    }

    const sessionsDir = getSessionsDir(config.configPath, project.path);
    const matches = patternRegex.test(terminalOutput);
    if (!matches) {
      if (session.metadata[STUCK_RECOVERY_DETECTED_AT_KEY]) {
        updateMetadata(sessionsDir, session.id, {
          [STUCK_RECOVERY_DETECTED_AT_KEY]: "",
        });
        session.metadata[STUCK_RECOVERY_DETECTED_AT_KEY] = "";
      }
      return false;
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const thresholdMs = Math.max(0, stuckRecovery.thresholdSec) * 1000;
    const cooldownMs = Math.max(0, stuckRecovery.cooldownSec) * 1000;

    const detectedAtIso = session.metadata[STUCK_RECOVERY_DETECTED_AT_KEY];
    const detectedAtMs = detectedAtIso ? Date.parse(detectedAtIso) : Number.NaN;
    if (!Number.isFinite(detectedAtMs)) {
      updateMetadata(sessionsDir, session.id, {
        [STUCK_RECOVERY_DETECTED_AT_KEY]: nowIso,
      });
      session.metadata[STUCK_RECOVERY_DETECTED_AT_KEY] = nowIso;
      return false;
    }

    if (now.getTime() - detectedAtMs < thresholdMs) return false;

    const lastSentIso = session.metadata[STUCK_RECOVERY_LAST_SENT_AT_KEY];
    const lastSentMs = lastSentIso ? Date.parse(lastSentIso) : Number.NaN;
    const cooldownActive =
      Number.isFinite(lastSentMs) && now.getTime() - lastSentMs < cooldownMs;
    if (!cooldownActive) {
      try {
        await sessionManager.send(session.id, stuckRecovery.message);
        updateMetadata(sessionsDir, session.id, {
          [STUCK_RECOVERY_LAST_SENT_AT_KEY]: nowIso,
        });
        session.metadata[STUCK_RECOVERY_LAST_SENT_AT_KEY] = nowIso;
      } catch {
        // Best effort — status still transitions to stuck below.
      }
    }

    return true;
  }

  async function tryAutoDismissCodexRateLimitPrompt(
    session: Session,
    project: _ProjectConfig,
    runtime: Runtime,
    terminalOutput: string,
  ): Promise<boolean> {
    if (!session.runtimeHandle) return false;
    if (!hasCodexRateLimitPrompt(terminalOutput)) return false;

    const lastAutoDismissIso = session.metadata[CODEX_RATE_LIMIT_AUTODISMISS_KEY];
    if (lastAutoDismissIso) {
      const lastAutoDismissMs = Date.parse(lastAutoDismissIso);
      if (
        Number.isFinite(lastAutoDismissMs) &&
        Date.now() - lastAutoDismissMs < CODEX_RATE_LIMIT_AUTODISMISS_COOLDOWN_MS
      ) {
        return false;
      }
    }

    try {
      // Choose "Keep current model (never show again)" so autonomous sessions
      // do not repeatedly block on this prompt.
      await runtime.sendMessage(session.runtimeHandle, "3\n");

      const nowIso = new Date().toISOString();
      const sessionsDir = getSessionsDir(config.configPath, project.path);
      updateMetadata(sessionsDir, session.id, {
        [CODEX_RATE_LIMIT_AUTODISMISS_KEY]: nowIso,
        [CODEX_RATE_LIMIT_AUTODISMISS_CHOICE_KEY]: "3",
      });
      session.metadata[CODEX_RATE_LIMIT_AUTODISMISS_KEY] = nowIso;
      session.metadata[CODEX_RATE_LIMIT_AUTODISMISS_CHOICE_KEY] = "3";
      return true;
    } catch {
      return false;
    }
  }

  async function tryRecoverQueueSpawnConflict(
    projectId: string,
    project: _ProjectConfig,
    sessions: Session[],
    spawnError: unknown,
  ): Promise<boolean> {
    const message = spawnError instanceof Error ? spawnError.message : String(spawnError);
    const conflictPathRaw = extractConflictingWorktreePath(message);
    if (!conflictPathRaw) return false;
    const conflictPath = resolvePath(conflictPathRaw);

    // Safety guard: only auto-clean AO-managed worktrees.
    if (!isManagedWorktreePath(projectId, conflictPath)) return false;

    const conflictSession = sessions.find(
      (session) =>
        session.projectId === projectId &&
        session.workspacePath &&
        resolvePath(session.workspacePath) === conflictPath,
    );

    // If the conflicting worktree belongs to a known non-terminal session,
    // do not auto-clean it.
    if (conflictSession && !TERMINAL_STATUSES.has(conflictSession.status)) {
      return false;
    }

    if (conflictSession) {
      try {
        await sessionManager.kill(conflictSession.id);
        const idx = sessions.findIndex((s) => s.id === conflictSession.id);
        if (idx >= 0) sessions.splice(idx, 1);
        return true;
      } catch {
        return false;
      }
    }

    // No session metadata matched this worktree path (stale orphan path).
    // Best-effort remove it only for the managed worktree plugin.
    const workspacePlugin = registry.get<Workspace>(
      "workspace",
      project.workspace ?? config.defaults.workspace,
    );
    if (!workspacePlugin || workspacePlugin.name !== "worktree") return false;

    try {
      await workspacePlugin.destroy(conflictPath);
      return true;
    } catch {
      return false;
    }
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
          const shouldMarkStuck = await evaluateStuckRecovery(session, project, terminalOutput);
          if (shouldMarkStuck) return "stuck";

          const autoDismissedCodexRateLimitPrompt =
            runtime && agent.name === "codex"
              ? await tryAutoDismissCodexRateLimitPrompt(session, project, runtime, terminalOutput)
              : false;

          const activity = agent.detectActivity(terminalOutput);
          if (activity === "waiting_input" && !autoDismissedCodexRateLimitPrompt) {
            return "needs_input";
          }

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
          if (mergeReady.mergeable) return "mergeable";
          return "approved";
        }
        if (reviewDecision === "pending") return "review_pending";

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

  async function evaluateCompletionGate(
    session: Session,
    project: _ProjectConfig,
    tracker: Tracker,
    completionGateConfig: CompletionGateConfigResolved,
  ): Promise<CompletionGateEvaluation> {
    const issue = await tracker.getIssue(session.issueId ?? "", project);
    const checklist = summarizeChecklist(issue.description ?? "");

    if (checklist.total === 0) {
      return {
        ok: false,
        reason: "no_checklist",
        checklist,
        evidenceMatched: false,
        canAutoSyncChecklist: false,
      };
    }

    const evidenceRegex = buildEvidenceRegex(completionGateConfig.evidencePattern);
    if (!evidenceRegex) {
      return {
        ok: false,
        reason: "invalid_evidence_pattern",
        checklist,
        evidenceMatched: false,
        canAutoSyncChecklist: false,
      };
    }

    const evidenceSources: string[] = [issue.description ?? ""];
    if (tracker.listComments) {
      try {
        const comments = await tracker.listComments(session.issueId ?? "", project);
        for (const comment of comments) {
          evidenceSources.push(comment.body ?? "");
        }
      } catch {
        // Best effort — if comment retrieval fails, gate falls back to description only.
      }
    }

    const evidenceMatched = evidenceSources.some((text) => evidenceRegex.test(text));
    if (!evidenceMatched) {
      return {
        ok: false,
        reason: "missing_evidence",
        checklist,
        evidenceMatched: false,
        canAutoSyncChecklist: false,
      };
    }

    if (checklist.unchecked > 0) {
      const canAutoSyncChecklist = completionGateConfig.syncChecklistFromEvidence;
      if (!canAutoSyncChecklist) {
        return {
          ok: false,
          reason: "checklist_incomplete",
          checklist,
          evidenceMatched: true,
          canAutoSyncChecklist: false,
        };
      }
      return {
        ok: true,
        checklist,
        evidenceMatched: true,
        canAutoSyncChecklist: true,
      };
    }

    return {
      ok: true,
      checklist,
      evidenceMatched: true,
      canAutoSyncChecklist: false,
    };
  }

  async function runQueuePickup(sessions: Session[]): Promise<void> {
    for (const [projectId, project] of Object.entries(config.projects)) {
      const queuePickup = getQueuePickupConfig(project);
      if (!queuePickup.enabled) continue;

      const intervalMs = Math.max(1, queuePickup.intervalSec) * 1000;
      const lastRun = queuePickupLastRunAt.get(projectId) ?? 0;
      if (Date.now() - lastRun < intervalMs) continue;
      queuePickupLastRunAt.set(projectId, Date.now());

      const trackerPlugin = project.tracker?.plugin;
      if (!trackerPlugin) {
        if (queuePickupDebugEnabled) {
          console.log(
            `[lifecycle][queue-pickup] ${projectId} skipped: tracker is not configured`,
          );
        }
        continue;
      }
      const tracker = registry.get<Tracker>("tracker", trackerPlugin);
      if (!tracker?.listIssues) {
        if (queuePickupDebugEnabled) {
          console.log(
            `[lifecycle][queue-pickup] ${projectId} skipped: tracker plugin "${trackerPlugin}" does not support listIssues`,
          );
        }
        continue;
      }

      let issues;
      try {
        issues = await tracker.listIssues(
          {
            state: "open",
            workflowStateName: queuePickup.pickupStateName,
            limit: 100,
          },
          project,
        );
      } catch (err) {
        if (queuePickupDebugEnabled) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[lifecycle][queue-pickup] ${projectId} listIssues failed: ${msg}`);
        }
        continue;
      }

      const activeIssueIds = new Set(
        sessions
          .filter((session) => session.projectId === projectId && session.issueId)
          .filter((session) => !TERMINAL_STATUSES.has(session.status))
          .map((session) => (session.issueId ?? "").toLowerCase()),
      );
      let activeIssueSessionCount = sessions.filter(
        (session) =>
          session.projectId === projectId &&
          session.issueId &&
          !TERMINAL_STATUSES.has(session.status),
      ).length;
      let spawnedThisCycle = 0;
      let skippedDuplicate = 0;
      let skippedMissingAoMeta = 0;
      let skippedSpawnLimit = 0;
      let skippedActiveLimit = 0;
      let skippedMissingIssueId = 0;
      const missingAoMetaIssueIds: string[] = [];
      const duplicateIssueIds: string[] = [];

      for (const issue of issues) {
        if (spawnedThisCycle >= queuePickup.maxSpawnPerCycle) {
          skippedSpawnLimit += 1;
          break;
        }
        if (activeIssueSessionCount >= queuePickup.maxActiveSessions) {
          skippedActiveLimit += 1;
          break;
        }

        const issueId = issue.id?.trim();
        if (!issueId) {
          skippedMissingIssueId += 1;
          continue;
        }

        if (activeIssueIds.has(issueId.toLowerCase())) {
          skippedDuplicate += 1;
          if (duplicateIssueIds.length < 3) duplicateIssueIds.push(issueId);
          continue;
        }
        if (queuePickup.requireAoMetaQueued && !hasQueuedAoMeta(issue.description ?? "")) {
          skippedMissingAoMeta += 1;
          if (missingAoMetaIssueIds.length < 3) missingAoMetaIssueIds.push(issueId);
          continue;
        }

        try {
          const spawned = await sessionManager.spawn({ projectId, issueId });
          if (queuePickup.transitionStateName && tracker.updateIssue) {
            try {
              await tracker.updateIssue(
                issueId,
                {
                  state: "in_progress",
                  workflowStateName: queuePickup.transitionStateName,
                },
                project,
              );
            } catch (transitionErr) {
              const msg =
                transitionErr instanceof Error ? transitionErr.message : String(transitionErr);
              console.warn(
                `[lifecycle][queue-pickup] transition failed for ${projectId}:${issueId}: ${msg}`,
              );
            }
          }
          activeIssueIds.add(issueId.toLowerCase());
          activeIssueSessionCount += 1;
          spawnedThisCycle += 1;
          sessions.push(spawned);
        } catch (spawnErr) {
          const recovered = await tryRecoverQueueSpawnConflict(
            projectId,
            project,
            sessions,
            spawnErr,
          );
          if (!recovered) {
            // Keep queue loop resilient but make failures visible for debugging.
            const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
            console.warn(
              `[lifecycle][queue-pickup] spawn failed for ${projectId}:${issueId}: ${msg}`,
            );
            continue;
          }

          // Retry once after recovery.
          try {
            const spawned = await sessionManager.spawn({ projectId, issueId });
            if (queuePickup.transitionStateName && tracker.updateIssue) {
              try {
                await tracker.updateIssue(
                  issueId,
                  {
                    state: "in_progress",
                    workflowStateName: queuePickup.transitionStateName,
                  },
                  project,
                );
              } catch (transitionErr) {
                const msg =
                  transitionErr instanceof Error ? transitionErr.message : String(transitionErr);
                console.warn(
                  `[lifecycle][queue-pickup] transition failed for ${projectId}:${issueId}: ${msg}`,
                );
              }
            }
            activeIssueIds.add(issueId.toLowerCase());
            activeIssueSessionCount += 1;
            spawnedThisCycle += 1;
            sessions.push(spawned);
          } catch (retryErr) {
            const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            console.warn(
              `[lifecycle][queue-pickup] spawn retry failed for ${projectId}:${issueId}: ${msg}`,
            );
          }
        }
      }

      if (queuePickupDebugEnabled) {
        const details: string[] = [];
        if (duplicateIssueIds.length > 0) {
          details.push(`duplicates=[${duplicateIssueIds.join(",")}]`);
        }
        if (missingAoMetaIssueIds.length > 0) {
          details.push(`missingAoMeta=[${missingAoMetaIssueIds.join(",")}]`);
        }
        console.log(
          `[lifecycle][queue-pickup] ${projectId} ` +
            `state=${queuePickup.pickupStateName} listed=${issues.length} spawned=${spawnedThisCycle} ` +
            `active=${activeIssueSessionCount}/${queuePickup.maxActiveSessions} ` +
            `skipDuplicate=${skippedDuplicate} skipMissingAoMeta=${skippedMissingAoMeta} ` +
            `skipMissingIssueId=${skippedMissingIssueId} stopSpawnLimit=${skippedSpawnLimit} stopActiveLimit=${skippedActiveLimit}` +
            (details.length > 0 ? ` ${details.join(" ")}` : ""),
        );
      }
    }
  }

  /** Execute a reaction for a session. */
  async function executeReaction(
    sessionId: SessionId,
    projectId: string,
    reactionKey: string,
    reactionConfig: ReactionConfig,
    context?: ReactionExecutionContext,
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
        const project = config.projects[projectId];
        if (!project) {
          return {
            reactionType: reactionKey,
            success: false,
            action,
            message: `Project '${projectId}' not found`,
            escalated: false,
          };
        }

        const mergeGate = getMergeGateConfig(project);
        if (!mergeGate.enabled) {
          return {
            reactionType: reactionKey,
            success: true,
            action,
            message: "merge gate disabled",
            escalated: false,
          };
        }

        const session = await sessionManager.get(sessionId).catch(() => null);
        if (!session?.pr) {
          return {
            reactionType: reactionKey,
            success: false,
            action,
            message: "No PR bound to this session",
            escalated: false,
          };
        }

        const scmPlugin = project.scm?.plugin;
        if (!scmPlugin) {
          return {
            reactionType: reactionKey,
            success: false,
            action,
            message: "SCM plugin not configured",
            escalated: false,
          };
        }
        const scm = registry.get<SCM>("scm", scmPlugin);
        if (!scm) {
          return {
            reactionType: reactionKey,
            success: false,
            action,
            message: `SCM plugin '${scmPlugin}' not loaded`,
            escalated: false,
          };
        }

        const cooldownUntil = mergeRetryCooldownUntil.get(sessionId) ?? 0;
        if (Date.now() < cooldownUntil) {
          return {
            reactionType: reactionKey,
            success: false,
            action,
            message: "merge retry cooldown active",
            escalated: false,
          };
        }

        const blockers: string[] = [];

        if (
          mergeGate.strict.requireVerifyMarker &&
          session.metadata["verify_status"] !== VERIFY_STATUS_REQUIRED
        ) {
          blockers.push(
            `verify_status must be '${VERIFY_STATUS_REQUIRED}' (current: '${session.metadata["verify_status"] ?? "missing"}')`,
          );
        }
        if (
          mergeGate.strict.requireBrowserMarker &&
          session.metadata[BROWSER_VERIFY_KEY] !== BROWSER_VERIFY_PASS_VALUE
        ) {
          blockers.push(
            `${BROWSER_VERIFY_KEY} must be '${BROWSER_VERIFY_PASS_VALUE}' (current: '${session.metadata[BROWSER_VERIFY_KEY] ?? "missing"}')`,
          );
        }

        if (mergeGate.strict.requireApprovedReviewOrNoRequests) {
          try {
            const reviewDecision = await scm.getReviewDecision(session.pr);
            if (reviewDecision !== "approved") {
              if (reviewDecision === "none") {
                if (!scm.getReviewRequestsCount) {
                  blockers.push(
                    "SCM plugin does not support review request counting for strict merge gate",
                  );
                } else {
                  const requestCount = await scm.getReviewRequestsCount(session.pr);
                  if (requestCount > 0) {
                    blockers.push(`review requests pending (${requestCount})`);
                  }
                }
              } else {
                blockers.push(`review decision is '${reviewDecision}'`);
              }
            }
          } catch {
            blockers.push("failed to evaluate review decision");
          }
        }

        if (mergeGate.strict.requireNoUnresolvedThreads) {
          try {
            const unresolved = await scm.getPendingComments(session.pr);
            if (unresolved.length > 0) {
              blockers.push(`unresolved review threads (${unresolved.length})`);
            }
          } catch {
            blockers.push("failed to evaluate unresolved review threads");
          }
        }

        if (mergeGate.strict.requirePassingChecks) {
          try {
            const checks = await scm.getCIChecks(session.pr);
            if (checks.length === 0) {
              blockers.push("no CI checks found");
            } else {
              const hasBlocking = checks.some(
                (check) =>
                  check.status === "failed" ||
                  check.status === "pending" ||
                  check.status === "running",
              );
              const hasPassing = checks.some((check) => check.status === "passed");
              if (hasBlocking) {
                blockers.push("CI checks are not fully passing");
              } else if (!hasPassing) {
                blockers.push("no passing CI checks found");
              }
            }
          } catch {
            blockers.push("failed to evaluate CI checks");
          }
        }

        if (mergeGate.strict.requireCompletionDryRun) {
          const trackerPlugin = project.tracker?.plugin;
          if (!trackerPlugin) {
            blockers.push(
              `tracker plugin not configured (automation.mode=${getAutomationMode(project)})`,
            );
          } else if (!session.issueId) {
            blockers.push("no issue bound to this session");
          } else {
            const tracker = registry.get<Tracker>("tracker", trackerPlugin);
            if (!tracker) {
              blockers.push(`tracker plugin '${trackerPlugin}' not loaded`);
            } else {
              try {
                const completionGate = getCompletionGateConfig(project);
                if (completionGate.enabled) {
                  const completion = await evaluateCompletionGate(
                    session,
                    project,
                    tracker,
                    completionGate,
                  );
                  if (!completion.ok) {
                    blockers.push(
                      completion.reason
                        ? `completion gate failed (${completion.reason})`
                        : "completion gate failed",
                    );
                  }
                }
              } catch {
                blockers.push("failed to evaluate completion gate");
              }
            }
          }
        }

        if (blockers.length > 0) {
          mergeRetryCooldownUntil.set(
            sessionId,
            Date.now() + Math.max(0, mergeGate.retryCooldownSec) * 1000,
          );

          const event = createEvent("reaction.triggered", {
            sessionId,
            projectId,
            message: `Reaction '${reactionKey}' blocked strict merge gate`,
            data: {
              reactionKey,
              blockers,
            },
          });
          await notifyHuman(event, reactionConfig.priority ?? "warning");
          return {
            reactionType: reactionKey,
            success: false,
            action,
            message: "strict merge gate blocked",
            escalated: false,
          };
        }

        try {
          await scm.mergePR(session.pr, mergeGate.method);
          mergeRetryCooldownUntil.delete(sessionId);
          const event = createEvent("reaction.triggered", {
            sessionId,
            projectId,
            message: `Reaction '${reactionKey}' merged PR via ${mergeGate.method}`,
            data: { reactionKey, method: mergeGate.method },
          });
          await notifyHuman(event, reactionConfig.priority ?? "action");
          return {
            reactionType: reactionKey,
            success: true,
            action,
            message: "PR merged",
            escalated: false,
          };
        } catch (err) {
          mergeRetryCooldownUntil.set(
            sessionId,
            Date.now() + Math.max(0, mergeGate.retryCooldownSec) * 1000,
          );
          const event = createEvent("reaction.escalated", {
            sessionId,
            projectId,
            message: `Reaction '${reactionKey}' failed while merging PR`,
            data: {
              reactionKey,
              error: err instanceof Error ? err.message : String(err),
            },
          });
          await notifyHuman(event, reactionConfig.priority ?? "warning");
          return {
            reactionType: reactionKey,
            success: false,
            action,
            message: err instanceof Error ? err.message : String(err),
            escalated: true,
          };
        }
      }

      case "update-tracker-progress": {
        const project = config.projects[projectId];
        if (!project) {
          return {
            reactionType: reactionKey,
            success: false,
            action,
            message: `Project '${projectId}' not found`,
            escalated: false,
          };
        }

        const session = await sessionManager.get(sessionId).catch(() => null);
        if (!session || !session.issueId) {
          return {
            reactionType: reactionKey,
            success: false,
            action,
            message: "No issue bound to this session",
            escalated: false,
          };
        }

        const stage = reactionKeyToProgressStage(reactionKey);
        if (!stage) {
          return {
            reactionType: reactionKey,
            success: false,
            action,
            message: `Unknown progress stage for reaction '${reactionKey}'`,
            escalated: false,
          };
        }

        const cooldownMs =
          typeof reactionConfig.cooldown === "string" ? parseDuration(reactionConfig.cooldown) : 0;
        const previousStage = session.metadata["progress_stage"];
        const previousUpdatedAt = session.metadata["progress_updated_at"];
        const previousTargetState = session.metadata["progress_target_state"];
        const verifyStatus = session.metadata["verify_status"];
        const eventType = context?.eventType;
        const targetWorkflowStateName =
          stage === "review_updated"
            ? eventType === "review.changes_requested"
              ? "In Progress"
              : verifyStatus === "work_verify_pass_full" &&
                  (eventType === "review.pending" ||
                    eventType === "review.approved" ||
                    eventType === "merge.ready")
                ? "In Review"
                : undefined
            : undefined;
        if (previousStage === stage && cooldownMs > 0 && previousUpdatedAt) {
          const previousUpdatedMs = Date.parse(previousUpdatedAt);
          const targetChanged = (previousTargetState ?? "") !== (targetWorkflowStateName ?? "");
          if (!targetChanged && !Number.isNaN(previousUpdatedMs) && Date.now() - previousUpdatedMs < cooldownMs) {
            return {
              reactionType: reactionKey,
              success: true,
              action,
              message: "Progress update suppressed by cooldown",
              escalated: false,
            };
          }
        }

        const trackerPlugin = project.tracker?.plugin;
        if (!trackerPlugin) {
          return {
            reactionType: reactionKey,
            success: false,
            action,
            message: `Tracker plugin not configured (automation.mode=${getAutomationMode(project)})`,
            escalated: false,
          };
        }

        const tracker = registry.get<Tracker>("tracker", trackerPlugin);
        if (!tracker?.updateIssue) {
          return {
            reactionType: reactionKey,
            success: false,
            action,
            message: `Tracker '${trackerPlugin}' does not support issue updates`,
            escalated: false,
          };
        }

        let detectedPr = session.pr ?? null;
        if (!detectedPr && project.scm?.plugin) {
          const scm = registry.get<SCM>("scm", project.scm.plugin);
          if (scm?.detectPR) {
            try {
              detectedPr = await scm.detectPR(session, project);
            } catch {
              detectedPr = null;
            }
          }
        }

        const nowIso = new Date().toISOString();
        const progressText = summarizeProgressEvent(context?.eventType);
        const prUrl = detectedPr?.url ?? session.metadata["pr"];
        const verifyStatusValue = session.metadata["verify_status"];
        const verifyBrowserStatusValue = session.metadata["verify_browser_status"];
        const agentName = session.metadata["agent"] ?? project.agent ?? config.defaults.agent;
        const agent = registry.get<Agent>("agent", agentName);
        const runtime = registry.get<Runtime>("runtime", project.runtime ?? config.defaults.runtime);
        let terminalOutput = "";
        if (runtime && session.runtimeHandle) {
          try {
            terminalOutput = await runtime.getOutput(session.runtimeHandle, 80);
          } catch {
            terminalOutput = "";
          }
        }
        const terminalDevelopmentSummary = extractProgressSection(terminalOutput, [
          "개발 요약:",
          "development summary:",
        ]);
        let implementationSummary = extractProgressSection(terminalOutput, [
          "개발 구현:",
          "implementation:",
          "implementation details:",
        ]);
        let developmentSummary = normalizeSingleLineText(
          session.metadata["summary"] ?? terminalDevelopmentSummary ?? "",
        );
        if (!developmentSummary && agent?.getSessionInfo) {
          try {
            const agentSessionInfo = await agent.getSessionInfo(session);
            developmentSummary = normalizeSingleLineText(agentSessionInfo?.summary ?? "");
          } catch {
            developmentSummary = "";
          }
        }
        if (!developmentSummary && detectedPr?.title) {
          developmentSummary = normalizeSingleLineText(detectedPr.title);
        }
        if (!developmentSummary) {
          try {
            const issue = await tracker.getIssue(session.issueId, project);
            developmentSummary = normalizeSingleLineText(issue.title);
          } catch {
            developmentSummary = "";
          }
        }
        if (!implementationSummary) {
          implementationSummary = normalizeSingleLineText(
            session.branch
              ? `Code changes are tracked in branch ${session.branch}`
              : `Code changes are tracked in the linked PR`,
          );
        }
        const commentLines = [
          stage === "pr_opened"
            ? `Progress update (${nowIso}): PR is now open.`
            : `Progress update (${nowIso}): Review stage updated (${progressText}).`,
        ];
        if (prUrl) {
          commentLines.push(`- GitHub PR page: ${prUrl}`);
        }
        if (developmentSummary) {
          commentLines.push(`- Development summary: ${developmentSummary}`);
        }
        if (implementationSummary) {
          commentLines.push(`- Implementation details: ${implementationSummary}`);
        }
        if (verifyStatusValue || verifyBrowserStatusValue) {
          const verifyParts: string[] = [];
          if (verifyStatusValue) {
            verifyParts.push(`verify_status=${verifyStatusValue}`);
          }
          if (verifyBrowserStatusValue) {
            verifyParts.push(`verify_browser_status=${verifyBrowserStatusValue}`);
          }
          commentLines.push(`- Verification result: ${verifyParts.join(", ")}`);
        }
        if (session.branch) {
          commentLines.push(`- Implementation branch: ${session.branch}`);
        }
        const comment = commentLines.join("\n");
        const updatePayload: IssueUpdate = {
          state: "in_progress",
          comment,
        };
        if (targetWorkflowStateName) {
          updatePayload.workflowStateName = targetWorkflowStateName;
        }

        try {
          await tracker.updateIssue(session.issueId, updatePayload, project);

          const sessionsDir = getSessionsDir(config.configPath, project.path);
          updateMetadata(sessionsDir, session.id, {
            progress_stage: stage,
            progress_updated_at: nowIso,
            progress_target_state: targetWorkflowStateName ?? "",
          });
          session.metadata["progress_stage"] = stage;
          session.metadata["progress_updated_at"] = nowIso;
          session.metadata["progress_target_state"] = targetWorkflowStateName ?? "";

          return {
            reactionType: reactionKey,
            success: true,
            action,
            escalated: false,
          };
        } catch (err) {
          const event = createEvent("reaction.escalated", {
            sessionId,
            projectId,
            message: `Reaction '${reactionKey}' failed while updating tracker progress`,
            data: {
              reactionKey,
              issueId: session.issueId,
              error: err instanceof Error ? err.message : String(err),
            },
          });
          await notifyHuman(event, reactionConfig.priority ?? "warning");
          return {
            reactionType: reactionKey,
            success: false,
            action,
            message: err instanceof Error ? err.message : String(err),
            escalated: true,
          };
        }
      }

      case "complete-tracker-issue": {
        const project = config.projects[projectId];
        if (!project) {
          return {
            reactionType: reactionKey,
            success: false,
            action,
            message: `Project '${projectId}' not found`,
            escalated: false,
          };
        }

        const session = await sessionManager.get(sessionId).catch(() => null);
        if (!session || !session.issueId) {
          return {
            reactionType: reactionKey,
            success: false,
            action,
            message: "No issue bound to this session",
            escalated: false,
          };
        }

        const verifyStatus = session.metadata["verify_status"];
        if (verifyStatus !== VERIFY_STATUS_REQUIRED) {
          const event = createEvent("reaction.triggered", {
            sessionId,
            projectId,
            message: `Reaction '${reactionKey}' blocked: verify_status is '${verifyStatus ?? "missing"}'`,
            data: { reactionKey, issueId: session.issueId, verifyStatus: verifyStatus ?? null },
          });
          await notifyHuman(event, reactionConfig.priority ?? "warning");
          return {
            reactionType: reactionKey,
            success: false,
            action,
            message: "verify_status gate not satisfied",
            escalated: false,
          };
        }

        const browserVerifyStatus = session.metadata[BROWSER_VERIFY_KEY];
        if (browserVerifyStatus !== BROWSER_VERIFY_PASS_VALUE) {
          const event = createEvent("reaction.triggered", {
            sessionId,
            projectId,
            message: `Reaction '${reactionKey}' blocked: ${BROWSER_VERIFY_KEY} is '${browserVerifyStatus ?? "missing"}'`,
            data: {
              reactionKey,
              issueId: session.issueId,
              browserVerifyStatus: browserVerifyStatus ?? null,
              browserVerifyKey: BROWSER_VERIFY_KEY,
              browserVerifyRequired: BROWSER_VERIFY_PASS_VALUE,
            },
          });
          await notifyHuman(event, reactionConfig.priority ?? "warning");
          return {
            reactionType: reactionKey,
            success: false,
            action,
            message: `${BROWSER_VERIFY_KEY} gate not satisfied`,
            escalated: false,
          };
        }

        const trackerPlugin = project.tracker?.plugin;
        if (!trackerPlugin) {
          return {
            reactionType: reactionKey,
            success: false,
            action,
            message: `Tracker plugin not configured (automation.mode=${getAutomationMode(project)})`,
            escalated: false,
          };
        }

        const tracker = registry.get<Tracker>("tracker", trackerPlugin);
        if (!tracker?.updateIssue) {
          return {
            reactionType: reactionKey,
            success: false,
            action,
            message: `Tracker '${trackerPlugin}' does not support issue updates`,
            escalated: false,
          };
        }

        const sessionsDir = getSessionsDir(config.configPath, project.path);
        const setAcceptanceMetadata = (summary: {
          total: number;
          checked: number;
          unchecked: number;
          status: string;
          checkedAt?: string;
        }): void => {
          const checkedAt = summary.checkedAt ?? new Date().toISOString();
          updateMetadata(sessionsDir, session.id, {
            acceptance_total: String(summary.total),
            acceptance_checked: String(summary.checked),
            acceptance_unchecked: String(summary.unchecked),
            acceptance_status: summary.status,
            acceptance_checked_at: checkedAt,
          });
          session.metadata["acceptance_total"] = String(summary.total);
          session.metadata["acceptance_checked"] = String(summary.checked);
          session.metadata["acceptance_unchecked"] = String(summary.unchecked);
          session.metadata["acceptance_status"] = summary.status;
          session.metadata["acceptance_checked_at"] = checkedAt;
        };

        try {
          const completionGate = getCompletionGateConfig(project);
          let gateResult: CompletionGateEvaluation | null = null;

          if (completionGate.enabled) {
            gateResult = await evaluateCompletionGate(session, project, tracker, completionGate);

            if (!gateResult.ok) {
              const blockedStatus =
                gateResult.reason === "no_checklist"
                  ? "blocked_no_checkboxes"
                  : gateResult.reason === "missing_evidence"
                    ? "blocked_missing_evidence"
                    : gateResult.reason === "checklist_incomplete"
                      ? "blocked_checklist_incomplete"
                      : "blocked_gate_error";

              setAcceptanceMetadata({
                total: gateResult.checklist.total,
                checked: gateResult.checklist.checked,
                unchecked: gateResult.checklist.unchecked,
                status: blockedStatus,
              });

              const event = createEvent("reaction.triggered", {
                sessionId,
                projectId,
                message: `Reaction '${reactionKey}' blocked completion gate (${gateResult.reason ?? "unknown"})`,
                data: {
                  reactionKey,
                  issueId: session.issueId,
                  reason: gateResult.reason ?? "unknown",
                },
              });
              await notifyHuman(event, reactionConfig.priority ?? "warning");
              return {
                reactionType: reactionKey,
                success: false,
                action,
                message: "completion gate not satisfied",
                escalated: false,
              };
            }

            if (gateResult.checklist.unchecked > 0 && gateResult.canAutoSyncChecklist) {
              const autoCheckedAt = new Date().toISOString();
              await tracker.updateIssue(
                session.issueId,
                {
                  description: gateResult.checklist.updatedMarkdown,
                  comment: `Automatically checked ${gateResult.checklist.unchecked} acceptance checklist item(s) before completion.`,
                },
                project,
              );
              setAcceptanceMetadata({
                total: gateResult.checklist.total,
                checked: gateResult.checklist.total,
                unchecked: 0,
                status: "auto_checked",
                checkedAt: autoCheckedAt,
              });
            } else {
              setAcceptanceMetadata({
                total: gateResult.checklist.total,
                checked: gateResult.checklist.checked,
                unchecked: gateResult.checklist.unchecked,
                status: "passed",
              });
            }
          }

          await tracker.updateIssue(
            session.issueId,
            {
              state: "closed",
              comment:
                `Automatically completed after PR merge (work-verify full passed: verify_status=${VERIFY_STATUS_REQUIRED}; browser verification passed: ${BROWSER_VERIFY_KEY}=${BROWSER_VERIFY_PASS_VALUE}; completion gate=${completionGate.enabled ? "enabled" : "disabled"}).`,
            },
            project,
          );
          return {
            reactionType: reactionKey,
            success: true,
            action,
            escalated: false,
          };
        } catch (err) {
          const event = createEvent("reaction.escalated", {
            sessionId,
            projectId,
            message: `Reaction '${reactionKey}' failed while completing tracker issue`,
            data: {
              reactionKey,
              issueId: session.issueId,
              error: err instanceof Error ? err.message : String(err),
            },
          });
          await notifyHuman(event, reactionConfig.priority ?? "warning");
          return {
            reactionType: reactionKey,
            success: false,
            action,
            message: err instanceof Error ? err.message : String(err),
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

      // Clear reaction trackers for the old status so retries reset on state changes
      const oldEventType = statusToEventType(undefined, oldStatus);
      if (oldEventType) {
        const oldReactionKeys = eventToReactionKeys(oldEventType);
        for (const oldReactionKey of oldReactionKeys) {
          reactionTrackers.delete(`${session.id}:${oldReactionKey}`);
        }
      }

      // Handle transition: notify humans and/or trigger reactions
      const eventType = statusToEventType(oldStatus, newStatus);
      if (eventType) {
        let reactionHandledNotify = false;
        const reactionKeys = eventToReactionKeys(eventType);

        if (reactionKeys.length > 0) {
          for (const reactionKey of reactionKeys) {
            // Merge project-specific overrides with global defaults
            const project = config.projects[session.projectId];
            const globalReaction = config.reactions[reactionKey];
            const projectReaction = project?.reactions?.[reactionKey];
            const reactionConfig = projectReaction
              ? { ...globalReaction, ...projectReaction }
              : globalReaction;

            if (reactionConfig && reactionConfig.action) {
              // auto: false skips automated agent actions but still allows notifications
              if (reactionConfig.auto !== false || reactionConfig.action === "notify") {
                await executeReaction(
                  session.id,
                  session.projectId,
                  reactionKey,
                  reactionConfig as ReactionConfig,
                  { eventType, oldStatus, newStatus },
                );
                // Reaction is handling this event — suppress immediate human notification.
                // "send-to-agent" retries + escalates on its own; "notify"/"auto-merge"
                // already call notifyHuman internally. Notifying here would bypass the
                // delayed escalation behaviour configured via retries/escalateAfter.
                reactionHandledNotify = true;
              }
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
    }
  }

  /** Run one polling cycle across all sessions. */
  async function pollAll(): Promise<void> {
    // Re-entrancy guard: skip if previous poll is still running
    if (polling) return;
    polling = true;

    try {
      const sessions = await sessionManager.list();

      await runQueuePickup(sessions);

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
        const reactionKeys = eventToReactionKeys("summary.all_complete");
        for (const reactionKey of reactionKeys) {
          const reactionConfig = config.reactions[reactionKey];
          if (reactionConfig && reactionConfig.action) {
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
