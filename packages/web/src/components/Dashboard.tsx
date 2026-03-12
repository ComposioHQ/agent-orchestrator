"use client";

import { useEffect, useMemo, useState } from "react";
import {
  type DashboardSession,
  type DashboardStats,
  type DashboardPR,
  type AttentionLevel,
  type GlobalPauseState,
  type DashboardOrchestratorLink,
  type DispatchPlanItem,
  type HarnessSnapshot,
  getAttentionLevel,
  isPRRateLimited,
  isPRMergeReady,
} from "@/lib/types";
import { DynamicFavicon } from "./DynamicFavicon";
import { PRTableRow } from "./PRStatus";
import { useSessionEvents } from "@/hooks/useSessionEvents";
import { ProjectSidebar } from "./ProjectSidebar";
import type { ProjectInfo } from "@/lib/project-name";
import { DirectTerminal } from "./DirectTerminal";
import { AttentionZone } from "./AttentionZone";

interface DashboardProps {
  initialSessions: DashboardSession[];
  projectId?: string;
  projectName?: string;
  projects?: ProjectInfo[];
  initialGlobalPause?: GlobalPauseState | null;
  orchestrators?: DashboardOrchestratorLink[];
  dispatchPlan: DispatchPlanItem[];
  harness: HarnessSnapshot;
  defaultProjectId?: string | null;
}

type Action = "dispatch" | "send" | "restore" | "review" | "escalate" | "merge" | "kill" | "hold";
type Mode = "work" | "terminal";
type Answer = { state: string; blocker: string; allowedActions: Action[]; recommendedAction: Action; evidence: string[] };
type Work = {
  workId: string;
  title: string;
  status: string;
  reason: string;
  recommendedAction: Action;
  allowedActions: Action[];
  activeSessionId: string | null;
  evidence: string[];
  priority: number;
  scoreBand: string | null;
};

const ACTIONS: Action[] = ["dispatch", "send", "restore", "review", "escalate", "merge", "kill", "hold"];

function normalizeAction(raw: string | null | undefined): Action {
  const text = (raw ?? "").toLowerCase();
  if (ACTIONS.includes(text as Action)) return text as Action;
  if (text.includes("merge")) return "merge";
  if (text.includes("send") || text.includes("input")) return "send";
  if (text.includes("restore")) return "restore";
  if (text.includes("dispatch")) return "dispatch";
  if (text.includes("review")) return "review";
  if (text.includes("escalate")) return "escalate";
  if (text.includes("kill")) return "kill";
  return "hold";
}

export function Dashboard({
  initialSessions,
  projectId,
  projectName,
  projects = [],
  initialGlobalPause = null,
  orchestrators = [],
  dispatchPlan,
  harness,
  defaultProjectId,
}: DashboardProps) {
  const { sessions, globalPause } = useSessionEvents(
    initialSessions,
    initialGlobalPause,
    projectId,
  );
  const [rateLimitDismissed, setRateLimitDismissed] = useState(false);
  const [globalPauseDismissed, setGlobalPauseDismissed] = useState(false);
  const showSidebar = projects.length > 1;
  const allProjectsView = showSidebar && projectId === undefined;

  const sessionById = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);

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

  const KANBAN_LEVELS: AttentionLevel[] = ["merge", "respond", "review", "pending", "working"];

  const mergeScore = (pr: DashboardPR) => {
    let score = 0;
    if (pr.mergeability.mergeable) score += 100;
    if (pr.mergeability.ciPassing) score += 10;
    if (pr.mergeability.approved) score += 10;
    if (pr.mergeability.noConflicts) score += 10;
    return -score;
  };

  const openPRs = useMemo(() => {
    return sessions
      .filter(
        (session): session is DashboardSession & { pr: DashboardPR } =>
          session.pr?.state === "open",
      )
      .map((session) => session.pr)
      .sort((a, b) => mergeScore(a) - mergeScore(b));
  }, [sessions]);

  const works = useMemo<Work[]>(() => {
    const workState = new Map(harness.workState.map((w) => [w.work_id, w]));
    const recState = new Map(harness.reconciliationState.map((r) => [r.work_id, r]));
    const scores = new Map(harness.scoreSummaryByTicket.map((s) => [s.subject_id, s]));
    const plannedWorks = dispatchPlan
      .map((d) => {
        const w = workState.get(d.work_id);
        const r = recState.get(d.work_id);
        const s = scores.get(d.work_id);
        const activeSessionId = w?.active_session_id ?? r?.active_session_id ?? null;
        const active = activeSessionId ? sessionById.get(activeSessionId) ?? null : null;
        const recommendedAction = normalizeAction(r?.next_action ?? d.next_action);
        const dynamicActions: Action[] = active
          ? [
              "send",
              "kill",
              ...(active.activity === "exited" ? (["restore"] as Action[]) : []),
              ...(active.pr?.mergeability.mergeable ? (["merge"] as Action[]) : []),
            ]
          : ["dispatch"];
        const allowedActions = Array.from(new Set<Action>([recommendedAction, ...dynamicActions]));
        return {
          workId: d.work_id,
          title: active?.issueTitle ?? active?.issueLabel ?? d.work_id,
          status: w?.work_status ?? d.work_status,
          reason: r?.reason ?? d.reason,
          recommendedAction,
          allowedActions,
          activeSessionId,
          evidence: [r?.reason ?? d.reason, d.latest_decision_id ?? "", d.latest_scorecard_id ?? ""].filter(Boolean),
          priority: d.priority,
          scoreBand: s?.score_band ?? null,
        } satisfies Work;
      })
      .sort((a, b) => b.priority - a.priority);
    if (plannedWorks.length > 0) {
      return plannedWorks;
    }

    // Fallback for non-harness environments: build actionable work cards from live sessions.
    const priorityByAttention: Record<AttentionLevel, number> = {
      merge: 100,
      respond: 90,
      review: 80,
      pending: 50,
      working: 40,
      done: 10,
    };

    const actionByAttention: Record<AttentionLevel, Action> = {
      merge: "merge",
      respond: "send",
      review: "review",
      pending: "hold",
      working: "hold",
      done: "hold",
    };

    return sessions
      .map((s) => {
        const attention = getAttentionLevel(s);
        const recommendedAction = actionByAttention[attention];
        const baseActions: Action[] = ["send", "kill"];
        if (s.activity === "exited") baseActions.push("restore");
        if (s.pr && isPRMergeReady(s.pr)) baseActions.push("merge");
        const allowedActions = Array.from(new Set<Action>([recommendedAction, ...baseActions]));
        const reason =
          s.issueTitle ??
          s.summary ??
          (s.pr ? `PR #${s.pr.number} ${s.pr.title}` : `session ${s.id} is ${attention}`);
        return {
          workId: s.id,
          title: s.issueTitle ?? s.issueLabel ?? s.summary ?? s.id,
          status: s.status,
          reason,
          recommendedAction,
          allowedActions,
          activeSessionId: s.id,
          evidence: [s.issueLabel ?? "", s.pr?.url ?? "", s.branch ?? ""].filter(Boolean),
          priority: priorityByAttention[attention],
          scoreBand: null,
        } satisfies Work;
      })
      .sort((a, b) => b.priority - a.priority);
  }, [dispatchPlan, harness.reconciliationState, harness.scoreSummaryByTicket, harness.workState, sessionById, sessions]);

  const [selectedWorkId, setSelectedWorkId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("work");
  const [command, setCommand] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const selectedWork = useMemo(() => works.find((w) => w.workId === selectedWorkId) ?? works[0] ?? null, [works, selectedWorkId]);
  const selectedSession = selectedWork?.activeSessionId ? sessionById.get(selectedWork.activeSessionId) ?? null : null;

  // Find the first orchestrator id for the current project
  const orchestratorId = orchestrators.length > 0 ? orchestrators[0].id : null;

  useEffect(() => {
    if (!selectedWorkId && works[0]) setSelectedWorkId(works[0].workId);
  }, [selectedWorkId, works]);

  const runAction = async (work: Work, action: Action) => {
    if (!work.allowedActions.includes(action)) throw new Error(`Action not allowed: ${action}`);
    if (action === "dispatch") {
      const pid = sessions[0]?.projectId ?? defaultProjectId ?? null;
      if (!pid) throw new Error("No projectId for dispatch");
      const r = await fetch("/api/spawn", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: pid, issueId: work.workId }) });
      if (!r.ok) throw new Error(await r.text());
    } else if (action === "merge") {
      const pr = work.activeSessionId ? sessionById.get(work.activeSessionId)?.pr : null;
      if (!pr) throw new Error("No PR to merge");
      const r = await fetch(`/api/prs/${pr.number}/merge`, { method: "POST" });
      if (!r.ok) throw new Error(await r.text());
    } else {
      const sessionId = action === "escalate" || action === "review" || action === "hold" ? orchestratorId : work.activeSessionId;
      if (!sessionId) throw new Error("No target session");
      const path = action === "restore" ? "restore" : action === "kill" ? "kill" : "send";
      const body = path === "send" ? { message: `work ${work.workId} action=${action} reason=${work.reason}` } : undefined;
      const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/${path}`, {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!r.ok) throw new Error(await r.text());
    }
    setAnswer({
      state: work.status,
      blocker: work.reason,
      allowedActions: work.allowedActions,
      recommendedAction: work.recommendedAction,
      evidence: work.evidence,
    });
  };

  const runCommand = async () => {
    const [cmd, arg1, arg2] = command.trim().split(/\s+/);
    if (!cmd) return;
    const current = arg1 ? works.find((w) => w.workId === arg1) ?? null : selectedWork;
    if (!current && !["next", "dispatch", "spawn", "session"].includes(cmd)) return;
    setBusy(true);
    try {
      if (cmd === "next") {
        if (!works[0]) throw new Error("No work");
        setSelectedWorkId(works[0].workId);
        setMode("work");
        setAnswer({ state: works[0].status, blocker: works[0].reason, allowedActions: works[0].allowedActions, recommendedAction: works[0].recommendedAction, evidence: works[0].evidence });
      } else if (cmd === "dispatch" || cmd === "spawn") {
        const issueId = arg1 ?? selectedWork?.workId;
        if (!issueId) throw new Error("Missing issue id");
        const pid = sessions[0]?.projectId ?? defaultProjectId ?? null;
        if (!pid) throw new Error("No project configured for dispatch");
        const r = await fetch("/api/spawn", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: pid, issueId }),
        });
        if (!r.ok) throw new Error(await r.text());
        setAnswer({
          state: "spawned",
          blocker: "none",
          allowedActions: ["send", "kill", "restore"],
          recommendedAction: "send",
          evidence: [`project=${pid}`, `issue=${issueId}`],
        });
      } else if (cmd === "explain" || cmd === "status" || cmd === "diff") {
        if (!current) throw new Error("Unknown work");
        setSelectedWorkId(current.workId);
        setAnswer({ state: current.status, blocker: current.reason, allowedActions: current.allowedActions, recommendedAction: current.recommendedAction, evidence: cmd === "diff" ? [`changed-since-last-run unavailable`, ...current.evidence] : current.evidence });
      } else if (cmd === "act") {
        if (!current) throw new Error("Unknown work");
        await runAction(current, normalizeAction(arg2));
      } else if (cmd === "session") {
        const sid = arg1 ?? selectedWork?.activeSessionId;
        if (!sid) throw new Error("Missing session-id");
        setMode("terminal");
        setAnswer({ state: sessionById.get(sid)?.status ?? "unknown", blocker: "none", allowedActions: ["send", "restore", "kill"], recommendedAction: "send", evidence: [`session:${sid}`] });
      } else {
        throw new Error("Unknown command");
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "failed";
      setAnswer({ state: "error", blocker: message, allowedActions: [], recommendedAction: "hold", evidence: [message] });
    } finally {
      setBusy(false);
    }
  };

  const projectOverviews = useMemo(() => {
    if (!allProjectsView) return [];

    return projects.map((project) => {
      const projectSessions = sessions.filter((session) => session.projectId === project.id);
      const counts: Record<AttentionLevel, number> = {
        merge: 0,
        respond: 0,
        review: 0,
        pending: 0,
        working: 0,
        done: 0,
      };

      for (const session of projectSessions) {
        counts[getAttentionLevel(session)]++;
      }

      return {
        project,
        orchestrator:
          orchestrators.find((orchestrator) => orchestrator.projectId === project.id) ?? null,
        sessionCount: projectSessions.length,
        openPRCount: projectSessions.filter((session) => session.pr?.state === "open").length,
        counts,
      };
    });
  }, [allProjectsView, orchestrators, projects, sessions]);

  const handleSend = async (sessionId: string, message: string) => {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) {
      console.error(`Failed to send to ${sessionId}:`, await res.text());
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

  const hasKanbanSessions = KANBAN_LEVELS.some((level) => grouped[level].length > 0);

  const anyRateLimited = useMemo(
    () => sessions.some((session) => session.pr && isPRRateLimited(session.pr)),
    [sessions],
  );

  const liveStats = useMemo<DashboardStats>(
    () => ({
      totalSessions: sessions.length,
      workingSessions: sessions.filter(
        (session) => session.activity !== null && session.activity !== "exited",
      ).length,
      openPRs: sessions.filter((session) => session.pr?.state === "open").length,
      needsReview: sessions.filter(
        (session) => session.pr && !session.pr.isDraft && session.pr.reviewDecision === "pending",
      ).length,
    }),
    [sessions],
  );

  const resumeAtLabel = useMemo(() => {
    if (!globalPause) return null;
    return new Date(globalPause.pausedUntil).toLocaleString();
  }, [globalPause]);

  useEffect(() => {
    setGlobalPauseDismissed(false);
  }, [globalPause?.pausedUntil, globalPause?.reason, globalPause?.sourceSessionId]);

  const focus = works[0] ?? null;
  const needsDecision = works.find((w) => w.allowedActions.includes("merge") || w.allowedActions.includes("kill")) ?? null;
  const needsInput = works.find((w) => w.recommendedAction === "send") ?? null;
  const blocked = works.find((w) => /policy|blocked|forbid/i.test(w.reason)) ?? null;
  const mergeReady = works.find((w) => w.allowedActions.includes("merge")) ?? null;
  const needsReconcile = works.find((w) => w.reason.toLowerCase().includes("reconcile")) ?? null;
  const inbox = [
    { label: "Focus Work", work: focus },
    { label: "Needs Decision", work: needsDecision },
    { label: "Needs Input", work: needsInput },
    { label: "Blocked by Policy", work: blocked },
    { label: "Merge Ready", work: mergeReady },
    { label: "Needs Reconcile", work: needsReconcile },
  ];

  return (
    <div className="flex h-screen">
      {showSidebar && <ProjectSidebar projects={projects} activeProjectId={projectId} />}
      <div className="flex-1 overflow-y-auto px-8 py-7">
        <DynamicFavicon sessions={sessions} projectName={projectName} />
        <div className="mb-8 flex items-center justify-between border-b border-[var(--color-border-subtle)] pb-6">
          <div className="flex items-center gap-6">
            <h1 className="text-[17px] font-semibold tracking-[-0.02em] text-[var(--color-text-primary)]">
              {projectName ?? "Orchestrator"}
            </h1>
            <StatusLine stats={liveStats} />
          </div>
          {!allProjectsView && <OrchestratorControl orchestrators={orchestrators} />}
        </div>

        {globalPause && !globalPauseDismissed && (
          <div className="mb-6 flex items-center gap-2.5 rounded border border-[rgba(239,68,68,0.25)] bg-[rgba(239,68,68,0.05)] px-3.5 py-2.5 text-[11px] text-[var(--color-status-error)]">
            <svg
              className="h-3.5 w-3.5 shrink-0"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4M12 16h.01" />
            </svg>
            <span className="flex-1">
              <strong>Orchestrator paused:</strong> {globalPause.reason}
              {resumeAtLabel && (
                <span className="ml-2 opacity-75">Resume after {resumeAtLabel}</span>
              )}
              {globalPause.sourceSessionId && (
                <span className="ml-2 opacity-75">(Source: {globalPause.sourceSessionId})</span>
              )}
            </span>
            <button
              onClick={() => setGlobalPauseDismissed(true)}
              className="ml-1 shrink-0 opacity-60 hover:opacity-100"
              aria-label="Dismiss"
            >
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                viewBox="0 0 24 24"
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}

        {anyRateLimited && !rateLimitDismissed && (
          <div className="mb-6 flex items-center gap-2.5 rounded border border-[rgba(245,158,11,0.25)] bg-[rgba(245,158,11,0.05)] px-3.5 py-2.5 text-[11px] text-[var(--color-status-attention)]">
            <svg
              className="h-3.5 w-3.5 shrink-0"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4M12 16h.01" />
            </svg>
            <span className="flex-1">
              GitHub API rate limited — PR data (CI status, review state, sizes) may be stale. Will
              retry automatically on next refresh.
            </span>
            <button
              onClick={() => setRateLimitDismissed(true)}
              className="ml-1 shrink-0 opacity-60 hover:opacity-100"
              aria-label="Dismiss"
            >
              <svg
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                viewBox="0 0 24 24"
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}

        {allProjectsView && <ProjectOverviewGrid overviews={projectOverviews} />}

        {!allProjectsView && hasKanbanSessions && (
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

        {!allProjectsView && grouped.done.length > 0 && (
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

        {/* Work-first harness control panel */}
        {works.length > 0 && (
          <div className="mt-8 rounded-[10px] border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-4">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-[14px] font-semibold text-[var(--color-text-primary)]">Work Queue</h2>
              <div className="flex gap-2">
                <button type="button" onClick={() => setMode("work")} className={`px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.08em] rounded ${mode === "work" ? "bg-[var(--color-text-primary)] text-[var(--color-bg-surface)]" : "border border-[var(--color-border-default)] text-[var(--color-text-muted)]"}`}>work</button>
                <button type="button" onClick={() => setMode("terminal")} className={`px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.08em] rounded ${mode === "terminal" ? "bg-[var(--color-text-primary)] text-[var(--color-bg-surface)]" : "border border-[var(--color-border-default)] text-[var(--color-text-muted)]"}`}>terminal</button>
              </div>
            </div>
            <div className="flex gap-4">
              <div className="w-[280px] shrink-0 space-y-2 overflow-y-auto max-h-[400px]">
                {inbox.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => item.work && setSelectedWorkId(item.work.workId)}
                    className="w-full rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-3 text-left transition hover:border-[var(--color-text-primary)]"
                  >
                    <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">{item.label}</div>
                    {item.work ? (
                      <>
                        <div className="mt-1 font-mono text-[11px] text-[var(--color-accent)]">{item.work.workId}</div>
                        <div className="mt-1 text-[13px] font-bold tracking-tight text-[var(--color-text-primary)]">{item.work.recommendedAction}</div>
                        <div className="mt-1 line-clamp-2 text-[11px] text-[var(--color-text-muted)]">{item.work.reason}</div>
                      </>
                    ) : (
                      <div className="mt-1 text-[11px] text-[var(--color-text-tertiary)]">none</div>
                    )}
                  </button>
                ))}
              </div>
              <div className="min-w-0 flex-1">
                {!selectedWork ? (
                  <div className="text-[12px] text-[var(--color-text-muted)]">No work</div>
                ) : mode === "work" ? (
                  <div className="space-y-3 text-[12px]">
                    <div className="rounded border-l-2 border-[var(--color-accent)] bg-[var(--color-bg-surface)] p-3"><b>1. current verdict</b><div className="mt-1">{selectedWork.status}</div></div>
                    <div className="rounded border-l-2 border-[var(--color-text-primary)] bg-[var(--color-bg-surface)] p-3"><b>2. recommended next action</b><div className="mt-1">{selectedWork.recommendedAction}</div></div>
                    <div className="rounded border-l-2 border-[var(--color-text-primary)] bg-[var(--color-bg-surface)] p-3"><b>3. blocker / stop condition</b><div className="mt-1">{selectedWork.reason}</div></div>
                    <div className="rounded border-l-2 border-[var(--color-text-primary)] bg-[var(--color-bg-surface)] p-3"><b>4. evidence</b><div className="mt-1">{selectedWork.evidence.join(" | ") || "none"}</div></div>
                    <div className="rounded border-l-2 border-[var(--color-text-primary)] bg-[var(--color-bg-surface)] p-3"><b>5. active session</b><div className="mt-1">{selectedWork.activeSessionId ?? "none"}</div></div>
                    <div className="rounded border-l-2 border-[var(--color-text-primary)] bg-[var(--color-bg-surface)] p-3">
                      <b>allowed actions</b>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {selectedWork.allowedActions.map((a) => (
                          <button key={a} type="button" disabled={busy} onClick={() => void runAction(selectedWork, a)} className="rounded border border-[var(--color-border-default)] px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50">{a}</button>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : selectedSession && selectedSession.runtimeName === "tmux" ? (
                  <DirectTerminal sessionId={selectedSession.id} variant="agent" height="400px" />
                ) : (
                  <div className="text-[12px] text-[var(--color-text-muted)]">Direct terminal requires tmux runtime</div>
                )}
              </div>
            </div>
            <div className="mt-4 border-t border-[var(--color-border-subtle)] pt-4">
              <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">Orchestrator Chat</div>
              <div className="mb-2 text-[11px] text-[var(--color-text-muted)]">next | explain &lt;work-id&gt; | status | diff | act | session | dispatch &lt;issue-id&gt;</div>
              <div className="mb-3 rounded border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-3 text-[11px]">
                {answer ? `state=${answer.state} blocker=${answer.blocker} action=${answer.recommendedAction}` : "run command"}
              </div>
              <form onSubmit={(e) => { e.preventDefault(); void runCommand(); }} className="flex gap-2">
                <input
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  className="flex-1 rounded border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] px-3 py-2 text-[12px] outline-none focus:border-[var(--color-accent)]"
                  placeholder="next / dispatch 123 / explain TKT-... / act TKT-... send"
                />
                <button type="submit" disabled={busy} className="rounded bg-[var(--color-text-primary)] px-4 py-2 text-[12px] font-bold uppercase tracking-[0.08em] text-[var(--color-bg-surface)] disabled:opacity-50">{busy ? "..." : "run"}</button>
              </form>
              {orchestratorId && (
                <a href={`/sessions/${encodeURIComponent(orchestratorId)}`} className="mt-3 inline-block text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--color-accent)] hover:underline">
                  open orchestrator session
                </a>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function OrchestratorControl({ orchestrators }: { orchestrators: DashboardOrchestratorLink[] }) {
  if (orchestrators.length === 0) return null;

  if (orchestrators.length === 1) {
    const orchestrator = orchestrators[0];
    return (
      <a
        href={`/sessions/${encodeURIComponent(orchestrator.id)}`}
        className="orchestrator-btn flex items-center gap-2 rounded-[7px] px-4 py-2 text-[12px] font-semibold hover:no-underline"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)] opacity-80" />
        orchestrator
        <svg
          className="h-3 w-3 opacity-70"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
        </svg>
      </a>
    );
  }

  return (
    <details className="group relative">
      <summary className="orchestrator-btn flex cursor-pointer list-none items-center gap-2 rounded-[7px] px-4 py-2 text-[12px] font-semibold hover:no-underline">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)] opacity-80" />
        {orchestrators.length} orchestrators
        <svg
          className="h-3 w-3 opacity-70 transition-transform group-open:rotate-90"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
      </summary>
      <div className="absolute right-0 top-[calc(100%+0.5rem)] z-10 min-w-[220px] overflow-hidden rounded-[10px] border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] shadow-[0_18px_40px_rgba(0,0,0,0.18)]">
        {orchestrators.map((orchestrator, index) => (
          <a
            key={orchestrator.id}
            href={`/sessions/${encodeURIComponent(orchestrator.id)}`}
            className={`flex items-center justify-between gap-3 px-4 py-3 text-[12px] hover:bg-[var(--color-bg-hover)] hover:no-underline ${
              index > 0 ? "border-t border-[var(--color-border-subtle)]" : ""
            }`}
          >
            <span className="flex min-w-0 items-center gap-2 text-[var(--color-text-primary)]">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-accent)] opacity-80" />
              <span className="truncate">{orchestrator.projectName}</span>
            </span>
            <svg
              className="h-3 w-3 shrink-0 opacity-60"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
            </svg>
          </a>
        ))}
      </div>
    </details>
  );
}

function ProjectOverviewGrid({
  overviews,
}: {
  overviews: Array<{
    project: ProjectInfo;
    orchestrator: DashboardOrchestratorLink | null;
    sessionCount: number;
    openPRCount: number;
    counts: Record<AttentionLevel, number>;
  }>;
}) {
  return (
    <div className="mb-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {overviews.map(({ project, orchestrator, sessionCount, openPRCount, counts }) => (
        <section
          key={project.id}
          className="rounded-[10px] border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-4"
        >
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h2 className="text-[14px] font-semibold text-[var(--color-text-primary)]">
                {project.name}
              </h2>
              <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                {sessionCount} active session{sessionCount !== 1 ? "s" : ""}
                {openPRCount > 0 ? ` · ${openPRCount} open PR${openPRCount !== 1 ? "s" : ""}` : ""}
              </div>
            </div>
            <a
              href={`/?project=${encodeURIComponent(project.id)}`}
              className="rounded-[7px] border border-[var(--color-border-default)] px-3 py-1.5 text-[11px] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:no-underline"
            >
              Open project
            </a>
          </div>

          <div className="mb-4 flex flex-wrap gap-2">
            <ProjectMetric label="Merge" value={counts.merge} tone="var(--color-status-ready)" />
            <ProjectMetric
              label="Respond"
              value={counts.respond}
              tone="var(--color-status-error)"
            />
            <ProjectMetric label="Review" value={counts.review} tone="var(--color-accent-orange)" />
            <ProjectMetric
              label="Pending"
              value={counts.pending}
              tone="var(--color-status-attention)"
            />
            <ProjectMetric
              label="Working"
              value={counts.working}
              tone="var(--color-status-working)"
            />
          </div>

          <div className="flex items-center justify-between border-t border-[var(--color-border-subtle)] pt-3">
            <div className="text-[11px] text-[var(--color-text-muted)]">
              {orchestrator ? "Per-project orchestrator available" : "No running orchestrator"}
            </div>
            {orchestrator ? (
              <a
                href={`/sessions/${encodeURIComponent(orchestrator.id)}`}
                className="orchestrator-btn flex items-center gap-2 rounded-[7px] px-3 py-1.5 text-[11px] font-semibold hover:no-underline"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)] opacity-80" />
                orchestrator
              </a>
            ) : null}
          </div>
        </section>
      ))}
    </div>
  );
}

function ProjectMetric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="min-w-[78px] rounded-[8px] border border-[var(--color-border-subtle)] px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
        {label}
      </div>
      <div className="mt-1 text-[18px] font-semibold tabular-nums" style={{ color: tone }}>
        {value}
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
      ? [{ value: stats.workingSessions, label: "working", color: "var(--color-status-working)" }]
      : []),
    ...(stats.openPRs > 0 ? [{ value: stats.openPRs, label: "PRs" }] : []),
    ...(stats.needsReview > 0
      ? [{ value: stats.needsReview, label: "need review", color: "var(--color-status-attention)" }]
      : []),
  ];

  return (
    <div className="flex items-baseline gap-0.5">
      {parts.map((part, index) => (
        <span key={part.label} className="flex items-baseline">
          {index > 0 && (
            <span className="mx-3 text-[11px] text-[var(--color-border-strong)]">·</span>
          )}
          <span
            className="text-[20px] font-bold tabular-nums tracking-tight"
            style={{ color: part.color ?? "var(--color-text-primary)" }}
          >
            {part.value}
          </span>
          <span className="ml-1.5 text-[11px] text-[var(--color-text-muted)]">{part.label}</span>
        </span>
      ))}
    </div>
  );
}
