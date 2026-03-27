import type { Metadata } from "next";
export const dynamic = "force-dynamic";

import { resolveProjectConfig } from "@composio/ao-core";
import { PortfolioPage } from "@/components/PortfolioPage";
import { getPortfolioServices, getCachedPortfolioSessions } from "@/lib/portfolio-services";
import { sessionToDashboard, enrichSessionPR } from "@/lib/serialize";
import { getServices, getSCM } from "@/lib/services";
import {
  getAttentionLevel,
  getTriageRank,
  type PortfolioActionItem,
  type PortfolioProjectSummary,
  type AttentionLevel,
} from "@/lib/types";

export const metadata: Metadata = {
  title: { absolute: "ao | Portfolio" },
};

export default async function Home() {
  let actionItems: PortfolioActionItem[] = [];
  let projectSummaries: PortfolioProjectSummary[] = [];

  try {
    const { portfolio } = getPortfolioServices();
    const portfolioSessions = await getCachedPortfolioSessions();

    for (const ps of portfolioSessions) {
      const dashSession = sessionToDashboard(ps.session);
      const level = getAttentionLevel(dashSession);
      actionItems.push({
        session: dashSession,
        projectId: ps.project.id,
        projectName: ps.project.name,
        attentionLevel: level,
        triageRank: getTriageRank(level),
      });
    }

    actionItems.sort((a, b) => {
      if (a.triageRank !== b.triageRank) return a.triageRank - b.triageRank;
      return new Date(b.session.lastActivityAt).getTime() - new Date(a.session.lastActivityAt).getTime();
    });

    const { registry } = await getServices().catch(() => ({ registry: null }));
    if (registry) {
      const enrichPromises: Promise<void>[] = [];
      for (const item of actionItems) {
        const ps = portfolioSessions.find((session) => session.session.id === item.session.id);
        if (!ps || !ps.session.pr) continue;

        const resolved = resolveProjectConfig(ps.project);
        if (!resolved) continue;

        const scm = getSCM(registry, resolved.project);
        if (!scm) continue;

        enrichPromises.push(
          enrichSessionPR(item.session, scm, ps.session.pr).then(() => {}),
        );
      }

      const enrichTimeout = new Promise<void>((resolve) => setTimeout(resolve, 4_000));
      await Promise.race([Promise.allSettled(enrichPromises), enrichTimeout]);

      for (const item of actionItems) {
        item.attentionLevel = getAttentionLevel(item.session);
        item.triageRank = getTriageRank(item.attentionLevel);
      }

      actionItems.sort((a, b) => {
        if (a.triageRank !== b.triageRank) return a.triageRank - b.triageRank;
        return new Date(b.session.lastActivityAt).getTime() - new Date(a.session.lastActivityAt).getTime();
      });
    }

    const attentionLevels: AttentionLevel[] = [
      "merge",
      "respond",
      "review",
      "pending",
      "working",
      "done",
    ];
    for (const project of portfolio) {
      const projectItems = actionItems.filter((item) => item.projectId === project.id);
      const counts = {} as Record<AttentionLevel, number>;
      for (const level of attentionLevels) counts[level] = 0;
      for (const item of projectItems) counts[item.attentionLevel]++;

      projectSummaries.push({
        id: project.id,
        name: project.name,
        sessionCount: projectItems.length,
        activeCount: projectItems.filter((item) => item.attentionLevel !== "done").length,
        attentionCounts: counts,
        degraded: project.degraded,
        degradedReason: project.degradedReason,
      });
    }
  } catch {
    // Portfolio services unavailable — render empty state.
  }

  return <PortfolioPage actionItems={actionItems} projectSummaries={projectSummaries} />;
}
