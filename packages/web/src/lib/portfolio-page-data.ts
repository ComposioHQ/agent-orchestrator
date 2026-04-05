/**
 * Shared portfolio page data loader.
 *
 * Used by both the home page (/) and project pages (/projects/[id])
 * to populate the UnifiedSidebar with project summaries.
 */

import { isOrchestratorSession } from "@composio/ao-core";
import { getCachedPortfolioSessions, getPortfolioServices } from "@/lib/portfolio-services";
import { sessionToDashboard } from "@/lib/serialize";
import {
  getAttentionLevel,
  type AttentionLevel,
  type DashboardSession,
  type PortfolioProjectSummary,
} from "@/lib/types";

const ATTENTION_LEVELS: AttentionLevel[] = [
  "merge",
  "respond",
  "review",
  "pending",
  "working",
  "done",
];

function emptyAttentionCounts(): Record<AttentionLevel, number> {
  return {
    merge: 0,
    respond: 0,
    review: 0,
    pending: 0,
    working: 0,
    done: 0,
  };
}

export async function loadPortfolioPageData(): Promise<{
  projectSummaries: PortfolioProjectSummary[];
  sessions: DashboardSession[];
  orphanedSessionCount: number;
}> {
  const { portfolio } = getPortfolioServices();
  const portfolioSessions = await getCachedPortfolioSessions().catch(() => []);
  const summaries = new Map<string, PortfolioProjectSummary>();
  const sessions: DashboardSession[] = [];
  let orphanedSessionCount = 0;

  for (const project of portfolio) {
    if (project.enabled === false) continue;
    summaries.set(project.id, {
      id: project.id,
      name: project.name,
      repo: project.repo,
      sessionCount: 0,
      activeCount: 0,
      attentionCounts: emptyAttentionCounts(),
      degraded: project.degraded,
      degradedReason: project.degradedReason,
    });
  }

  for (const item of portfolioSessions) {
    if (isOrchestratorSession(item.session)) continue;

    const summary = summaries.get(item.project.id);
    if (!summary) {
      orphanedSessionCount++;
      continue;
    }

    const dashboardSession = sessionToDashboard(item.session);
    sessions.push(dashboardSession);
    const attentionLevel = getAttentionLevel(dashboardSession);
    summary.sessionCount += 1;
    if (attentionLevel !== "done") {
      summary.activeCount += 1;
    }
    summary.attentionCounts[attentionLevel] += 1;
  }

  const projectSummaries = [...summaries.values()];

  for (const summary of projectSummaries) {
    for (const level of ATTENTION_LEVELS) {
      summary.attentionCounts[level] ??= 0;
    }
  }

  return { projectSummaries, sessions, orphanedSessionCount };
}
