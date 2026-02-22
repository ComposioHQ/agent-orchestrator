import { ACTIVITY_STATE } from "@composio/ao-core";
import { NextResponse } from "next/server";
import { getServices, getSCM } from "@/lib/services";
import {
  sessionToDashboard,
  resolveProject,
  enrichSessionPR,
  enrichSessionsMetadata,
  computeStats,
} from "@/lib/serialize";
import { logApiRequest } from "@/lib/request-logger";
import { prCache } from "@/lib/cache";

/** GET /api/sessions — List all sessions with full state
 * Query params:
 * - active=true: Only return non-exited sessions
 */
export async function GET(request: Request) {
  const requestStart = Date.now();
  const timings: Record<string, number> = {};

  try {
    const { searchParams } = new URL(request.url);
    const activeOnly = searchParams.get("active") === "true";

    const serviceStart = Date.now();
    const { config, registry, sessionManager } = await getServices();
    timings["serviceInit"] = Date.now() - serviceStart;

    const listStart = Date.now();
    const coreSessions = await sessionManager.list();
    timings["sessionList"] = Date.now() - listStart;

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
    const issueStart = Date.now();
    const metaTimeout = new Promise<void>((resolve) => setTimeout(resolve, 3_000));
    await Promise.race([enrichSessionsMetadata(workerSessions, dashboardSessions, config, registry), metaTimeout]);
    timings["issueEnrichment"] = Date.now() - issueStart;

    // Enrich sessions that have PRs with live SCM data (CI, reviews, mergeability)
    const enrichStart = Date.now();
    const enrichPromises = workerSessions.map((core, i) => {
      if (!core.pr) return Promise.resolve();
      const project = resolveProject(core, config.projects);
      const scm = getSCM(registry, project);
      if (!scm) return Promise.resolve();
      return enrichSessionPR(dashboardSessions[i], scm, core.pr);
    });
    const enrichTimeout = new Promise<void>((resolve) => setTimeout(resolve, 4_000));
    await Promise.race([Promise.allSettled(enrichPromises), enrichTimeout]);
    timings["prEnrichment"] = Date.now() - enrichStart;

    const durationMs = Date.now() - requestStart;

    logApiRequest({
      ts: new Date().toISOString(),
      method: "GET",
      path: "/api/sessions",
      sessionId: null,
      statusCode: 200,
      durationMs,
      timings,
      cacheStats: prCache.getStats(),
    });

    return NextResponse.json({
      sessions: dashboardSessions,
      stats: computeStats(dashboardSessions),
    });
  } catch (err) {
    const durationMs = Date.now() - requestStart;
    logApiRequest({
      ts: new Date().toISOString(),
      method: "GET",
      path: "/api/sessions",
      sessionId: null,
      statusCode: 500,
      durationMs,
      timings,
      error: err instanceof Error ? err.message : "Failed to list sessions",
    });

    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to list sessions" },
      { status: 500 },
    );
  }
}
