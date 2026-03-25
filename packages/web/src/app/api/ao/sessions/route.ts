import { checkConfiguredAuth } from "@/app/api/ao/_auth";
import { toDashboardSessionWithNormalizedProject } from "@/lib/ao-sessions";
import type { DashboardSession } from "@/lib/types";
import { getServices } from "@/lib/services";
import { filterProjectSessions } from "@/lib/project-utils";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Internal server error";
}

function filterByStatus(sessions: DashboardSession[], rawStatuses: string | null): DashboardSession[] {
  if (!rawStatuses) {
    return sessions;
  }

  const statuses = new Set(
    rawStatuses
      .split(",")
      .map((status) => status.trim())
      .filter((status) => status.length > 0),
  );

  if (statuses.size === 0) {
    return sessions;
  }

  return sessions.filter((session) => statuses.has(session.status));
}

export async function GET(request: Request): Promise<Response> {
  try {
    const authError = checkConfiguredAuth(request);
    if (authError) {
      return authError;
    }

    const { config, sessionManager } = await getServices();
    const { searchParams } = new URL(request.url);
    const project = searchParams.get("project");
    const coreSessions = filterProjectSessions(await sessionManager.list(), project, config.projects);
    let sessions = coreSessions.map((session) =>
      toDashboardSessionWithNormalizedProject(session, config),
    );

    sessions = filterByStatus(sessions, searchParams.get("status"));

    if (searchParams.get("warned") === "true") {
      sessions = sessions.filter((session) => session.notificationState?.status === "warn");
    }

    return Response.json(sessions);
  } catch (error) {
    return Response.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
