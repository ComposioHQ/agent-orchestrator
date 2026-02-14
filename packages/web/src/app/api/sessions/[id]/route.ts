import { NextResponse, type NextRequest } from "next/server";
import { getServices, getSCM, getTracker } from "@/lib/services";
import { sessionToDashboard, enrichSessionPR, enrichSessionIssue } from "@/lib/serialize";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { config, registry, sessionManager } = await getServices();

    const coreSession = await sessionManager.get(id);
    if (!coreSession) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const dashboardSession = sessionToDashboard(coreSession);

    // Get project config for enrichments
    let project = config.projects[coreSession.projectId];
    if (!project) {
      const entry = Object.entries(config.projects).find(([, p]) =>
        coreSession.id.startsWith(p.sessionPrefix),
      );
      if (entry) project = entry[1];
    }

    // Enrich issue label using tracker plugin
    if (dashboardSession.issueUrl && project) {
      const tracker = getTracker(registry, project);
      if (tracker) {
        enrichSessionIssue(dashboardSession, tracker, project);
      }
    }

    // Enrich PR with live data from SCM
    if (coreSession.pr && project) {
      const scm = getSCM(registry, project);
      if (scm) {
        await enrichSessionPR(dashboardSession, scm, coreSession.pr);
      }
    }

    return NextResponse.json(dashboardSession);
  } catch (error) {
    console.error("Failed to fetch session:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
