import { type NextRequest } from "next/server";
import { getServices, getSCM } from "@/lib/services";
import {
  sessionToDashboard,
  resolveProject,
  enrichSessionPR,
  enrichSessionsMetadata,
} from "@/lib/serialize";
import { getCorrelationId, jsonWithCorrelation, recordApiObservation } from "@/lib/observability";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = getCorrelationId(_request);
  const startedAt = Date.now();
  try {
    const { id } = await params;
    const { config, registry, sessionManager } = await getServices();

    const coreSession = await sessionManager.get(id);
    if (!coreSession) {
      return jsonWithCorrelation({ error: "Session not found" }, { status: 404 }, correlationId);
    }

    const dashboardSession = sessionToDashboard(coreSession);

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
    const session = sessionManager ? await sessionManager.get(id).catch(() => null) : null;
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

/**
 * PATCH /api/sessions/[id]
 * Switch the LLM agent for a session (triggers a real handoff).
 * Body: { targetAgent: "claude-code" | "local-llm" }
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = getCorrelationId(request);
  const startedAt = Date.now();
  try {
    const { id } = await params;
    const body = await request.json() as Record<string, unknown>;
    const targetAgent = body["targetAgent"];

    if (targetAgent !== "claude-code" && targetAgent !== "local-llm") {
      return jsonWithCorrelation(
        { error: "targetAgent must be \"claude-code\" or \"local-llm\"" },
        { status: 400 },
        correlationId,
      );
    }

    const { config, sessionManager } = await getServices();

    const existing = await sessionManager.get(id);
    if (!existing) {
      return jsonWithCorrelation({ error: "Session not found" }, { status: 404 }, correlationId);
    }

    const newSession = await sessionManager.switchLlm(id, targetAgent);
    const dashboardSession = sessionToDashboard(newSession);

    recordApiObservation({
      config,
      method: "PATCH",
      path: "/api/sessions/[id]",
      correlationId,
      startedAt,
      outcome: "success",
      statusCode: 200,
      projectId: existing.projectId,
      sessionId: id,
    });

    return jsonWithCorrelation(
      { newSessionId: newSession.id, session: dashboardSession },
      { status: 200 },
      correlationId,
    );
  } catch (error) {
    const { id } = await params;
    const { config } = await getServices().catch(() => ({ config: undefined }));
    if (config) {
      recordApiObservation({
        config,
        method: "PATCH",
        path: "/api/sessions/[id]",
        correlationId,
        startedAt,
        outcome: "failure",
        statusCode: 500,
        sessionId: id,
        reason: error instanceof Error ? error.message : "Internal server error",
      });
    }
    const message = error instanceof Error ? error.message : "Internal server error";
    return jsonWithCorrelation({ error: message }, { status: 500 }, correlationId);
  }
}
