import { ACTIVITY_STATE, type Tracker } from "@composio/ao-core";
import { NextResponse } from "next/server";
import { getServices, getSCM } from "@/lib/services";
import {
  sessionToDashboard,
  resolveProject,
  enrichSessionPR,
  enrichSessionIssue,
  enrichSessionsMetadata,
  computeStats,
} from "@/lib/serialize";

/** GET /api/sessions — List all sessions with full state
 * Query params:
 * - active=true: Only return non-exited sessions
 * - include=archived: Include archived (killed) sessions in the response
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const activeOnly = searchParams.get("active") === "true";
    const includeArchived = searchParams.get("include") === "archived";

    const { config, registry, sessionManager } = await getServices();
    const coreSessions = await sessionManager.list();

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

    // Compute stats from active sessions only (before appending archived)
    const stats = computeStats(dashboardSessions);

    // Append archived sessions if requested
    if (includeArchived) {
      const archivedSessions = await sessionManager.listArchived();
      const activeIds = new Set(dashboardSessions.map((s) => s.id));
      const archivedWorkers = archivedSessions.filter(
        (s) => !s.id.endsWith("-orchestrator") && !activeIds.has(s.id),
      );
      const archivedDashboard = archivedWorkers.map(sessionToDashboard);

      // Cheap issue label enrichment only (sync, no API calls)
      for (const ds of archivedDashboard) {
        if (!ds.issueUrl) continue;
        // Find the project for this archived session
        const project = Object.values(config.projects).find((p) =>
          ds.id.startsWith(p.sessionPrefix),
        );
        if (!project?.tracker) continue;
        const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
        if (!tracker) continue;
        enrichSessionIssue(ds, tracker, project);
      }

      dashboardSessions.push(...archivedDashboard);
    }

    return NextResponse.json({
      sessions: dashboardSessions,
      stats,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to list sessions" },
      { status: 500 },
    );
  }
}
