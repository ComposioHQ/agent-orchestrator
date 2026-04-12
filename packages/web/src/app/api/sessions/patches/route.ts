import { getServices } from "@/lib/services";
import { sessionToDashboard } from "@/lib/serialize";
import { getAttentionLevel } from "@/lib/types";
import { filterWorkerSessions } from "@/lib/project-utils";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const projectFilter = searchParams.get("project");

    const { config, sessionManager } = await getServices();
    const enabledProjects = Object.fromEntries(
      Object.entries(config.projects).filter(([, project]) => project.enabled !== false),
    );
    const requestedProjectId =
      projectFilter && projectFilter !== "all" && enabledProjects[projectFilter]
        ? projectFilter
        : undefined;

    const coreSessions = await sessionManager.list(requestedProjectId);
    const visibleSessions = filterWorkerSessions(coreSessions, projectFilter, enabledProjects);

    // Convert to dashboard format
    const dashboardSessions = visibleSessions.map(sessionToDashboard);

    // Extract lightweight patches
    const patches = dashboardSessions.map((session) => ({
      id: session.id,
      status: session.status,
      activity: session.activity,
      attentionLevel: getAttentionLevel(session),
      lastActivityAt: session.lastActivityAt,
    }));

    return Response.json({ sessions: patches });
  } catch (err) {
    console.error("[GET /api/sessions/patches]", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to fetch session patches" },
      { status: 500 },
    );
  }
}
