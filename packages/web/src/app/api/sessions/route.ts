import { ACTIVITY_STATE, type SCM, type PRInfo, type Tracker } from "@composio/ao-core";
import { NextResponse } from "next/server";
import { getServices, getSCM } from "@/lib/services";
import { crossReferenceIssues } from "@/lib/issue-helpers";
import type { DashboardPR } from "@/lib/types";
import type { DashboardIssue } from "@/app/api/issues/route";
import {
  sessionToDashboard,
  resolveProject,
  enrichSessionPR,
  enrichDashboardPR,
  enrichSessionsMetadata,
  computeStats,
  prInfoToDashboard,
} from "@/lib/serialize";

/** GET /api/sessions — List all sessions with full state
 * Query params:
 * - active=true: Only return non-exited sessions
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const activeOnly = searchParams.get("active") === "true";

    const { config, registry, sessionManager } = await getServices();
    const coreSessions = await sessionManager.list();

    // Find orchestrator session ID (if running) and expose to clients
    const orchSession = coreSessions.find((s) => s.id.endsWith("-orchestrator"));
    const orchestratorId = orchSession ? orchSession.id : null;

    // Filter out orchestrator sessions — they get their own button, not a card
    let workerSessions = coreSessions.filter((s) => !s.id.endsWith("-orchestrator"));

    // Convert to dashboard format
    let dashboardSessions = workerSessions.map(sessionToDashboard);

    // Filter to active sessions only if requested (keep workerSessions in sync)
    if (activeOnly) {
      const activeIndices = dashboardSessions
        .map((s, i) => (s.activity !== ACTIVITY_STATE.EXITED ? i : -1))
        .filter((i) => i !== -1);
      workerSessions = activeIndices.map((i) => workerSessions[i]);
      dashboardSessions = activeIndices.map((i) => dashboardSessions[i]);
    }

    // Enrich metadata (issue labels, agent summaries, issue titles) — cap at 3s
    const metaTimeout = new Promise<void>((resolve) => setTimeout(resolve, 3_000));
    await Promise.race([enrichSessionsMetadata(workerSessions, dashboardSessions, config, registry), metaTimeout]);

    // Enrich sessions that have PRs with live SCM data (CI, reviews, mergeability)
    const enrichPromises = workerSessions.map((core, i) => {
      if (!core.pr) return Promise.resolve();
      const project = resolveProject(core, config.projects);
      const scm = getSCM(registry, project);
      if (!scm) return Promise.resolve();
      return enrichSessionPR(dashboardSessions[i], scm, core.pr);
    });
    const enrichTimeout = new Promise<void>((resolve) => setTimeout(resolve, 4_000));
    await Promise.race([Promise.allSettled(enrichPromises), enrichTimeout]);

    // ── Fetch all open PRs from configured repos ──────────────────────
    let extraPRs: DashboardPR[] = [];
    const repoSCMs = new Map<string, SCM>();
    for (const project of Object.values(config.projects)) {
      if (!project.repo || repoSCMs.has(project.repo)) continue;
      const scm = getSCM(registry, project);
      if (scm?.listOpenPRs) {
        repoSCMs.set(project.repo, scm);
      }
    }

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

      const allRepoPRs = (repoResults as PromiseSettledResult<PRInfo[]>[])
        .filter((r): r is PromiseFulfilledResult<PRInfo[]> => r.status === "fulfilled")
        .flatMap((r) => r.value);

      // Build set of session-linked PR keys for deduplication
      const sessionPRKeys = new Set(
        dashboardSessions
          .filter((s): s is typeof s & { pr: DashboardPR } => s.pr !== null)
          .map((s) => `${s.pr.owner}/${s.pr.repo}#${s.pr.number}`),
      );

      const newPRs = allRepoPRs
        .filter((pr) => !sessionPRKeys.has(`${pr.owner}/${pr.repo}#${pr.number}`))
        .map(prInfoToDashboard);

      // Enrich extra PRs
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

    // ── Fetch issues from tracker ────────────────────────────────────
    let issues: DashboardIssue[] = [];
    try {
      const firstProjectId = Object.keys(config.projects)[0];
      const firstProject = firstProjectId ? config.projects[firstProjectId] : undefined;
      if (firstProject) {
        const trackerName = firstProject.tracker?.plugin ?? "linear";
        const tracker = registry.get<Tracker>("tracker", trackerName);
        if (tracker?.listIssues) {
          const issueTimeout = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), 3_000),
          );
          const rawIssues = await Promise.race([
            tracker.listIssues({ state: "open", limit: 50 }, firstProject),
            issueTimeout,
          ]);
          issues = crossReferenceIssues(rawIssues, coreSessions);
        }
      }
    } catch {
      // Tracker unavailable — proceed without issues
    }

    return NextResponse.json({
      sessions: dashboardSessions,
      stats: computeStats(dashboardSessions),
      extraPRs,
      issues,
      orchestratorId,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to list sessions" },
      { status: 500 },
    );
  }
}
