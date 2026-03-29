import { type NextRequest } from "next/server";
import { validateIdentifier } from "@/lib/validation";
import { getServices } from "@/lib/services";
import { sessionToDashboard } from "@/lib/serialize";
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
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = getCorrelationId(request);
  const startedAt = Date.now();
  const { id } = await params;
  const idErr = validateIdentifier(id, "id");
  if (idErr) {
    return jsonWithCorrelation({ error: idErr }, { status: 400 }, correlationId);
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  let agent: string | undefined;
  if (body && typeof body.agent === "string" && body.agent.trim() !== "") {
    const agentErr = validateIdentifier(body.agent.trim(), "agent");
    if (agentErr) {
      return jsonWithCorrelation({ error: agentErr }, { status: 400 }, correlationId);
    }
    agent = body.agent.trim();
  }

  try {
    const { config, sessionManager } = await getServices();
    const projectId = resolveProjectIdForSessionId(config, id);
    const restored = await sessionManager.restore(id, agent ? { agent } : undefined);

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
        session: sessionToDashboard(restored),
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
    const { config } = await getServices().catch(() => ({ config: undefined }));
    const projectId = config ? resolveProjectIdForSessionId(config, id) : undefined;
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
