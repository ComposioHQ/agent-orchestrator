"use client";

import { useMemo, useState, useEffect } from "react";
import {
  type DashboardSession,
  type DashboardStats,
  type DashboardPR,
  type AttentionLevel,
  getAttentionLevel,
} from "@/lib/types";
import { CI_STATUS } from "@composio/ao-core/types";
import { AttentionZone } from "./AttentionZone";
import { PRTableRow } from "./PRStatus";
import { DynamicFavicon } from "./DynamicFavicon";

interface DashboardProps {
  sessions: DashboardSession[];
  stats: DashboardStats;
  orchestratorId?: string | null;
  projectName?: string;
}

export function Dashboard({ sessions, stats, orchestratorId, projectName }: DashboardProps) {
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
    if (!confirm(`Merge PR #${prNumber}?`)) return;
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

  return (
    <div className="mx-auto max-w-[1100px] px-8 py-8">
      <DynamicFavicon sessions={sessions} projectName={projectName} />
      {/* Header */}
      <div className="mb-7 flex items-baseline justify-between">
        <h1 className="text-[22px] font-semibold tracking-tight">
          <span className="text-[#7c8aff]">Agent</span> Orchestrator
        </h1>
        <div className="flex items-baseline gap-4">
          {orchestratorId && (
            <a
              href={`/sessions/${encodeURIComponent(orchestratorId)}`}
              className="rounded-md border border-[var(--color-border-default)] px-3 py-1 text-[11px] text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-accent-blue)] hover:text-[var(--color-accent-blue)]"
            >
              orchestrator terminal
            </a>
          )}
          <ClientTimestamp />
        </div>
      </div>

      {/* Stats bar */}
      <div className="mb-9 flex gap-8 px-1">
        <Stat value={stats.totalSessions} label="sessions" color="var(--color-accent-blue)" />
        <Stat value={stats.workingSessions} label="working" color="var(--color-accent-green)" />
        <Stat value={stats.openPRs} label="open PRs" color="var(--color-accent-violet)" />
        <Stat value={stats.needsReview} label="need review" color="var(--color-accent-yellow)" />
      </div>

      {/* Attention zones */}
      <div className="mb-9">
        <h2 className="mb-3 px-1 text-[13px] font-semibold uppercase tracking-widest text-[var(--color-text-muted)]">
          Sessions
        </h2>
        {(["merge", "respond", "review", "pending", "working", "done"] as AttentionLevel[]).map(
          (level) => (
            <AttentionZone
              key={level}
              level={level}
              sessions={grouped[level]}
              onSend={handleSend}
              onKill={handleKill}
              onMerge={handleMerge}
              onRestore={handleRestore}
            />
          ),
        )}
      </div>

      {/* PR Table */}
      {openPRs.length > 0 && (
        <div>
          <h2 className="mb-3 px-1 text-[13px] font-semibold uppercase tracking-widest text-[var(--color-text-muted)]">
            Pull Requests
          </h2>
          <div className="overflow-hidden rounded-lg border border-[var(--color-border-default)]">
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

/** Renders timestamp client-side only to avoid hydration mismatch. */
function ClientTimestamp() {
  const [time, setTime] = useState<string>("");
  useEffect(() => {
    setTime(new Date().toLocaleString());
  }, []);
  return <span className="text-xs text-[var(--color-text-muted)]">{time}</span>;
}

function Stat({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[28px] font-bold" style={{ color }}>
        {value}
      </span>
      <span className="text-[13px] text-[var(--color-text-muted)]">{label}</span>
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
