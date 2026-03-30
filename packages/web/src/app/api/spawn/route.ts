import { type NextRequest } from "next/server";
import { validateIdentifier, validateString, stripControlChars, validateConfiguredProject } from "@/lib/validation";
import { getServices } from "@/lib/services";
import { sessionToDashboard } from "@/lib/serialize";
import { getCorrelationId, jsonWithCorrelation, recordApiObservation } from "@/lib/observability";

/** POST /api/spawn — Spawn a new session */
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

  if (body.branch !== undefined && body.branch !== null) {
    const branchErr = validateString(body.branch, "branch", 255);
    if (branchErr) {
      return jsonWithCorrelation({ error: branchErr }, { status: 400 }, correlationId);
    }
  }

  if (body.prompt !== undefined && body.prompt !== null) {
    const promptErr = validateString(body.prompt, "prompt", 20_000);
    if (promptErr) {
      return jsonWithCorrelation({ error: promptErr }, { status: 400 }, correlationId);
    }
  }

  try {
    const { config, sessionManager } = await getServices();
    const projectId = body.projectId as string;
    const projectErr = validateConfiguredProject(config.projects, projectId);
    if (projectErr) {
      recordApiObservation({
        config,
        method: "POST",
        path: "/api/spawn",
        correlationId,
        startedAt,
        outcome: "failure",
        statusCode: 404,
        projectId,
        reason: projectErr,
        data: { issueId: body.issueId },
      });
      return jsonWithCorrelation({ error: projectErr }, { status: 404 }, correlationId);
    }

    const session = await sessionManager.spawn({
      projectId,
      issueId: (body.issueId as string) ?? undefined,
      branch: typeof body.branch === "string" ? body.branch.trim() : undefined,
      prompt:
        typeof body.prompt === "string" ? stripControlChars(body.prompt).trim() || undefined : undefined,
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
      data: { issueId: session.issueId },
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
        data: { issueId: body.issueId },
      });
    }
    return jsonWithCorrelation(
      { error: err instanceof Error ? err.message : "Failed to spawn session" },
      { status: 500 },
      correlationId,
    );
  }
}
