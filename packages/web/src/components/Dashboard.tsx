"use client";

import { useMemo, useState } from "react";
import {
  type DashboardSession,
  type DashboardStats,
  type DashboardPR,
  type AttentionLevel,
  getAttentionLevel,
  isPRRateLimited,
  getSessionRound,
  TERMINAL_STATUSES,
  TERMINAL_ACTIVITIES,
} from "@/lib/types";
import { CI_STATUS, SESSION_PHASE } from "@composio/ao-core/types";
import { AttentionZone } from "./AttentionZone";
import { PRTableRow } from "./PRStatus";
import { DynamicFavicon } from "./DynamicFavicon";

interface DashboardProps {
  sessions: DashboardSession[];
  stats: DashboardStats;
  orchestratorId?: string | null;
  projectName?: string;
}

const KANBAN_LEVELS = ["working", "pending", "review", "respond", "merge"] as const;
const WORKFLOW_PHASE_ORDER = [
  SESSION_PHASE.PLANNING,
  SESSION_PHASE.PLAN_REVIEW,
  SESSION_PHASE.IMPLEMENTING,
  SESSION_PHASE.CODE_REVIEW,
  SESSION_PHASE.READY_TO_MERGE,
] as const;
type WorkflowPhase = (typeof WORKFLOW_PHASE_ORDER)[number];

const WORKFLOW_PHASE_LABEL: Record<WorkflowPhase, string> = {
  [SESSION_PHASE.PLANNING]: "planning",
  [SESSION_PHASE.PLAN_REVIEW]: "plan review",
  [SESSION_PHASE.IMPLEMENTING]: "implementing",
  [SESSION_PHASE.CODE_REVIEW]: "code review",
  [SESSION_PHASE.READY_TO_MERGE]: "ready to merge",
};

interface SwarmWorkflowSummary {
  total: number;
  phaseCounts: Record<WorkflowPhase, number>;
  maxRoundByPhase: Partial<Record<WorkflowPhase, number>>;
  roleCounts: Record<"architect" | "developer" | "product", number>;
  activeSubSessions: number;
}

export function Dashboard({ sessions, stats, orchestratorId, projectName }: DashboardProps) {
  const [rateLimitDismissed, setRateLimitDismissed] = useState(false);
  const grouped = useMemo(() => {
    const zones: Record<AttentionLevel, DashboardSession[]> = {
      merge: [],
      respond: [],
      review: [],
      pending: [],
      working: [],
      done: [],
    };
    for (const session of sessions) {
      zones[getAttentionLevel(session)].push(session);
    }
    return zones;
  }, [sessions]);

  const openPRs = useMemo(() => {
    return sessions
      .filter((s): s is DashboardSession & { pr: DashboardPR } => s.pr?.state === "open")
      .map((s) => s.pr)
      .sort((a, b) => mergeScore(a) - mergeScore(b));
  }, [sessions]);

  const handleSend = async (sessionId: string, message: string) => {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) {
      console.error(`Failed to send message to ${sessionId}:`, await res.text());
    }
  };

  const handleKill = async (sessionId: string) => {
    if (!confirm(`Kill session ${sessionId}?`)) return;
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/kill`, {
      method: "POST",
    });
    if (!res.ok) {
      console.error(`Failed to kill ${sessionId}:`, await res.text());
    }
  };

  const handleMerge = async (prNumber: number) => {
    const res = await fetch(`/api/prs/${prNumber}/merge`, { method: "POST" });
    if (!res.ok) {
      console.error(`Failed to merge PR #${prNumber}:`, await res.text());
    }
  };

  const handleRestore = async (sessionId: string) => {
    if (!confirm(`Restore session ${sessionId}?`)) return;
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/restore`, {
      method: "POST",
    });
    if (!res.ok) {
      console.error(`Failed to restore ${sessionId}:`, await res.text());
    }
  };

  const hasKanbanSessions = KANBAN_LEVELS.some((l) => grouped[l].length > 0);

  const anyRateLimited = useMemo(
    () => sessions.some((s) => s.pr && isPRRateLimited(s.pr)),
    [sessions],
  );
  const workflowSummary = useMemo(() => buildSwarmWorkflowSummary(sessions), [sessions]);

  return (
    <div className="px-8 py-7">
      <DynamicFavicon sessions={sessions} projectName={projectName} />
      {/* Header */}
      <div className="mb-8 flex items-center justify-between border-b border-[var(--color-border-subtle)] pb-6">
        <div className="flex items-center gap-6">
          <h1 className="text-[17px] font-semibold tracking-[-0.02em] text-[var(--color-text-primary)]">
            Orchestrator
          </h1>
          <StatusLine stats={stats} />
        </div>
        {orchestratorId && (
          <a
            href={`/sessions/${encodeURIComponent(orchestratorId)}`}
            className="orchestrator-btn flex items-center gap-2 rounded-[7px] px-4 py-2 text-[12px] font-semibold hover:no-underline"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)] opacity-80" />
            orchestrator
            <svg className="h-3 w-3 opacity-70" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
            </svg>
          </a>
        )}
      </div>

      {/* Rate limit notice */}
      {anyRateLimited && !rateLimitDismissed && (
        <div className="mb-6 flex items-center gap-2.5 rounded border border-[rgba(245,158,11,0.25)] bg-[rgba(245,158,11,0.05)] px-3.5 py-2.5 text-[11px] text-[var(--color-status-attention)]">
          <svg className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
          <span className="flex-1">
            GitHub API rate limited — PR data (CI status, review state, sizes) may be stale.
            {" "}Will retry automatically on next refresh.
          </span>
          <button
            onClick={() => setRateLimitDismissed(true)}
            className="ml-1 shrink-0 opacity-60 hover:opacity-100"
            aria-label="Dismiss"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {workflowSummary && <SwarmWorkflowStrip summary={workflowSummary} />}

      {/* Kanban columns for active zones */}
      {hasKanbanSessions && (
        <div className="mb-8 flex gap-4 overflow-x-auto pb-2">
          {KANBAN_LEVELS.map((level) =>
            grouped[level].length > 0 ? (
              <div key={level} className="min-w-[200px] flex-1">
                <AttentionZone
                  level={level}
                  sessions={grouped[level]}
                  variant="column"
                  onSend={handleSend}
                  onKill={handleKill}
                  onMerge={handleMerge}
                  onRestore={handleRestore}
                />
              </div>
            ) : null,
          )}
        </div>
      )}

      {/* Done — full-width grid below Kanban */}
      {grouped.done.length > 0 && (
        <div className="mb-8">
          <AttentionZone
            level="done"
            sessions={grouped.done}
            variant="grid"
            onSend={handleSend}
            onKill={handleKill}
            onMerge={handleMerge}
            onRestore={handleRestore}
          />
        </div>
      )}

      {/* PR Table */}
      {openPRs.length > 0 && (
        <div className="mx-auto max-w-[900px]">
          <h2 className="mb-3 px-1 text-[10px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-tertiary)]">
            Pull Requests
          </h2>
          <div className="overflow-hidden rounded-[6px] border border-[var(--color-border-default)]">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-[var(--color-border-muted)]">
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                    PR
                  </th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                    Title
                  </th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                    Size
                  </th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                    CI
                  </th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                    Review
                  </th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                    Unresolved
                  </th>
                </tr>
              </thead>
              <tbody>
                {openPRs.map((pr) => (
                  <PRTableRow key={pr.number} pr={pr} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function buildSwarmWorkflowSummary(sessions: DashboardSession[]): SwarmWorkflowSummary | null {
  const workflowSessions = sessions.filter(
    (session) => {
      const isTerminal =
        TERMINAL_STATUSES.has(session.status) ||
        (session.activity !== null && TERMINAL_ACTIVITIES.has(session.activity));
      if (isTerminal) return false;
      return session.workflowMode === "full" || (!!session.phase && session.phase !== SESSION_PHASE.NONE);
    },
  );
  if (workflowSessions.length === 0) return null;

  const phaseCounts: Record<WorkflowPhase, number> = {
    [SESSION_PHASE.PLANNING]: 0,
    [SESSION_PHASE.PLAN_REVIEW]: 0,
    [SESSION_PHASE.IMPLEMENTING]: 0,
    [SESSION_PHASE.CODE_REVIEW]: 0,
    [SESSION_PHASE.READY_TO_MERGE]: 0,
  };
  const maxRoundByPhase: Partial<Record<WorkflowPhase, number>> = {};
  const roleCounts: Record<"architect" | "developer" | "product", number> = {
    architect: 0,
    developer: 0,
    product: 0,
  };

  let activeSubSessions = 0;
  for (const session of workflowSessions) {
    const phase = session.phase;
    if (phase && phase in phaseCounts) {
      const phaseKey = phase as WorkflowPhase;
      phaseCounts[phaseKey] += 1;
      const round = getSessionRound(session);
      if (round && round > (maxRoundByPhase[phaseKey] ?? 0)) {
        maxRoundByPhase[phaseKey] = round;
      }
    }

    const role = session.subSessionInfo?.role;
    if (!role) continue;

    roleCounts[role] += 1;
    activeSubSessions += 1;
  }

  return {
    total: workflowSessions.length,
    phaseCounts,
    maxRoundByPhase,
    roleCounts,
    activeSubSessions,
  };
}

function SwarmWorkflowStrip({ summary }: { summary: SwarmWorkflowSummary }) {
  const activePhases = WORKFLOW_PHASE_ORDER.filter((phase) => summary.phaseCounts[phase] > 0);
  const roleEntries = (Object.entries(summary.roleCounts) as Array<
    ["architect" | "developer" | "product", number]
  >).filter(([, count]) => count > 0);

  return (
    <div className="mb-6 rounded-[8px] border border-[rgba(88,166,255,0.18)] bg-[rgba(88,166,255,0.04)] px-4 py-3">
      <div className="mb-2.5 flex items-center gap-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.10em] text-[var(--color-accent)]">
          Swarm Workflow
        </span>
        <span className="text-[11px] text-[var(--color-text-muted)]">
          {summary.total} sessions in full-mode flow
        </span>
      </div>

      {activePhases.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {activePhases.map((phase) => (
            <span
              key={phase}
              className="inline-flex items-center gap-1 rounded-[5px] border border-[rgba(88,166,255,0.25)] bg-[rgba(88,166,255,0.08)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)]"
            >
              <span>{WORKFLOW_PHASE_LABEL[phase]}</span>
              <span className="font-[var(--font-mono)] text-[10px] text-[var(--color-accent)]">
                {summary.phaseCounts[phase]}
              </span>
              {summary.maxRoundByPhase[phase] && (
                <span className="font-[var(--font-mono)] text-[10px] text-[var(--color-text-muted)]">
                  r{summary.maxRoundByPhase[phase]}
                </span>
              )}
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
        <span>active sub-sessions:</span>
        <span className="font-[var(--font-mono)] text-[var(--color-text-secondary)]">
          {summary.activeSubSessions}
        </span>
        {roleEntries.map(([role, count]) => (
          <span
            key={role}
            className="inline-flex items-center gap-1 rounded-[5px] border border-[var(--color-border-subtle)] bg-[rgba(255,255,255,0.04)] px-2 py-0.5"
          >
            <span>{role}</span>
            <span className="font-[var(--font-mono)]">{count}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function StatusLine({ stats }: { stats: DashboardStats }) {
  if (stats.totalSessions === 0) {
    return <span className="text-[13px] text-[var(--color-text-muted)]">no sessions</span>;
  }

  const parts: Array<{ value: number; label: string; color?: string }> = [
    { value: stats.totalSessions, label: "sessions" },
    ...(stats.workingSessions > 0
      ? [{ value: stats.workingSessions, label: "active", color: "var(--color-status-working)" }]
      : []),
    ...(stats.openPRs > 0 ? [{ value: stats.openPRs, label: "PRs" }] : []),
    ...(stats.needsReview > 0
      ? [{ value: stats.needsReview, label: "need review", color: "var(--color-status-attention)" }]
      : []),
  ];

  return (
    <div className="flex items-baseline gap-0.5">
      {parts.map((p, i) => (
        <span key={p.label} className="flex items-baseline">
          {i > 0 && (
            <span className="mx-3 text-[11px] text-[var(--color-border-strong)]">·</span>
          )}
          <span
            className="text-[20px] font-bold tabular-nums tracking-tight"
            style={{ color: p.color ?? "var(--color-text-primary)" }}
          >
            {p.value}
          </span>
          <span className="ml-1.5 text-[11px] text-[var(--color-text-muted)]">
            {p.label}
          </span>
        </span>
      ))}
    </div>
  );
}

function mergeScore(
  pr: Pick<DashboardPR, "ciStatus" | "reviewDecision" | "mergeability" | "unresolvedThreads">,
): number {
  let score = 0;
  if (!pr.mergeability.noConflicts) score += 40;
  if (pr.ciStatus === CI_STATUS.FAILING) score += 30;
  else if (pr.ciStatus === CI_STATUS.PENDING) score += 5;
  if (pr.reviewDecision === "changes_requested") score += 20;
  else if (pr.reviewDecision !== "approved") score += 10;
  score += pr.unresolvedThreads * 5;
  return score;
}
