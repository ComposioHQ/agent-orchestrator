import { NextResponse, type NextRequest } from "next/server";
import { getServices, getSCM } from "@/lib/services";
import {
  sessionToDashboard,
  resolveProject,
  enrichSessionPR,
  enrichSessionsMetadata,
} from "@/lib/serialize";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const forceRefresh = searchParams.get("refresh") === "true";
    const { config, registry, sessionManager } = await getServices();

    const coreSession = await sessionManager.get(id);
    if (!coreSession) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const dashboardSession = sessionToDashboard(coreSession);

    // Enrich metadata (issue labels, agent summaries, issue titles)
    await enrichSessionsMetadata([coreSession], [dashboardSession], config, registry);

    // Enrich PR — serve cache immediately, refresh in background if stale
    if (coreSession.pr) {
      const project = resolveProject(coreSession, config.projects);
      const scm = getSCM(registry, project);
      if (scm) {
        if (forceRefresh) {
          // Force-refresh bypasses cache entirely
          await enrichSessionPR(dashboardSession, scm, coreSession.pr, { forceRefresh: true });
        } else {
          const cached = await enrichSessionPR(dashboardSession, scm, coreSession.pr, { cacheOnly: true });
          if (!cached) {
            // Nothing cached yet — block once to populate, then future calls use cache
            await enrichSessionPR(dashboardSession, scm, coreSession.pr);
          }
        }
      }
    }

    return NextResponse.json(dashboardSession);
  } catch (error) {
    console.error("Failed to fetch session:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
