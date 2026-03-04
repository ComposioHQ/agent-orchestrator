import type { Metadata } from "next";
import { Dashboard } from "@/components/Dashboard";
import type { DashboardSession, DashboardPR } from "@/lib/types";
import type { SCM, PRInfo } from "@composio/ao-core";
import { getServices, getSCM } from "@/lib/services";
import {
  sessionToDashboard,
  resolveProject,
  enrichSessionPR,
  enrichDashboardPR,
  enrichSessionsMetadata,
  computeStats,
  prInfoToDashboard,
} from "@/lib/serialize";
import { prCache, prCacheKey } from "@/lib/cache";
import { getProjectName } from "@/lib/project-name";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const projectName = getProjectName();
  // Use absolute to opt out of the layout's "%s | project" template
  return { title: { absolute: `ao | ${projectName}` } };
}

export default async function Home() {
  let sessions: DashboardSession[] = [];
  let extraPRs: DashboardPR[] = [];
  let orchestratorId: string | null = null;
  const projectName = getProjectName();
  try {
    const { config, registry, sessionManager } = await getServices();
    const allSessions = await sessionManager.list();

    // Find the orchestrator session (any session ending with -orchestrator)
    // Only set orchestratorId if an actual session exists (no fallback)
    const orchSession = allSessions.find((s) => s.id.endsWith("-orchestrator"));
    if (orchSession) {
      orchestratorId = orchSession.id;
    }

    // Filter out orchestrator from worker sessions
    const coreSessions = allSessions.filter((s) => !s.id.endsWith("-orchestrator"));
    sessions = coreSessions.map(sessionToDashboard);

    // Enrich metadata (issue labels, agent summaries, issue titles) — cap at 3s
    const metaTimeout = new Promise<void>((resolve) => setTimeout(resolve, 3_000));
    await Promise.race([enrichSessionsMetadata(coreSessions, sessions, config, registry), metaTimeout]);

    // Enrich sessions that have PRs with live SCM data
    // Skip enrichment for terminal sessions (merged, closed, done, terminated)
    const terminalStatuses = new Set(["merged", "killed", "cleanup", "done", "terminated"]);
    const enrichPromises = coreSessions.map((core, i) => {
      if (!core.pr) return Promise.resolve();

      // Check cache first (before terminal status check)
      const cacheKey = prCacheKey(core.pr.owner, core.pr.repo, core.pr.number);
      const cached = prCache.get(cacheKey);

      // Apply cached data if available (for both terminal and non-terminal sessions)
      if (cached) {
        if (sessions[i].pr) {
          // Apply ALL cached fields (not just some)
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

        // Skip enrichment if cache is fresh AND (terminal OR merged/closed)
        // This allows terminal sessions to be enriched once when cache is missing/expired
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
    // Cap enrichment at 4s — if GitHub is slow/rate-limited, serve stale data fast
    const enrichTimeout = new Promise<void>((resolve) => setTimeout(resolve, 4_000));
    await Promise.race([Promise.allSettled(enrichPromises), enrichTimeout]);

    // ── Fetch all open PRs from configured repos ──────────────────────
    // Collect unique repos and their SCM plugins
    const repoSCMs = new Map<string, SCM>();
    for (const project of Object.values(config.projects)) {
      if (!project.repo || repoSCMs.has(project.repo)) continue;
      const scm = getSCM(registry, project);
      if (scm?.listOpenPRs) {
        repoSCMs.set(project.repo, scm);
      }
    }

    // Fetch open PRs from each repo (cap at 3s total)
    if (repoSCMs.size > 0) {
      const repoFetchTimeout = new Promise<void>((resolve) => setTimeout(resolve, 3_000));
      const repoFetches = Array.from(repoSCMs.entries()).map(async ([repo, scm]) => {
        try {
          if (!scm.listOpenPRs) return [];
          return await scm.listOpenPRs(repo);
        } catch {
          return [];
        }
      });

      const repoResults = await Promise.race([
        Promise.allSettled(repoFetches),
        repoFetchTimeout.then(() => [] as PromiseSettledResult<never>[]),
      ]);

      // Collect all repo PRs
      const allRepoPRs = (repoResults as PromiseSettledResult<PRInfo[]>[])
        .filter((r): r is PromiseFulfilledResult<PRInfo[]> => r.status === "fulfilled")
        .flatMap((r) => r.value);

      // Build set of session-linked PR keys for deduplication
      const sessionPRKeys = new Set(
        sessions
          .filter((s): s is DashboardSession & { pr: DashboardPR } => s.pr !== null)
          .map((s) => `${s.pr.owner}/${s.pr.repo}#${s.pr.number}`),
      );

      // Filter out session-linked PRs and convert to DashboardPR
      const newPRs = allRepoPRs
        .filter((pr) => !sessionPRKeys.has(`${pr.owner}/${pr.repo}#${pr.number}`))
        .map(prInfoToDashboard);

      // Enrich extra PRs with live SCM data (cap at 4s)
      if (newPRs.length > 0) {
        const extraEnrichPromises = newPRs.map((dashPR) => {
          const repo = `${dashPR.owner}/${dashPR.repo}`;
          const scm = repoSCMs.get(repo);
          if (!scm) return Promise.resolve();
          const prInfo: PRInfo = {
            number: dashPR.number,
            url: dashPR.url,
            title: dashPR.title,
            owner: dashPR.owner,
            repo: dashPR.repo,
            branch: dashPR.branch,
            baseBranch: dashPR.baseBranch,
            isDraft: dashPR.isDraft,
          };
          return enrichDashboardPR(dashPR, scm, prInfo);
        });
        const extraEnrichTimeout = new Promise<void>((resolve) => setTimeout(resolve, 4_000));
        await Promise.race([Promise.allSettled(extraEnrichPromises), extraEnrichTimeout]);
      }

      extraPRs = newPRs;
    }
  } catch {
    // Config not found or services unavailable — show empty dashboard
  }

  return (
    <Dashboard initialSessions={sessions} stats={computeStats(sessions)} orchestratorId={orchestratorId} projectName={projectName} extraPRs={extraPRs} />
  );
}
