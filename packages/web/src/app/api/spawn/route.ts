import { type NextRequest } from "next/server";
import {
  validateConfiguredProject,
  validateIdentifier,
  validateString,
  stripControlChars,
} from "@/lib/validation";
import { getServices } from "@/lib/services";
import { getCorrelationId, jsonWithCorrelation, recordApiObservation } from "@/lib/observability";
import { sessionToDashboard } from "@/lib/serialize";

const MAX_PROMPT_LENGTH = 10_000;

/** POST /api/spawn - Spawn a new session. */
export async function POST(request: NextRequest) {
  const correlationId = getCorrelationId(request);
  const startedAt = Date.now();
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return jsonWithCorrelation({ error: "Invalid JSON body" }, { status: 400 }, correlationId);
  }

  const projectErr = validateIdentifier(body.projectId, "projectId");
  if (projectErr) {
    return jsonWithCorrelation({ error: projectErr }, { status: 400 }, correlationId);
  }

  if (body.issueId !== undefined && body.issueId !== null) {
    const issueErr = validateIdentifier(body.issueId, "issueId");
    if (issueErr) {
      return jsonWithCorrelation({ error: issueErr }, { status: 400 }, correlationId);
    }
  }

  if (body.prompt !== undefined && body.prompt !== null) {
    const promptErr = validateString(body.prompt, "prompt", MAX_PROMPT_LENGTH);
    if (promptErr) {
      return jsonWithCorrelation({ error: promptErr }, { status: 400 }, correlationId);
    }
  }

  try {
    const { config, sessionManager } = await getServices();
    const projectId = body.projectId as string;
    const projectConfigErr = validateConfiguredProject(config.projects, projectId);
    if (projectConfigErr) {
      recordApiObservation({
        config,
        method: "POST",
        path: "/api/spawn",
        correlationId,
        startedAt,
        outcome: "failure",
        statusCode: 404,
        projectId,
        reason: projectConfigErr,
        data: {
          issueId: body.issueId,
          promptLength: typeof body.prompt === "string" ? body.prompt.length : 0,
        },
      });
      return jsonWithCorrelation({ error: projectConfigErr }, { status: 404 }, correlationId);
    }

    const prompt =
      typeof body.prompt === "string" ? stripControlChars(body.prompt).trim() : undefined;
    if (body.prompt !== undefined && (!prompt || prompt.length === 0)) {
      return jsonWithCorrelation(
        { error: "prompt must not be empty after sanitization" },
        { status: 400 },
        correlationId,
      );
    }

    const session = await sessionManager.spawn({
      projectId,
      issueId: (body.issueId as string) ?? undefined,
      prompt,
    });

    recordApiObservation({
      config,
      method: "POST",
      path: "/api/spawn",
      correlationId,
      startedAt,
      outcome: "success",
      statusCode: 201,
      projectId: session.projectId,
      sessionId: session.id,
      data: {
        issueId: session.issueId,
        promptLength: prompt?.length ?? 0,
      },
    });

    return jsonWithCorrelation(
      { session: sessionToDashboard(session) },
      { status: 201 },
      correlationId,
    );
  } catch (err) {
    const { config } = await getServices().catch(() => ({ config: undefined }));
    if (config) {
      recordApiObservation({
        config,
        method: "POST",
        path: "/api/spawn",
        correlationId,
        startedAt,
        outcome: "failure",
        statusCode: 500,
        projectId: typeof body.projectId === "string" ? body.projectId : undefined,
        reason: err instanceof Error ? err.message : "Failed to spawn session",
        data: {
          issueId: body.issueId,
          promptLength: typeof body.prompt === "string" ? body.prompt.length : 0,
        },
      });
    }
    return jsonWithCorrelation(
      { error: err instanceof Error ? err.message : "Failed to spawn session" },
      { status: 500 },
      correlationId,
    );
  }
}
