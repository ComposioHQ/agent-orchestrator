import { type NextRequest } from "next/server";
import { SessionNotFoundError, type OrchestratorConfig } from "@composio/ao-core";
import { getServices } from "@/lib/services";
import { stripControlChars, validateIdentifier, validateString } from "@/lib/validation";
import {
  getCorrelationId,
  jsonWithCorrelation,
  recordApiObservation,
  resolveProjectIdForSessionId,
} from "@/lib/observability";

const MAX_MESSAGE_LENGTH = 10_000;

interface HandleSessionMessagePostOptions {
  request: NextRequest;
  params: Promise<{ id: string }>;
  routePath: string;
}

interface SessionMessageSuccessResponse {
  ok: true;
  success: true;
  sessionId: string;
  message: string;
}

function buildSuccessResponse(sessionId: string, message: string): SessionMessageSuccessResponse {
  return {
    ok: true,
    success: true,
    sessionId,
    message,
  };
}

export async function handleSessionMessagePost({
  request,
  params,
  routePath,
}: HandleSessionMessagePostOptions): Promise<Response> {
  const correlationId = getCorrelationId(request);
  const startedAt = Date.now();
  const { id } = await params;

  const idErr = validateIdentifier(id, "id");
  if (idErr) {
    return jsonWithCorrelation({ error: idErr }, { status: 400 }, correlationId);
  }

  let body: Record<string, unknown> | null;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonWithCorrelation(
      { error: "Invalid JSON in request body" },
      { status: 400 },
      correlationId,
    );
  }

  const messageErr = validateString(body?.message, "message", MAX_MESSAGE_LENGTH);
  if (messageErr) {
    return jsonWithCorrelation({ error: messageErr }, { status: 400 }, correlationId);
  }

  const rawMessage = body?.message as string;
  const message = stripControlChars(rawMessage);
  if (message.trim().length === 0) {
    return jsonWithCorrelation(
      { error: "message must not be empty after sanitization" },
      { status: 400 },
      correlationId,
    );
  }

  let config: OrchestratorConfig | undefined;
  let projectId: string | undefined;

  try {
    const services = await getServices();
    config = services.config;
    projectId = resolveProjectIdForSessionId(config, id);

    await services.sessionManager.send(id, message);

    recordApiObservation({
      config,
      method: "POST",
      path: routePath,
      correlationId,
      startedAt,
      outcome: "success",
      statusCode: 200,
      projectId,
      sessionId: id,
      data: { messageLength: message.length },
    });

    return jsonWithCorrelation(buildSuccessResponse(id, message), { status: 200 }, correlationId);
  } catch (err) {
    if (!config) {
      config = (await getServices().catch(() => ({ config: undefined }))).config;
      projectId = config ? resolveProjectIdForSessionId(config, id) : undefined;
    }

    if (config) {
      recordApiObservation({
        config,
        method: "POST",
        path: routePath,
        correlationId,
        startedAt,
        outcome: "failure",
        statusCode: err instanceof SessionNotFoundError ? 404 : 500,
        projectId,
        sessionId: id,
        reason: err instanceof Error ? err.message : "Failed to send message",
        data: { messageLength: message.length },
      });
    }

    if (err instanceof SessionNotFoundError) {
      return jsonWithCorrelation({ error: err.message }, { status: 404 }, correlationId);
    }

    const msg = err instanceof Error ? err.message : "Failed to send message";
    return jsonWithCorrelation({ error: msg }, { status: 500 }, correlationId);
  }
}
