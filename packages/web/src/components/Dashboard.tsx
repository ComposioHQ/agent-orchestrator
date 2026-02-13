"use client";

import { useMemo } from "react";
import type { DashboardSession, DashboardStats, AttentionLevel } from "@/lib/types";
import { getAttentionLevel } from "@/lib/types";
import { AttentionZone } from "./AttentionZone";
import { PRTableRow } from "./PRStatus";

interface DashboardProps {
  sessions: DashboardSession[];
  stats: DashboardStats;
}

export function Dashboard({ sessions, stats }: DashboardProps) {
  const grouped = useMemo(() => {
    const zones: Record<AttentionLevel, DashboardSession[]> = {
      urgent: [],
      action: [],
      warning: [],
      ok: [],
      done: [],
    };
    for (const session of sessions) {
      zones[getAttentionLevel(session)].push(session);
    }
    return zones;
  }, [sessions]);

  const openPRs = useMemo(() => {
    return sessions
      .filter((s) => s.pr?.state === "open")
      .map((s) => s.pr!)
      .sort((a, b) => mergeScore(a) - mergeScore(b));
  }, [sessions]);

  const handleSend = async (sessionId: string, message: string) => {
    await fetch(`/api/sessions/${sessionId}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
  };

  const handleKill = async (sessionId: string) => {
    if (!confirm(`Kill session ${sessionId}?`)) return;
    await fetch(`/api/sessions/${sessionId}/kill`, { method: "POST" });
  };

  const handleMerge = async (prNumber: number) => {
    if (!confirm(`Merge PR #${prNumber}?`)) return;
    await fetch(`/api/prs/${prNumber}/merge`, { method: "POST" });
  };

  return (
    <div className="mx-auto max-w-[1100px] px-8 py-8">
      {/* Header */}
      <div className="mb-7 flex items-baseline justify-between">
        <h1 className="text-[22px] font-semibold tracking-tight">
          <span className="text-[#7c8aff]">Agent</span> Orchestrator
        </h1>
        <span className="text-xs text-[var(--color-text-muted)]">
          {new Date().toLocaleString()}
        </span>
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
        {(["urgent", "action", "warning", "ok", "done"] as AttentionLevel[]).map((level) => (
          <AttentionZone
            key={level}
            level={level}
            sessions={grouped[level]}
            onSend={handleSend}
            onKill={handleKill}
            onMerge={handleMerge}
          />
        ))}
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
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">PR</th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Title</th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Size</th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">CI</th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Review</th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Unresolved</th>
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

function Stat({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[28px] font-bold" style={{ color }}>{value}</span>
      <span className="text-[13px] text-[var(--color-text-muted)]">{label}</span>
    </div>
  );
}

function mergeScore(pr: { ciStatus: string; reviewDecision: string; mergeability: { noConflicts: boolean }; unresolvedThreads: number }): number {
  let score = 0;
  if (!pr.mergeability.noConflicts) score += 40;
  if (pr.ciStatus === "failing") score += 30;
  else if (pr.ciStatus === "pending") score += 5;
  if (pr.reviewDecision === "changes_requested") score += 20;
  else if (pr.reviewDecision !== "approved") score += 10;
  score += pr.unresolvedThreads * 5;
  return score;
}
