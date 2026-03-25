import { type NextRequest } from "next/server";
import { validateIdentifier } from "@/lib/validation";
import { getServices } from "@/lib/services";
import { checkConfiguredAuth } from "@/lib/api-auth";
import { toDashboardSessionWithNormalizedProject } from "@/lib/ao-sessions";
import {
  SessionNotRestorableError,
  WorkspaceMissingError,
  SessionNotFoundError,
} from "@composio/ao-core";
import {
  getCorrelationId,
  jsonWithCorrelation,
  recordApiObservation,
  resolveProjectIdForSessionId,
} from "@/lib/observability";

/** POST /api/sessions/:id/restore — Restore a terminated session */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = getCorrelationId(_request);
  const startedAt = Date.now();
  let config: (Awaited<ReturnType<typeof getServices>>)["config"] | undefined;
  let id: string | undefined;
  try {
    const authError = checkConfiguredAuth(_request, {
      correlationId,
      method: "POST",
      path: "/api/sessions/[id]/restore",
      startedAt,
    });
    if (authError) {
      return authError;
    }

    ({ id } = await params);
    const idErr = validateIdentifier(id, "id");
    if (idErr) {
      return jsonWithCorrelation({ error: idErr }, { status: 400 }, correlationId);
    }

    const services = await getServices();
    config = services.config;
    const { sessionManager } = services;
    const projectId = resolveProjectIdForSessionId(config, id);
    const restored = await sessionManager.restore(id);

    recordApiObservation({
      config,
      method: "POST",
      path: "/api/sessions/[id]/restore",
      correlationId,
      startedAt,
      outcome: "success",
      statusCode: 200,
      projectId: restored.projectId ?? projectId,
      sessionId: id,
    });

    return jsonWithCorrelation(
      {
        ok: true,
        sessionId: id,
        session: toDashboardSessionWithNormalizedProject(restored, config),
      },
      { status: 200 },
      correlationId,
    );
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      return jsonWithCorrelation({ error: err.message }, { status: 404 }, correlationId);
    }
    if (err instanceof SessionNotRestorableError) {
      return jsonWithCorrelation({ error: err.message }, { status: 409 }, correlationId);
    }
    if (err instanceof WorkspaceMissingError) {
      return jsonWithCorrelation({ error: err.message }, { status: 422 }, correlationId);
    }
    const projectId = config && id ? resolveProjectIdForSessionId(config, id) : undefined;
    if (config) {
      recordApiObservation({
        config,
        method: "POST",
        path: "/api/sessions/[id]/restore",
        correlationId,
        startedAt,
        outcome: "failure",
        statusCode: 500,
        projectId,
        sessionId: id,
        reason: err instanceof Error ? err.message : "Failed to restore session",
      });
    }
    const msg = err instanceof Error ? err.message : "Failed to restore session";
    return jsonWithCorrelation({ error: msg }, { status: 500 }, correlationId);
  }
}
