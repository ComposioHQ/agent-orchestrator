/**
 * Intelligent issue dispatcher — scores, ranks, and dispatches GitHub issues
 * to AO agent sessions based on severity, quick-win potential, staleness,
 * and dependency/blocked state.
 *
 * Replaces the simple FIFO backlog poller with a weighted scoring engine
 * ported from the standalone ao_dispatcher tool.
 *
 * Architecture:
 *   - Uses Tracker plugins for issue data (not raw `gh` CLI)
 *   - Uses SessionManager for spawning and capacity checks
 *   - Persists dispatch records to JSON alongside session metadata
 *   - Exposes snapshot state for the web dashboard via SSE
 */

import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import type {
  OrchestratorConfig,
  PluginRegistry,
  OpenCodeSessionManager,
  Tracker,
  Issue,
  ProjectConfig,
  DispatcherProjectConfig,
  DispatcherScoringWeights,
} from "./types.js";
import {
  TERMINAL_STATUSES,
  isOrchestratorSession,
} from "./types.js";
import { getProjectBaseDir } from "./paths.js";

// =============================================================================
// PUBLIC TYPES
// =============================================================================

export interface DispatcherDeps {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  sessionManager: OpenCodeSessionManager;
}

export interface ScoredIssue {
  issue: Issue;
  projectId: string;
  totalScore: number;
  severityScore: number;
  quickWinScore: number;
  stalenessScore: number;
  dependencyScore: number;
  backlogBoostScore: number;
  reason: string;
  isBlocked: boolean;
}

export interface DispatchRecord {
  issueId: string;
  projectId: string;
  spawnedAt: string;
  title: string;
  score: number;
  status: "spawned" | "completed" | "failed";
}

export type DispatcherStatus = "running" | "stopped" | "paused";

export interface DispatcherSnapshot {
  status: DispatcherStatus;
  lastCycleAt: string | null;
  nextCycleAt: string | null;
  activeDispatches: number;
  eligibleCount: number;
  scoreboard: ScoredIssue[];
  cycleCount: number;
  excludeLabels: string[];
}

export interface Dispatcher {
  start(): void;
  stop(): void;
  pause(): void;
  resume(): void;
  getSnapshot(): DispatcherSnapshot;
  getProjectConfig(projectId: string): DispatcherProjectConfig;
  updateProjectConfig(projectId: string, updates: Partial<DispatcherProjectConfig>): void;
  runCycleNow(): Promise<void>;
}

// =============================================================================
// CONSTANTS — scoring patterns ported from ao_dispatcher
// =============================================================================

/** Hard ceiling on parallel AO sessions — not overridable */
const MAX_CONCURRENT_HARD_CAP = 5;

/** Label names that are inherently non-actionable for an AI coding agent */
const DEFAULT_EXCLUDE_PATTERNS: string[] = [
  "question", "discussion", "epic", "wont-fix", "wontfix", "won't fix",
  "duplicate", "invalid", "stale", "needs-triage", "triage",
  "needs-design", "needs-input", "needs-discussion", "needs-review",
  "help wanted", "good first issue",
  "on hold", "on-hold", "deferred", "backlog",
  "meta", "tracking", "umbrella",
  "rfc", "proposal", "adr",
];

/** Default severity label → base score (0–1) */
const DEFAULT_SEVERITY_LABELS: Record<string, number> = {
  critical: 1.0, high: 0.75, medium: 0.5, low: 0.25,
  p0: 1.0, p1: 0.75, p2: 0.5, p3: 0.25,
  urgent: 1.0, priority: 0.75,
};

/** Default quick-win labels */
const DEFAULT_QUICK_WIN_LABELS: string[] = [
  "quick-win", "small", "trivial", "one-liner",
  "typo", "config-change", "chore",
];

/** Default blocked labels */
const DEFAULT_BLOCKED_LABELS: string[] = [
  "blocked", "waiting", "needs-input", "needs-design",
  "on hold", "on-hold",
];

/** Bug-like label patterns — get a severity bump */
const BUG_PATTERNS = ["bug", "defect", "error", "crash", "broken", "regression"];

/** Title patterns that signal urgency → severity bump */
const TITLE_URGENCY_PATTERNS: Array<[RegExp, number]> = [
  [/\bcrash/i, 0.3], [/\bbreaking\b/i, 0.3], [/\bdown\b/i, 0.2],
  [/\bregression\b/i, 0.25], [/\b500\b/i, 0.2], [/\b404\b/i, 0.15],
  [/\bsecurity\b/i, 0.3], [/\bvuln/i, 0.3],
];

/** Title patterns that signal quick wins */
const TITLE_QUICK_WIN_PATTERNS: RegExp[] = [
  /\btypo\b/i, /\brename\b/i, /\bbump\b/i,
  /\bupdate\s+version/i, /\bfix\s+import/i, /\bremove\s+unused/i,
  /\bupdate\s+readme/i, /\bconfig\b/i, /\benv\b.*\bvar/i,
  /\bdeprecation\b/i, /\blint\b/i,
];

/** Body signals that suggest quick wins */
const BODY_QUICK_WIN_SIGNALS = [
  "one-line", "single file", "config change", "typo",
  "rename", "update version", "bump", "simple fix",
  "straightforward", "just need to",
];

const BACKLOG_LABEL = "agent:backlog";

// =============================================================================
// DEFAULT CONFIG — fully populated from defaults
// =============================================================================

export const DEFAULT_DISPATCHER_CONFIG: DispatcherProjectConfig = {
  enabled: false,
  pollInterval: 120,
  maxConcurrent: 3,
  maxSpawnsPerCycle: 2,
  cooldownAfterSpawn: 30,
  commentOnDispatch: true,
  backlogBoost: 30,
  scoring: { severity: 40, quickWin: 25, staleness: 15, dependencies: 20 },
  excludeLabels: [],
  severityLabels: {},
  quickWinLabels: [],
  blockedLabels: [],
};

// =============================================================================
// SCORING ENGINE — pure functions, easily testable
// =============================================================================

function resolveConfig(partial?: Partial<DispatcherProjectConfig>): DispatcherProjectConfig {
  if (!partial) return { ...DEFAULT_DISPATCHER_CONFIG };
  return {
    ...DEFAULT_DISPATCHER_CONFIG,
    ...partial,
    scoring: { ...DEFAULT_DISPATCHER_CONFIG.scoring, ...partial.scoring },
  };
}

function getSeverityLabels(config: DispatcherProjectConfig): Record<string, number> {
  return Object.keys(config.severityLabels).length > 0
    ? config.severityLabels
    : DEFAULT_SEVERITY_LABELS;
}

function getQuickWinLabels(config: DispatcherProjectConfig): string[] {
  return config.quickWinLabels.length > 0
    ? config.quickWinLabels
    : DEFAULT_QUICK_WIN_LABELS;
}

function getBlockedLabels(config: DispatcherProjectConfig): string[] {
  return config.blockedLabels.length > 0
    ? config.blockedLabels
    : DEFAULT_BLOCKED_LABELS;
}

function getExcludePatterns(config: DispatcherProjectConfig): string[] {
  return config.excludeLabels.length > 0
    ? config.excludeLabels
    : DEFAULT_EXCLUDE_PATTERNS;
}

/** Check if any of an issue's labels match exclusion patterns */
function isExcludedByLabel(issueLabels: string[], excludePatterns: string[]): boolean {
  return issueLabels.some((label) => {
    const lower = label.toLowerCase();
    return excludePatterns.some((pattern) => lower.includes(pattern.toLowerCase()));
  });
}

/** Score a single issue across all dimensions */
function scoreIssue(
  issue: Issue,
  projectId: string,
  config: DispatcherProjectConfig,
  weights: DispatcherScoringWeights,
): ScoredIssue {
  const titleLower = issue.title.toLowerCase();
  const bodyLower = (issue.description || "").toLowerCase();
  const severityLabels = getSeverityLabels(config);
  const quickWinLabels = getQuickWinLabels(config);
  const blockedLabels = getBlockedLabels(config);

  // --- Severity ---
  let severityRaw = 0;
  let severitySource = "default";
  for (const label of issue.labels) {
    const lower = label.toLowerCase();
    // Direct match (e.g. "high", "p0")
    if (lower in severityLabels && severityLabels[lower] > severityRaw) {
      severityRaw = severityLabels[lower];
      severitySource = lower;
    }
    // Prefixed match (e.g. "severity:high" → try "high", "priority/p0" → try "p0")
    const colonIdx = lower.lastIndexOf(":");
    const slashIdx = lower.lastIndexOf("/");
    const delimIdx = Math.max(colonIdx, slashIdx);
    if (delimIdx > 0) {
      const suffix = lower.slice(delimIdx + 1).trim();
      if (suffix in severityLabels && severityLabels[suffix] > severityRaw) {
        severityRaw = severityLabels[suffix];
        severitySource = lower;
      }
    }
  }

  const isBug = issue.labels.some((lbl) =>
    BUG_PATTERNS.some((p) => lbl.toLowerCase().includes(p)),
  );
  if (isBug && severityRaw < 0.6) {
    severityRaw = Math.max(severityRaw, 0.6);
    if (severitySource === "default") severitySource = "bug";
  }

  for (const [pattern, bump] of TITLE_URGENCY_PATTERNS) {
    if (pattern.test(titleLower)) {
      severityRaw = Math.min(1.0, severityRaw + bump);
      severitySource += "+title";
      break;
    }
  }

  if (severityRaw === 0) {
    severityRaw = 0.35;
    severitySource = "no-label";
  }
  const severityScore = severityRaw * weights.severity;

  // --- Quick-win ---
  let isQuickWin = issue.labels.some((lbl) =>
    quickWinLabels.some((qw) => lbl.toLowerCase().includes(qw.toLowerCase())),
  );

  if (!isQuickWin) {
    isQuickWin = TITLE_QUICK_WIN_PATTERNS.some((p) => p.test(titleLower));
  }
  if (!isQuickWin) {
    isQuickWin = BODY_QUICK_WIN_SIGNALS.some((sig) => bodyLower.includes(sig));
  }
  const quickWinScore = (isQuickWin ? 1.0 : 0.0) * weights.quickWin;

  // --- Staleness ---
  let ageDays = 0;
  if (issue.createdAt) {
    try {
      const created = new Date(issue.createdAt);
      ageDays = (Date.now() - created.getTime()) / 86_400_000;
    } catch {
      ageDays = 0;
    }
  }
  const stalenessRaw = Math.min(ageDays / 30, 1.0);
  const stalenessScore = stalenessRaw * weights.staleness;

  // --- Dependency / blocked ---
  let isBlocked = issue.labels.some((lbl) =>
    blockedLabels.some((bl) => lbl.toLowerCase().includes(bl.toLowerCase())),
  );
  if (/blocked\s+by\s+#\d+/i.test(bodyLower)) isBlocked = true;
  if (/depends\s+on\s+#\d+/i.test(bodyLower)) isBlocked = true;
  const dependencyScore = (isBlocked ? -1.0 : 0.0) * weights.dependencies;

  // --- Backlog boost ---
  const hasBacklogLabel = issue.labels.some(
    (lbl) => lbl.toLowerCase() === BACKLOG_LABEL,
  );
  const backlogBoostScore = hasBacklogLabel ? config.backlogBoost : 0;

  // --- Total ---
  const totalScore = severityScore + quickWinScore + stalenessScore + dependencyScore + backlogBoostScore;

  // --- Reason string ---
  const parts: string[] = [`sev:${severitySource}(${severityScore.toFixed(0)})`];
  if (isBug) parts.push("bug");
  if (isQuickWin) parts.push(`quick(+${quickWinScore.toFixed(0)})`);
  if (ageDays > 1) parts.push(`age:${ageDays.toFixed(0)}d(+${stalenessScore.toFixed(0)})`);
  if (hasBacklogLabel) parts.push(`backlog(+${backlogBoostScore})`);
  if (isBlocked) parts.push(`BLOCKED(${dependencyScore.toFixed(0)})`);

  return {
    issue,
    projectId,
    totalScore,
    severityScore,
    quickWinScore,
    stalenessScore,
    dependencyScore,
    backlogBoostScore,
    reason: parts.join(" | "),
    isBlocked,
  };
}

/** Score and rank a list of issues. Higher score = dispatch first. */
export function scoreIssues(
  issues: Issue[],
  projectId: string,
  config: DispatcherProjectConfig,
): ScoredIssue[] {
  const weights = config.scoring;
  const scored = issues.map((issue) => scoreIssue(issue, projectId, config, weights));
  scored.sort((a, b) => b.totalScore - a.totalScore);
  return scored;
}

// =============================================================================
// STATE PERSISTENCE
// =============================================================================

interface PersistedDispatcherState {
  lastUpdated: string;
  dispatched: DispatchRecord[];
}

/** Global dispatcher status persisted across restarts */
interface PersistedGlobalStatus {
  status: DispatcherStatus;
  updatedAt: string;
}

const GLOBAL_STATUS_PATH = join(
  process.env["HOME"] || "~",
  ".agent-orchestrator",
  "dispatcher-status.json",
);

export function readPersistedDispatcherStatus(): DispatcherStatus | null {
  try {
    if (!existsSync(GLOBAL_STATUS_PATH)) return null;
    const raw: PersistedGlobalStatus = JSON.parse(readFileSync(GLOBAL_STATUS_PATH, "utf8"));
    if (raw.status === "running" || raw.status === "stopped" || raw.status === "paused") {
      return raw.status;
    }
    return null;
  } catch {
    return null;
  }
}

function writePersistedStatus(status: DispatcherStatus): void {
  try {
    const dir = join(GLOBAL_STATUS_PATH, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const data: PersistedGlobalStatus = {
      status,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(GLOBAL_STATUS_PATH, JSON.stringify(data, null, 2));
  } catch {
    // Best effort — don't crash if we can't persist
  }
}

class DispatcherState {
  private records: Map<string, DispatchRecord> = new Map();
  private readonly statePath: string;

  constructor(baseDir: string) {
    this.statePath = join(baseDir, "dispatcher-state.json");
    this.load();
  }

  private load(): void {
    if (!existsSync(this.statePath)) return;
    try {
      const raw: PersistedDispatcherState = JSON.parse(readFileSync(this.statePath, "utf8"));
      for (const rec of raw.dispatched) {
        this.records.set(rec.issueId, rec);
      }
    } catch {
      // Corrupt state — start fresh
    }
  }

  save(): void {
    const dir = join(this.statePath, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const data: PersistedDispatcherState = {
      lastUpdated: new Date().toISOString(),
      dispatched: [...this.records.values()],
    };
    writeFileSync(this.statePath, JSON.stringify(data, null, 2));
  }

  isDispatched(issueId: string): boolean {
    const rec = this.records.get(issueId);
    return !!rec && rec.status === "spawned";
  }

  markDispatched(issueId: string, projectId: string, title: string, score: number): void {
    this.records.set(issueId, {
      issueId,
      projectId,
      spawnedAt: new Date().toISOString(),
      title,
      score,
      status: "spawned",
    });
    this.save();
  }

  activeCount(): number {
    let count = 0;
    for (const rec of this.records.values()) {
      if (rec.status === "spawned") count++;
    }
    return count;
  }

  /** Mark issues that are no longer open as completed */
  cleanupClosedIssues(openIssueIds: Set<string>): void {
    let changed = false;
    for (const [id, rec] of this.records) {
      if (rec.status === "spawned" && !openIssueIds.has(id)) {
        rec.status = "completed";
        changed = true;
      }
    }
    if (changed) this.save();
  }

  /** Reconcile with AO's actual session count */
  reconcileWithSessions(activeSessionIssueIds: Set<string>): void {
    let changed = false;
    for (const [id, rec] of this.records) {
      if (rec.status === "spawned" && !activeSessionIssueIds.has(id)) {
        rec.status = "completed";
        changed = true;
      }
    }
    if (changed) this.save();
  }

  reset(): void {
    this.records.clear();
    this.save();
  }
}

// =============================================================================
// DISPATCHER SERVICE
// =============================================================================

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  const { config, registry, sessionManager } = deps;

  // Per-project state
  const projectStates = new Map<string, DispatcherState>();
  // Runtime config overrides (from dashboard)
  const runtimeConfigOverrides = new Map<string, Partial<DispatcherProjectConfig>>();

  let status: DispatcherStatus = "stopped";
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let lastCycleAt: string | null = null;
  let nextCycleAt: string | null = null;
  let cycleCount = 0;
  let latestScoreboard: ScoredIssue[] = [];
  let latestEligibleCount = 0;
  let running = false; // re-entrancy guard

  function getState(projectId: string): DispatcherState {
    let state = projectStates.get(projectId);
    if (!state) {
      const project = config.projects[projectId];
      if (!project) throw new Error(`Unknown project: ${projectId}`);
      const baseDir = getProjectBaseDir(config.configPath, project.path);
      state = new DispatcherState(baseDir);
      projectStates.set(projectId, state);
    }
    return state;
  }

  function getEffectiveConfig(projectId: string): DispatcherProjectConfig {
    const project = config.projects[projectId];
    const base = resolveConfig(project?.dispatcher);
    const overrides = runtimeConfigOverrides.get(projectId);
    if (!overrides) return base;
    return {
      ...base,
      ...overrides,
      scoring: { ...base.scoring, ...overrides.scoring },
    };
  }

  async function fetchAllOpenIssues(
    projectId: string,
    project: ProjectConfig,
  ): Promise<Issue[]> {
    if (!project.tracker) return [];
    const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
    if (!tracker?.listIssues) return [];

    try {
      return await tracker.listIssues({ state: "open", limit: 100 }, project);
    } catch (err) {
      console.error(`[dispatcher] Failed to fetch issues for ${projectId}:`, err);
      return [];
    }
  }

  async function dispatchCycle(): Promise<void> {
    if (running) return; // re-entrancy guard
    running = true;
    const allScored: ScoredIssue[] = [];

    try {
      // Get all active sessions for capacity checking
      const allSessions = await sessionManager.list();
      const workerSessions = allSessions.filter(
        (s) => !isOrchestratorSession(s) && !TERMINAL_STATUSES.has(s.status),
      );
      const activeIssueIds = new Set(
        workerSessions.filter((s) => s.issueId).map((s) => s.issueId!.toLowerCase()),
      );

      for (const [projectId, project] of Object.entries(config.projects)) {
        const projConfig = getEffectiveConfig(projectId);
        if (!projConfig.enabled) continue;

        const state = getState(projectId);
        const excludePatterns = getExcludePatterns(projConfig);

        // 1. Fetch all open issues
        const allIssues = await fetchAllOpenIssues(projectId, project);
        if (allIssues.length === 0) continue;

        // Track open issues for state cleanup
        const openIssueIds = new Set(allIssues.map((i) => i.id.toLowerCase()));
        state.cleanupClosedIssues(openIssueIds);
        state.reconcileWithSessions(activeIssueIds);

        // 2. Filter non-actionable issues
        const eligible: Issue[] = [];
        for (const issue of allIssues) {
          if (isExcludedByLabel(issue.labels, excludePatterns)) continue;
          if (issue.assignee) continue;
          if (activeIssueIds.has(issue.id.toLowerCase())) continue;
          if (state.isDispatched(issue.id)) continue;
          eligible.push(issue);
        }

        // 3. Score all eligible issues
        const scored = scoreIssues(eligible, projectId, projConfig);
        allScored.push(...scored);

        // 4. Check capacity
        const effectiveMax = Math.min(projConfig.maxConcurrent, MAX_CONCURRENT_HARD_CAP);
        const projectSessions = workerSessions.filter((s) => s.projectId === projectId);
        const slotsAvailable = Math.max(0, effectiveMax - projectSessions.length);
        const maxThisCycle = Math.min(slotsAvailable, projConfig.maxSpawnsPerCycle);

        if (maxThisCycle === 0) {
          console.log(
            `[dispatcher] ${projectId}: at capacity (${projectSessions.length}/${effectiveMax})`,
          );
          continue;
        }

        // 5. Dispatch top-ranked issues
        let spawned = 0;
        for (const si of scored) {
          if (spawned >= maxThisCycle) break;
          if (si.isBlocked) {
            console.log(`[dispatcher] Skipping #${si.issue.id} (blocked)`);
            continue;
          }

          console.log(
            `[dispatcher] Dispatching ${projectId}/#${si.issue.id}: ${si.issue.title.slice(0, 55)} (score: ${si.totalScore.toFixed(1)})`,
          );

          try {
            await sessionManager.spawn({ projectId, issueId: si.issue.id });

            state.markDispatched(si.issue.id, projectId, si.issue.title, si.totalScore);
            activeIssueIds.add(si.issue.id.toLowerCase());

            // Post comment on issue
            if (projConfig.commentOnDispatch) {
              const tracker = registry.get<Tracker>("tracker", project.tracker?.plugin ?? "");
              if (tracker?.updateIssue) {
                try {
                  await tracker.updateIssue(
                    si.issue.id,
                    {
                      labels: ["agent:in-progress"],
                      removeLabels: ["agent:backlog"],
                      comment: `**AO Dispatcher** — spawning an agent for this issue (score: ${si.totalScore.toFixed(1)})\n\nAn AI coding agent has been assigned via Agent Orchestrator. A PR will be opened when the agent completes its work.`,
                    },
                    project,
                  );
                } catch (err) {
                  console.error(`[dispatcher] Failed to comment on ${si.issue.id}:`, err);
                }
              }
            }

            spawned++;

            // Cooldown between spawns
            if (spawned < maxThisCycle && projConfig.cooldownAfterSpawn > 0) {
              await new Promise((resolve) =>
                setTimeout(resolve, projConfig.cooldownAfterSpawn * 1000),
              );
            }
          } catch (err) {
            console.error(`[dispatcher] Failed to spawn for ${si.issue.id}:`, err);
          }
        }

        console.log(
          `[dispatcher] ${projectId}: dispatched ${spawned} new agent${spawned !== 1 ? "s" : ""}`,
        );
      }

      // Update scoreboard for dashboard
      allScored.sort((a, b) => b.totalScore - a.totalScore);
      latestScoreboard = allScored;
      latestEligibleCount = allScored.length;
      lastCycleAt = new Date().toISOString();
      cycleCount++;
    } catch (err) {
      console.error("[dispatcher] Cycle failed:", err);
    } finally {
      running = false;
    }
  }

  function computeNextCycleAt(): string | null {
    if (status !== "running") return null;
    // Find the shortest poll interval across enabled projects
    let minInterval = Infinity;
    for (const [projectId] of Object.entries(config.projects)) {
      const projConfig = getEffectiveConfig(projectId);
      if (projConfig.enabled && projConfig.pollInterval < minInterval) {
        minInterval = projConfig.pollInterval;
      }
    }
    if (minInterval === Infinity) return null;
    const last = lastCycleAt ? new Date(lastCycleAt).getTime() : Date.now();
    return new Date(last + minInterval * 1000).toISOString();
  }

  const dispatcher: Dispatcher = {
    start() {
      if (status === "running") return;
      status = "running";
      writePersistedStatus("running");

      // Find the shortest poll interval across enabled projects
      let minInterval = 120;
      for (const [projectId] of Object.entries(config.projects)) {
        const projConfig = getEffectiveConfig(projectId);
        if (projConfig.enabled && projConfig.pollInterval < minInterval) {
          minInterval = projConfig.pollInterval;
        }
      }

      console.log(`[dispatcher] Starting (poll every ${minInterval}s)`);
      void dispatchCycle();
      pollTimer = setInterval(() => void dispatchCycle(), minInterval * 1000);
      nextCycleAt = computeNextCycleAt();
    },

    stop() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
      status = "stopped";
      nextCycleAt = null;
      writePersistedStatus("stopped");
      console.log("[dispatcher] Stopped");
    },

    pause() {
      if (status !== "running") return;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
      status = "paused";
      nextCycleAt = null;
      writePersistedStatus("paused");
      console.log("[dispatcher] Paused");
    },

    resume() {
      if (status !== "paused") return;
      dispatcher.start();
    },

    getSnapshot(): DispatcherSnapshot {
      // Collect active dispatches across all projects
      let activeDispatches = 0;
      const allExcludeLabels = new Set<string>();
      for (const [projectId] of Object.entries(config.projects)) {
        const projConfig = getEffectiveConfig(projectId);
        if (!projConfig.enabled) continue;
        try {
          activeDispatches += getState(projectId).activeCount();
        } catch {
          // project state not initialized yet
        }
        for (const label of getExcludePatterns(projConfig)) {
          allExcludeLabels.add(label);
        }
      }

      return {
        status,
        lastCycleAt,
        nextCycleAt: computeNextCycleAt(),
        activeDispatches,
        eligibleCount: latestEligibleCount,
        scoreboard: latestScoreboard.slice(0, 50), // cap for transport
        cycleCount,
        excludeLabels: [...allExcludeLabels].sort(),
      };
    },

    getProjectConfig(projectId: string): DispatcherProjectConfig {
      return getEffectiveConfig(projectId);
    },

    updateProjectConfig(projectId: string, updates: Partial<DispatcherProjectConfig>) {
      const existing = runtimeConfigOverrides.get(projectId) || {};
      runtimeConfigOverrides.set(projectId, {
        ...existing,
        ...updates,
        scoring: updates.scoring
          ? { ...(existing.scoring || {}), ...updates.scoring }
          : existing.scoring,
      });

      // If the poll interval changed, restart the timer
      if (updates.pollInterval && status === "running") {
        dispatcher.stop();
        dispatcher.start();
      }
    },

    async runCycleNow() {
      await dispatchCycle();
    },
  };

  return dispatcher;
}
