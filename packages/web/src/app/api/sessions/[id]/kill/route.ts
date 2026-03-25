import { type NextRequest } from "next/server";
import { validateIdentifier } from "@/lib/validation";
import { getServices } from "@/lib/services";
import { checkConfiguredAuth } from "@/lib/api-auth";
import { SessionNotFoundError } from "@composio/ao-core";
import {
  getCorrelationId,
  jsonWithCorrelation,
  recordApiObservation,
  resolveProjectIdForSessionId,
} from "@/lib/observability";

/** POST /api/sessions/:id/kill — Kill a session */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = getCorrelationId(_request);
  const startedAt = Date.now();
  let config: (Awaited<ReturnType<typeof getServices>>)["config"] | undefined;
  let id: string | undefined;
  try {
    const authError = checkConfiguredAuth(_request, {
      correlationId,
      method: "POST",
      path: "/api/sessions/[id]/kill",
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
    await sessionManager.kill(id);
    recordApiObservation({
      config,
      method: "POST",
      path: "/api/sessions/[id]/kill",
      correlationId,
      startedAt,
      outcome: "success",
      statusCode: 200,
      projectId,
      sessionId: id,
    });
    return jsonWithCorrelation({ ok: true, sessionId: id }, { status: 200 }, correlationId);
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      return jsonWithCorrelation({ error: err.message }, { status: 404 }, correlationId);
    }
    const projectId = config && id ? resolveProjectIdForSessionId(config, id) : undefined;
    if (config) {
      recordApiObservation({
        config,
        method: "POST",
        path: "/api/sessions/[id]/kill",
        correlationId,
        startedAt,
        outcome: "failure",
        statusCode: 500,
        projectId,
        sessionId: id,
        reason: err instanceof Error ? err.message : "Failed to kill session",
      });
    }
    const msg = err instanceof Error ? err.message : "Failed to kill session";
    return jsonWithCorrelation({ error: msg }, { status: 500 }, correlationId);
  }
}
