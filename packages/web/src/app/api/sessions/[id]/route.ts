import { type NextRequest } from "next/server";
import { getServices, getSCM } from "@/lib/services";
import { checkConfiguredAuth } from "@/lib/api-auth";
import { toDashboardSessionWithNormalizedProject } from "@/lib/ao-sessions";
import {
  resolveProject,
  enrichSessionPR,
  enrichSessionsMetadata,
} from "@/lib/serialize";
import { getCorrelationId, jsonWithCorrelation, recordApiObservation } from "@/lib/observability";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = getCorrelationId(_request);
  const startedAt = Date.now();
  try {
    const authError = checkConfiguredAuth(_request, {
      correlationId,
      method: "GET",
      path: "/api/sessions/[id]",
      startedAt,
    });
    if (authError) {
      return authError;
    }

    const { id } = await params;
    const { config, registry, sessionManager } = await getServices();

    const coreSession = await sessionManager.get(id, { includeArchived: true });
    if (!coreSession) {
      return jsonWithCorrelation({ error: "Session not found" }, { status: 404 }, correlationId);
    }

    const dashboardSession = toDashboardSessionWithNormalizedProject(coreSession, config);

    // Enrich metadata (issue labels, agent summaries, issue titles)
    await enrichSessionsMetadata([coreSession], [dashboardSession], config, registry);

    // Enrich PR — serve cache immediately, refresh in background if stale
    if (coreSession.pr) {
      const project = resolveProject(coreSession, config.projects);
      const scm = getSCM(registry, project);
      if (scm) {
        const cached = await enrichSessionPR(dashboardSession, scm, coreSession.pr, {
          cacheOnly: true,
        });
        if (!cached) {
          // Nothing cached yet — block once to populate, then future calls use cache
          await enrichSessionPR(dashboardSession, scm, coreSession.pr);
        }
      }
    }

    recordApiObservation({
      config,
      method: "GET",
      path: "/api/sessions/[id]",
      correlationId,
      startedAt,
      outcome: "success",
      statusCode: 200,
      projectId: coreSession.projectId,
      sessionId: id,
    });

    return jsonWithCorrelation(dashboardSession, { status: 200 }, correlationId);
  } catch (error) {
    const { id } = await params;
    const { config, sessionManager } = await getServices().catch(() => ({
      config: undefined,
      sessionManager: undefined,
    }));
    const session = sessionManager
      ? await sessionManager.get(id, { includeArchived: true }).catch(() => null)
      : null;
    if (config) {
      recordApiObservation({
        config,
        method: "GET",
        path: "/api/sessions/[id]",
        correlationId,
        startedAt,
        outcome: "failure",
        statusCode: 500,
        projectId: session?.projectId,
        sessionId: id,
        reason: error instanceof Error ? error.message : "Internal server error",
      });
    }
    return jsonWithCorrelation({ error: "Internal server error" }, { status: 500 }, correlationId);
  }
}
