import type { Metadata } from "next";
import { Dashboard } from "@/components/Dashboard";
import type { DashboardSession } from "@/lib/types";
import { getServices, getSCM } from "@/lib/services";
import {
  sessionToDashboard,
  resolveProject,
  enrichSessionPR,
  enrichSessionsMetadata,
  computeStats,
} from "@/lib/serialize";
import { prCache, prCacheKey } from "@/lib/cache";
import { getPrimaryProjectId, getProjectName } from "@/lib/project-name";
import type { OrchestratorConfig } from "@composio/ao-core";

export const dynamic = "force-dynamic";

function matchesProject(
  session: { id: string; projectId: string },
  projectId: string,
  projects: OrchestratorConfig["projects"],
): boolean {
  if (session.projectId === projectId) return true;
  const project = projects[projectId];
  if (project?.sessionPrefix && session.id.startsWith(project.sessionPrefix)) return true;
  return false;
}

export async function generateMetadata(): Promise<Metadata> {
  const projectName = getProjectName();
  return { title: { absolute: `ao | ${projectName}` } };
}

export default async function Home() {
  let sessions: DashboardSession[] = [];
  let orchestratorId: string | null = null;
  const projectId = getPrimaryProjectId();
  try {
    const { config, registry, sessionManager } = await getServices();
    const allSessions = await sessionManager.list();

    const projectFilter = projectId;

    if (projectFilter && projectFilter !== "all") {
      const orchSession = allSessions.find(
        (s) => s.id.endsWith("-orchestrator") && matchesProject(s, projectFilter, config.projects),
      );
      if (orchSession) {
        orchestratorId = orchSession.id;
      }
    } else {
      const orchSession = allSessions.find((s) => s.id.endsWith("-orchestrator"));
      if (orchSession) {
        orchestratorId = orchSession.id;
      }
    }

    let coreSessions = allSessions.filter((s) => !s.id.endsWith("-orchestrator"));

    if (projectFilter && projectFilter !== "all") {
      coreSessions = coreSessions.filter((s) => matchesProject(s, projectFilter, config.projects));
    }

    sessions = coreSessions.map(sessionToDashboard);

    const metaTimeout = new Promise<void>((resolve) => setTimeout(resolve, 3_000));
    await Promise.race([
      enrichSessionsMetadata(coreSessions, sessions, config, registry),
      metaTimeout,
    ]);

    const terminalStatuses = new Set(["merged", "killed", "cleanup", "done", "terminated"]);
    const enrichPromises = coreSessions.map((core, i) => {
      if (!core.pr) return Promise.resolve();

      const cacheKey = prCacheKey(core.pr.owner, core.pr.repo, core.pr.number);
      const cached = prCache.get(cacheKey);

      if (cached) {
        if (sessions[i].pr) {
          sessions[i].pr.state = cached.state;
          sessions[i].pr.title = cached.title;
          sessions[i].pr.additions = cached.additions;
          sessions[i].pr.deletions = cached.deletions;
          sessions[i].pr.ciStatus = cached.ciStatus as "none" | "pending" | "passing" | "failing";
          sessions[i].pr.reviewDecision = cached.reviewDecision as
            | "none"
            | "pending"
            | "approved"
            | "changes_requested";
          sessions[i].pr.ciChecks = cached.ciChecks.map((c) => ({
            name: c.name,
            status: c.status as "pending" | "running" | "passed" | "failed" | "skipped",
            url: c.url,
          }));
          sessions[i].pr.mergeability = cached.mergeability;
          sessions[i].pr.unresolvedThreads = cached.unresolvedThreads;
          sessions[i].pr.unresolvedComments = cached.unresolvedComments;
        }

        if (
          terminalStatuses.has(core.status) ||
          cached.state === "merged" ||
          cached.state === "closed"
        ) {
          return Promise.resolve();
        }
      }

      const project = resolveProject(core, config.projects);
      const scm = getSCM(registry, project);
      if (!scm) return Promise.resolve();
      return enrichSessionPR(sessions[i], scm, core.pr);
    });
    const enrichTimeout = new Promise<void>((resolve) => setTimeout(resolve, 4_000));
    await Promise.race([Promise.allSettled(enrichPromises), enrichTimeout]);
  } catch {
    sessions = [];
    orchestratorId = null;
  }

  return (
    <Dashboard
      initialSessions={sessions}
      stats={computeStats(sessions)}
      orchestratorId={orchestratorId}
      projectName={projectId}
    />
  );
}
