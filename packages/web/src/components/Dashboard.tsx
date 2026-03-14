"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CI_STATUS } from "@composio/ao-core/types";
import { useSessionEvents } from "@/hooks/useSessionEvents";
import type {
  AttentionLevel,
  DashboardOrchestratorLink,
  DashboardPR,
  DashboardSession,
  DashboardStats,
  DashboardView,
  GlobalPauseState,
} from "@/lib/types";
import { getAttentionLevel, isPRRateLimited } from "@/lib/types";
import type { ProjectInfo } from "@/lib/project-name";
import { DynamicFavicon } from "./DynamicFavicon";
import { ProjectSidebar } from "./ProjectSidebar";
import { DashboardShell } from "./dashboard-shell/DashboardShell";
import { LegacyDashboardView } from "./legacy-dashboard/LegacyDashboardView";
import { PixelDashboardView } from "./pixel-dashboard/PixelDashboardView";

interface DashboardProps {
  initialSessions: DashboardSession[];
  projectId?: string;
  projectName?: string;
  projects?: ProjectInfo[];
  initialGlobalPause?: GlobalPauseState | null;
  orchestrators?: DashboardOrchestratorLink[];
  view?: DashboardView;
}

const EMPTY_ORCHESTRATORS: DashboardOrchestratorLink[] = [];

export interface ProjectOverview {
  project: ProjectInfo;
  orchestrator: DashboardOrchestratorLink | null;
  sessionCount: number;
  openPRCount: number;
  counts: Record<AttentionLevel, number>;
}

interface SessionActionResult {
  ok: boolean;
  message?: string;
}

function mergeOrchestrators(
  current: DashboardOrchestratorLink[],
  incoming: DashboardOrchestratorLink[],
): DashboardOrchestratorLink[] {
  const merged = new Map(current.map((orchestrator) => [orchestrator.projectId, orchestrator]));

  for (const orchestrator of incoming) {
    merged.set(orchestrator.projectId, orchestrator);
  }

  return [...merged.values()];
}

export function Dashboard({
  initialSessions,
  projectId,
  projectName,
  projects = [],
  initialGlobalPause = null,
  orchestrators,
  view = "legacy",
}: DashboardProps) {
  const orchestratorLinks = orchestrators ?? EMPTY_ORCHESTRATORS;
  const { sessions, globalPause } = useSessionEvents(
    initialSessions,
    initialGlobalPause,
    projectId,
    view,
  );
  const [rateLimitDismissed, setRateLimitDismissed] = useState(false);
  const [globalPauseDismissed, setGlobalPauseDismissed] = useState(false);
  const [activeOrchestrators, setActiveOrchestrators] =
    useState<DashboardOrchestratorLink[]>(orchestratorLinks);
  const [spawningProjectIds, setSpawningProjectIds] = useState<string[]>([]);
  const [spawnErrors, setSpawnErrors] = useState<Record<string, string>>({});
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const showSidebar = projects.length > 1;
  const allProjectsView = showSidebar && projectId === undefined;

  useEffect(() => {
    setActiveOrchestrators((current) => mergeOrchestrators(current, orchestratorLinks));
  }, [orchestratorLinks]);

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

  const sessionsByProject = useMemo(() => {
    const groupedSessions = new Map<string, DashboardSession[]>();

    for (const session of sessions) {
      const projectSessions = groupedSessions.get(session.projectId);
      if (projectSessions) {
        projectSessions.push(session);
        continue;
      }
      groupedSessions.set(session.projectId, [session]);
    }

    return groupedSessions;
  }, [sessions]);

  const openPRs = useMemo(() => {
    return sessions
      .filter(
        (session): session is DashboardSession & { pr: DashboardPR } =>
          session.pr?.state === "open",
      )
      .map((session) => session.pr)
      .sort((a, b) => mergeScore(a) - mergeScore(b));
  }, [sessions]);

  const projectOverviews = useMemo<ProjectOverview[]>(() => {
    if (!allProjectsView) return [];

    return projects.map((project) => {
      const projectSessions = sessionsByProject.get(project.id) ?? [];
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
          activeOrchestrators.find((orchestrator) => orchestrator.projectId === project.id) ?? null,
        sessionCount: projectSessions.length,
        openPRCount: projectSessions.filter((session) => session.pr?.state === "open").length,
        counts,
      };
    });
  }, [activeOrchestrators, allProjectsView, projects, sessionsByProject]);

  const parseActionError = useCallback(async (response: Response, fallback: string) => {
    const payload = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
    return payload?.error ?? payload?.message ?? (await response.text().catch(() => "")) ?? fallback;
  }, []);

  const performSend = useCallback(async (sessionId: string, message: string): Promise<SessionActionResult> => {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) {
      throw new Error(await parseActionError(res, `Failed to send message to ${sessionId}`));
    }
    return { ok: true, message: "Message sent" };
  }, [parseActionError]);

  const performKill = useCallback(async (sessionId: string): Promise<SessionActionResult> => {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/kill`, {
      method: "POST",
    });
    if (!res.ok) {
      throw new Error(await parseActionError(res, `Failed to kill ${sessionId}`));
    }
    return { ok: true, message: "Session terminated" };
  }, [parseActionError]);

  const performMerge = useCallback(async (prNumber: number): Promise<SessionActionResult> => {
    const res = await fetch(`/api/prs/${prNumber}/merge`, { method: "POST" });
    if (!res.ok) {
      throw new Error(await parseActionError(res, `Failed to merge PR #${prNumber}`));
    }
    return { ok: true, message: `PR #${prNumber} merged` };
  }, [parseActionError]);

  const performRestore = useCallback(async (sessionId: string): Promise<SessionActionResult> => {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/restore`, {
      method: "POST",
    });
    if (!res.ok) {
      throw new Error(await parseActionError(res, `Failed to restore ${sessionId}`));
    }
    return { ok: true, message: "Session restore started" };
  }, [parseActionError]);

  const handleSend = useCallback(async (sessionId: string, message: string) => {
    await performSend(sessionId, message);
  }, [performSend]);

  const handleKill = useCallback(async (sessionId: string) => {
    if (!confirm(`Kill session ${sessionId}?`)) return;
    await performKill(sessionId);
  }, [performKill]);

  const handleMerge = useCallback(async (prNumber: number) => {
    await performMerge(prNumber);
  }, [performMerge]);

  const handleRestore = useCallback(async (sessionId: string) => {
    if (!confirm(`Restore session ${sessionId}?`)) return;
    await performRestore(sessionId);
  }, [performRestore]);

  const handleSpawnOrchestrator = async (project: ProjectInfo) => {
    setSpawningProjectIds((current) =>
      current.includes(project.id) ? current : [...current, project.id],
    );
    setSpawnErrors(({ [project.id]: _ignored, ...current }) => current);

    try {
      const res = await fetch("/api/orchestrators", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      });

      const data = (await res.json().catch(() => null)) as {
        orchestrator?: DashboardOrchestratorLink;
        error?: string;
      } | null;

      if (!res.ok || !data?.orchestrator) {
        throw new Error(data?.error ?? `Failed to spawn orchestrator for ${project.name}`);
      }

      const orchestrator = data.orchestrator;

      setActiveOrchestrators((current) => {
        const next = current.filter((orchestrator) => orchestrator.projectId !== project.id);
        next.push(orchestrator);
        return next;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to spawn orchestrator";
      setSpawnErrors((current) => ({ ...current, [project.id]: message }));
      console.error(`Failed to spawn orchestrator for ${project.id}:`, error);
    } finally {
      setSpawningProjectIds((current) => current.filter((id) => id !== project.id));
    }
  };

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

  useEffect(() => {
    if (!selectedSessionId) return;
    if (sessions.some((session) => session.id === selectedSessionId)) return;
    setSelectedSessionId(null);
  }, [selectedSessionId, sessions]);

  return (
    <div className="flex h-screen">
      {showSidebar && <ProjectSidebar projects={projects} activeProjectId={projectId} />}
      <div className="flex-1 overflow-y-auto px-8 py-7">
        <DynamicFavicon sessions={sessions} projectName={projectName} />
        <DashboardShell
          allProjectsView={allProjectsView}
          anyRateLimited={anyRateLimited}
          globalPause={globalPause}
          globalPauseDismissed={globalPauseDismissed}
          onDismissGlobalPause={() => setGlobalPauseDismissed(true)}
          onDismissRateLimit={() => setRateLimitDismissed(true)}
          orchestrators={activeOrchestrators}
          projectId={projectId}
          projectName={projectName}
          rateLimitDismissed={rateLimitDismissed}
          resumeAtLabel={resumeAtLabel}
          stats={liveStats}
          view={view}
        >
          {view === "pixel" ? (
            <PixelDashboardView
              allProjectsView={allProjectsView}
              onKill={performKill}
              onMerge={performMerge}
              onSpawnOrchestrator={handleSpawnOrchestrator}
              onRestore={performRestore}
              onSend={performSend}
              openPRs={openPRs}
              projectName={projectName}
              projectOverviews={projectOverviews}
              projects={projects}
              selectedSessionId={selectedSessionId}
              onSelectSession={setSelectedSessionId}
              sessions={sessions}
              sessionsByProject={sessionsByProject}
              spawnErrors={spawnErrors}
              spawningProjectIds={spawningProjectIds}
            />
          ) : (
            <LegacyDashboardView
              allProjectsView={allProjectsView}
              grouped={grouped}
              onKill={handleKill}
              onMerge={handleMerge}
              onRestore={handleRestore}
              onSend={handleSend}
              onSpawnOrchestrator={handleSpawnOrchestrator}
              openPRs={openPRs}
              projectOverviews={projectOverviews}
              spawnErrors={spawnErrors}
              spawningProjectIds={spawningProjectIds}
              view={view}
            />
          )}
        </DashboardShell>
      </div>
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
