import { ACTIVITY_STATE, type Session, type ProjectConfig } from "@composio/ao-core";
import { NextResponse } from "next/server";
import { getServices, getSCM, getTracker } from "@/lib/services";
import { sessionToDashboard, enrichSessionPR, enrichSessionIssue, computeStats } from "@/lib/serialize";

/** Resolve which project a session belongs to. */
function resolveProject(
  core: Session,
  projects: Record<string, ProjectConfig>,
): ProjectConfig | undefined {
  // Try explicit projectId first
  const direct = projects[core.projectId];
  if (direct) return direct;

  // Match by session prefix
  const entry = Object.entries(projects).find(([, p]) =>
    core.id.startsWith(p.sessionPrefix),
  );
  if (entry) return entry[1];

  // Fall back to first project
  const firstKey = Object.keys(projects)[0];
  return firstKey ? projects[firstKey] : undefined;
}

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

    // Enrich issue labels using tracker plugin (synchronous)
    workerSessions.forEach((core, i) => {
      if (!dashboardSessions[i].issueUrl) return;
      const project = resolveProject(core, config.projects);
      const tracker = getTracker(registry, project);
      if (!tracker || !project) return;
      enrichSessionIssue(dashboardSessions[i], tracker, project);
    });

    // Enrich sessions that have PRs with live SCM data (CI, reviews, mergeability)
    const enrichPromises = workerSessions.map((core, i) => {
      if (!core.pr) return Promise.resolve();
      const project = resolveProject(core, config.projects);
      const scm = getSCM(registry, project);
      if (!scm) return Promise.resolve();
      return enrichSessionPR(dashboardSessions[i], scm, core.pr);
    });
    await Promise.allSettled(enrichPromises);

    return NextResponse.json({
      sessions: dashboardSessions,
      stats: computeStats(dashboardSessions),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to list sessions" },
      { status: 500 },
    );
  }
}
