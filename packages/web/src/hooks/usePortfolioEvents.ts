"use client";

import { useEffect, useReducer, useRef, useCallback } from "react";
import type { DashboardSession, PortfolioActionItem, PortfolioProjectSummary, AttentionLevel } from "@/lib/types";
import { getAttentionLevel, getTriageRank } from "@/lib/types";

interface PortfolioState {
  actionItems: PortfolioActionItem[];
  projectSummaries: PortfolioProjectSummary[];
}

const POLL_INTERVAL_MS = 5000;
const ATTENTION_LEVELS: AttentionLevel[] = ["merge", "respond", "review", "pending", "working", "done"];

function buildActionItems(sessions: DashboardSession[], projectMap: Map<string, { id: string; name: string }>): PortfolioActionItem[] {
  const items: PortfolioActionItem[] = [];
  for (const session of sessions) {
    const project = projectMap.get(session.projectId);
    const level = getAttentionLevel(session);
    items.push({
      session,
      projectId: project?.id ?? session.projectId,
      projectName: project?.name ?? session.projectId,
      attentionLevel: level,
      triageRank: getTriageRank(level),
    });
  }
  items.sort((a, b) => {
    if (a.triageRank !== b.triageRank) return a.triageRank - b.triageRank;
    return new Date(b.session.lastActivityAt).getTime() - new Date(a.session.lastActivityAt).getTime();
  });
  return items;
}

function buildProjectSummaries(
  actionItems: PortfolioActionItem[],
  projects: Array<{ id: string; name: string; degraded?: boolean; degradedReason?: string }>,
): PortfolioProjectSummary[] {
  return projects.map((project) => {
    const projectItems = actionItems.filter((item) => item.projectId === project.id);
    const counts = {} as Record<AttentionLevel, number>;
    for (const level of ATTENTION_LEVELS) counts[level] = 0;
    for (const item of projectItems) counts[item.attentionLevel]++;

    return {
      id: project.id,
      name: project.name,
      sessionCount: projectItems.length,
      activeCount: projectItems.filter((i) => i.attentionLevel !== "done").length,
      attentionCounts: counts,
      degraded: project.degraded,
      degradedReason: project.degradedReason,
    };
  });
}

export function usePortfolioEvents(
  initialActionItems: PortfolioActionItem[],
  initialProjectSummaries: PortfolioProjectSummary[],
): PortfolioState {
  const [state, setState] = useReducer(
    (_prev: PortfolioState, next: PortfolioState) => next,
    { actionItems: initialActionItems, projectSummaries: initialProjectSummaries },
  );

  const projectsRef = useRef(initialProjectSummaries);

  useEffect(() => {
    projectsRef.current = state.projectSummaries;
  }, [state.projectSummaries]);

  const refresh = useCallback(async () => {
    try {
      // Fetch portfolio-scoped sessions (aggregates across all configs)
      const res = await fetch("/api/sessions?scope=portfolio");
      if (!res.ok) return;
      const body = (await res.json()) as {
        sessions?: DashboardSession[];
        actionItems?: PortfolioActionItem[];
        projectSummaries?: Array<{
          id: string;
          name: string;
          degraded?: boolean;
          degradedReason?: string;
        }>;
      };

      // If the API returns pre-built actionItems, use them directly (includes PR enrichment)
      if (body.actionItems && body.projectSummaries) {
        const summaries = buildProjectSummaries(body.actionItems, body.projectSummaries);
        setState({ actionItems: body.actionItems, projectSummaries: summaries });
        return;
      }

      // Fallback: build from sessions
      if (!body.sessions) return;
      const projectMap = new Map(
        projectsRef.current.map((p) => [p.id, { id: p.id, name: p.name }]),
      );

      const items = buildActionItems(body.sessions, projectMap);
      const summaries = buildProjectSummaries(items, projectsRef.current);

      setState({ actionItems: items, projectSummaries: summaries });
    } catch {
      // Polling failure — skip this cycle
    }
  }, []);

  useEffect(() => {
    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  return state;
}
