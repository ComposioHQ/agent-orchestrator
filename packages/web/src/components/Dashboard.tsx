"use client";

import { useMemo, useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  type DashboardSession,
  type DashboardStats,
  type DashboardPR,
  type AttentionLevel,
  type ViewMode,
  type Command,
  getAttentionLevel,
  isPRRateLimited,
} from "@/lib/types";
import { type PipelineStage, getPipelineStage } from "@/lib/pipeline";
import { CI_STATUS } from "@composio/ao-core/types";
import { AttentionZone } from "./AttentionZone";
import { PRTableRow } from "./PRStatus";
import { DynamicFavicon } from "./DynamicFavicon";
import { PipelineStrip } from "./PipelineStrip";
import { MetricsBar } from "./MetricsBar";
import { CommandPalette } from "./CommandPalette";
import { SpawnDialog } from "./SpawnDialog";
import { ViewToggle } from "./ViewToggle";
import { SessionRow } from "./SessionRow";
import { IssueQueue } from "./IssueQueue";
import type { DashboardIssue } from "@/app/api/issues/route";
import { useSessionEvents } from "@/hooks/useSessionEvents";
import { useCommandPalette } from "@/hooks/useCommandPalette";
import { useKeyboardNavigation } from "@/hooks/useKeyboardNavigation";

interface DashboardProps {
  initialSessions: DashboardSession[];
  stats: DashboardStats;
  orchestratorId?: string | null;
  projectName?: string;
  extraPRs?: DashboardPR[];
  issues?: DashboardIssue[];
}

const BOARD_LEVELS: AttentionLevel[] = ["merge", "respond", "review", "pending", "working", "done"];

export function Dashboard({ initialSessions, stats: _stats, orchestratorId, projectName, extraPRs, issues = [] }: DashboardProps) {
  const router = useRouter();
  const sessions = useSessionEvents(initialSessions);
  const [rateLimitDismissed, setRateLimitDismissed] = useState(false);
  const [view, setView] = useState<ViewMode>("board");
  const [pipelineFilter, setPipelineFilter] = useState<PipelineStage | null>(null);
  const [spawnOpen, setSpawnOpen] = useState(false);
  const palette = useCommandPalette();

  // ── Filter sessions by pipeline stage ──────────────────────────────
  const filteredSessions = useMemo(() => {
    if (!pipelineFilter) return sessions;
    return sessions.filter((s) => getPipelineStage(s) === pipelineFilter);
  }, [sessions, pipelineFilter]);

  // ── Group by attention level ───────────────────────────────────────
  const grouped = useMemo(() => {
    const zones: Record<AttentionLevel, DashboardSession[]> = {
      merge: [],
      respond: [],
      review: [],
      pending: [],
      working: [],
      done: [],
    };
    for (const session of filteredSessions) {
      zones[getAttentionLevel(session)].push(session);
    }
    return zones;
  }, [filteredSessions]);

  // ── Flat list for list view + keyboard nav ─────────────────────────
  const flatSessions = useMemo(() => {
    const result: DashboardSession[] = [];
    for (const level of BOARD_LEVELS) {
      result.push(...grouped[level]);
    }
    return result;
  }, [grouped]);

  // ── Open PRs for table ─────────────────────────────────────────────
  const { openPRs, unlinkedPRKeys } = useMemo(() => {
    const sessionPRs = sessions
      .filter((s): s is DashboardSession & { pr: DashboardPR } => s.pr?.state === "open")
      .map((s) => s.pr);
    // Track which PRs are linked to sessions
    const linkedKeys = new Set(sessionPRs.map((pr) => `${pr.owner}/${pr.repo}#${pr.number}`));
    const all = [...sessionPRs, ...(extraPRs ?? [])];
    // Deduplicate by number+repo, keep only open PRs
    const seen = new Set<string>();
    const unique = all.filter((pr) => {
      if (pr.state !== "open") return false;
      const key = `${pr.owner}/${pr.repo}#${pr.number}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // Unlinked = in the final list but not linked to any session
    const unlinked = new Set(
      unique
        .map((pr) => `${pr.owner}/${pr.repo}#${pr.number}`)
        .filter((key) => !linkedKeys.has(key)),
    );
    return {
      openPRs: unique.sort((a, b) => mergeScore(a) - mergeScore(b)),
      unlinkedPRKeys: unlinked,
    };
  }, [sessions, extraPRs]);

  // ── Actions ────────────────────────────────────────────────────────
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

  const handleAssign = async (issueId: string) => {
    const res = await fetch(`/api/issues/${encodeURIComponent(issueId)}/assign`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: undefined }),
    });
    if (!res.ok) {
      console.error(`Failed to assign issue ${issueId}:`, await res.text());
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

  const handleAdopt = async (prNumber: number, prUrl: string, branch: string) => {
    const res = await fetch(`/api/prs/${prNumber}/adopt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prUrl, branch }),
    });
    if (!res.ok) {
      console.error(`Failed to adopt PR #${prNumber}:`, await res.text());
      return;
    }
    router.refresh();
  };

  // ── Keyboard navigation ────────────────────────────────────────────
  const handleSelectSession = useCallback(
    (index: number) => {
      const session = flatSessions[index];
      if (session) {
        router.push(`/sessions/${encodeURIComponent(session.id)}`);
      }
    },
    [flatSessions, router],
  );

  const handleKeyAction = useCallback(
    (key: string, index: number) => {
      const session = flatSessions[index];
      if (!session) return;
      if (key === "m" && session.pr?.mergeability.mergeable && session.pr.state === "open") {
        handleMerge(session.pr.number);
      } else if (key === "x") {
        handleKill(session.id);
      }
    },
    [flatSessions],
  );

  const { selectedIndex } = useKeyboardNavigation({
    itemCount: flatSessions.length,
    onSelect: handleSelectSession,
    onAction: handleKeyAction,
    enabled: !palette.isOpen && !spawnOpen,
  });

  const selectedSessionId = selectedIndex >= 0 ? flatSessions[selectedIndex]?.id ?? null : null;

  // ── Command palette commands ───────────────────────────────────────
  const commands = useMemo<Command[]>(() => {
    const cmds: Command[] = [
      {
        id: "spawn",
        label: "Spawn agent",
        shortcut: "\u2318N",
        section: "actions",
        icon: "+",
        action: () => setSpawnOpen(true),
      },
      {
        id: "issues",
        label: "Issues",
        section: "navigation",
        icon: "\u2630",
        action: () => router.push("/issues"),
      },
      {
        id: "settings",
        label: "Settings",
        shortcut: "\u2318,",
        section: "navigation",
        icon: "\u2699",
        action: () => router.push("/settings"),
      },
      {
        id: "toggle-view",
        label: `Switch to ${view === "board" ? "list" : "board"} view`,
        shortcut: "\u2318\\",
        section: "navigation",
        icon: view === "board" ? "\u2261" : "\u25a6",
        action: () => setView(view === "board" ? "list" : "board"),
      },
    ];

    if (orchestratorId) {
      cmds.push({
        id: "orchestrator",
        label: "Go to orchestrator",
        shortcut: "\u2318O",
        section: "navigation",
        icon: "\u25c9",
        action: () => router.push(`/sessions/${encodeURIComponent(orchestratorId)}`),
      });
    }

    // Session jump commands
    for (const session of sessions.slice(0, 20)) {
      cmds.push({
        id: `session-${session.id}`,
        label: `${session.id}`,
        section: "sessions",
        action: () => router.push(`/sessions/${encodeURIComponent(session.id)}`),
      });
    }

    return cmds;
  }, [sessions, orchestratorId, view, router]);

  // ── Global shortcuts ───────────────────────────────────────────────
  useGlobalShortcuts({
    onSpawn: () => setSpawnOpen(true),
    onSettings: () => router.push("/settings"),
    onOrchestrator: orchestratorId
      ? () => router.push(`/sessions/${encodeURIComponent(orchestratorId)}`)
      : undefined,
    onToggleView: () => setView((v) => (v === "board" ? "list" : "board")),
    enabled: !palette.isOpen && !spawnOpen,
  });

  const anyRateLimited = useMemo(
    () => sessions.some((s) => s.pr && isPRRateLimited(s.pr)),
    [sessions],
  );

  const hasActiveSessions = BOARD_LEVELS.slice(0, -1).some((l) => grouped[l].length > 0);

  return (
    <div className="min-h-screen flex flex-col">
      <DynamicFavicon sessions={sessions} projectName={projectName} />
      <CommandPalette isOpen={palette.isOpen} onClose={palette.close} commands={commands} />
      <SpawnDialog isOpen={spawnOpen} onClose={() => setSpawnOpen(false)} />

      {/* ── Zone 1: Command Bar + Metrics (sticky) ────────────────── */}
      <header className="nav-glass sticky top-0 z-30 border-b border-[var(--color-border-subtle)]">
        <div className="px-6 py-3 sm:px-8">
          <div className="flex items-center gap-4">
            {/* Logo + project */}
            <div className="flex items-center gap-3">
              <h1 className="text-[15px] font-semibold tracking-[-0.02em] text-[var(--color-text-primary)]">
                {projectName || "ao"}
              </h1>
            </div>

            {/* Metrics */}
            <div className="hidden sm:block">
              <MetricsBar sessions={sessions} />
            </div>

            <div className="flex-1" />

            {/* Actions */}
            <div className="flex items-center gap-2">
              {/* Command palette trigger */}
              <button
                onClick={palette.toggle}
                className="flex items-center gap-1.5 rounded-[6px] border border-[var(--color-border-default)] bg-[var(--color-bg-subtle)] px-2.5 py-1.5 text-[11px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-secondary)]"
              >
                <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <circle cx="11" cy="11" r="8" />
                  <path d="M21 21l-4.35-4.35" />
                </svg>
                <span className="hidden sm:inline">Search</span>
                <kbd className="ml-1 rounded border border-[var(--color-border-subtle)] px-1 py-0 text-[9px]">{"\u2318"}K</kbd>
              </button>

              {/* Settings */}
              <a
                href="/settings"
                className="flex items-center gap-1.5 rounded-[6px] px-2.5 py-1.5 text-[11px] font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:no-underline transition-colors"
              >
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </a>

              {/* Orchestrator */}
              {orchestratorId && (
                <a
                  href={`/sessions/${encodeURIComponent(orchestratorId)}`}
                  className="orchestrator-btn flex items-center gap-2 rounded-[7px] px-3 py-1.5 text-[11px] font-semibold hover:no-underline"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)] opacity-80" />
                  orchestrator
                </a>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* ── Zone 2: Pipeline Strip ────────────────────────────────── */}
      <div className="border-b border-[var(--color-border-subtle)] px-6 py-3 sm:px-8">
        <PipelineStrip
          sessions={sessions}
          activeFilter={pipelineFilter}
          onFilterStage={setPipelineFilter}
        />
      </div>

      {/* ── Zone 2b: Issue Queue ─────────────────────────────────── */}
      {issues.length > 0 && (
        <div className="px-6 pt-4 sm:px-8">
          <IssueQueue issues={issues} onAssign={handleAssign} />
        </div>
      )}

      {/* ── Rate limit notice ─────────────────────────────────────── */}
      {anyRateLimited && !rateLimitDismissed && (
        <div className="mx-6 mt-4 sm:mx-8">
          <div className="flex items-center gap-2.5 rounded border border-[rgba(245,158,11,0.25)] bg-[rgba(245,158,11,0.05)] px-3.5 py-2.5 text-[11px] text-[var(--color-status-attention)]">
            <svg className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4M12 16h.01" />
            </svg>
            <span className="flex-1">
              GitHub API rate limited — PR data may be stale. Will retry automatically.
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
        </div>
      )}

      {/* ── Zone 3: Session List (scrollable) ─────────────────────── */}
      <main className="flex-1 px-6 py-5 sm:px-8">
        {/* View toggle + filter indicator */}
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <ViewToggle view={view} onChange={setView} />
            {pipelineFilter && (
              <button
                onClick={() => setPipelineFilter(null)}
                className="flex items-center gap-1 rounded-full border border-[var(--color-border-default)] bg-[var(--color-bg-subtle)] px-2.5 py-1 text-[10px] font-medium text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-border-strong)]"
              >
                Filtered: {pipelineFilter}
                <svg className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
          <span className="text-[11px] text-[var(--color-text-muted)]">
            {filteredSessions.length} session{filteredSessions.length !== 1 ? "s" : ""}
            {pipelineFilter ? ` in ${pipelineFilter}` : ""}
          </span>
        </div>

        {/* Board view */}
        {view === "board" && (
          <>
            {hasActiveSessions && (
              <div className="space-y-0">
                {BOARD_LEVELS.slice(0, -1).map((level) =>
                  grouped[level].length > 0 ? (
                    <AttentionZone
                      key={level}
                      level={level}
                      sessions={grouped[level]}
                      variant="row"
                      selectedSessionId={selectedSessionId}
                      onSend={handleSend}
                      onKill={handleKill}
                      onMerge={handleMerge}
                      onRestore={handleRestore}
                    />
                  ) : null,
                )}
              </div>
            )}
            {grouped.done.length > 0 && (
              <AttentionZone
                level="done"
                sessions={grouped.done}
                variant="grid"
                selectedSessionId={selectedSessionId}
                onSend={handleSend}
                onKill={handleKill}
                onMerge={handleMerge}
                onRestore={handleRestore}
              />
            )}
          </>
        )}

        {/* List view */}
        {view === "list" && (
          <div className="rounded-[8px] border border-[var(--color-border-default)] overflow-hidden">
            {/* Table header */}
            <div className="flex items-center gap-3 border-b border-[var(--color-border-default)] bg-[var(--color-bg-subtle)] px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
              <span className="w-[14px]" />
              <span className="w-[80px]">ID</span>
              <span className="flex-1">Title</span>
              <span className="w-[56px] text-center">Stage</span>
              <span className="w-[40px] text-center">PR</span>
              <span className="w-[20px] text-center">CI</span>
              <span className="w-[20px] text-center">Rev</span>
              <span className="w-[32px] text-right">Time</span>
              <span className="w-[60px]" />
            </div>
            {flatSessions.length === 0 ? (
              <div className="px-4 py-8 text-center text-[13px] text-[var(--color-text-muted)]">
                No sessions{pipelineFilter ? ` in ${pipelineFilter} stage` : ""}
              </div>
            ) : (
              flatSessions.map((session, i) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  isSelected={i === selectedIndex}
                  onSend={handleSend}
                  onKill={handleKill}
                  onMerge={handleMerge}
                  onRestore={handleRestore}
                />
              ))
            )}
          </div>
        )}

        {/* PR Table */}
        {openPRs.length > 0 && (
          <div className="mx-auto mt-8 max-w-[900px]">
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
                    <th className="w-[60px] px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {openPRs.map((pr) => {
                    const prKey = `${pr.owner}/${pr.repo}#${pr.number}`;
                    return (
                      <PRTableRow
                        key={prKey}
                        pr={pr}
                        onAdopt={unlinkedPRKeys.has(prKey) ? handleAdopt : undefined}
                      />
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

// ── Global shortcuts hook ──────────────────────────────────────────────

function useGlobalShortcuts({
  onSpawn,
  onSettings,
  onOrchestrator,
  onToggleView,
  enabled,
}: {
  onSpawn: () => void;
  onSettings: () => void;
  onOrchestrator?: () => void;
  onToggleView: () => void;
  enabled: boolean;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!enabled) return;
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        onSpawn();
      } else if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        onSettings();
      } else if ((e.metaKey || e.ctrlKey) && e.key === "o" && onOrchestrator) {
        e.preventDefault();
        onOrchestrator();
      } else if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        onToggleView();
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onSpawn, onSettings, onOrchestrator, onToggleView, enabled]);
}

// ── PR merge scoring ────────────────────────────────────────────────────

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
