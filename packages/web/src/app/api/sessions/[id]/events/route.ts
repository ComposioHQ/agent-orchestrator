import { type NextRequest } from "next/server";
import { validateIdentifier } from "@/lib/validation";
import { getServices } from "@/lib/services";
import { getSessionsDir, readEvents, hasEvents, type SessionEventType } from "@composio/ao-core";
import {
  getCorrelationId,
  jsonWithCorrelation,
  recordApiObservation,
  resolveProjectIdForSessionId,
} from "@/lib/observability";

/** GET /api/sessions/:id/events — Get session event log */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = getCorrelationId(request);
  const startedAt = Date.now();
  const { id } = await params;
  const idErr = validateIdentifier(id, "id");
  if (idErr) {
    return jsonWithCorrelation({ error: idErr }, { status: 400 }, correlationId);
  }

  try {
    const { config } = await getServices();
    const projectId = resolveProjectIdForSessionId(config, id);

    // Find the project to resolve sessionsDir
    let sessionsDir: string | undefined;
    if (projectId) {
      const project = config.projects[projectId];
      if (project) {
        sessionsDir = getSessionsDir(config.configPath, project.path);
      }
    }

    // Fallback: search all projects for this session (cheap file existence check)
    if (!sessionsDir) {
      for (const [, project] of Object.entries(config.projects)) {
        const dir = getSessionsDir(config.configPath, project.path);
        if (hasEvents(dir, id)) {
          sessionsDir = dir;
          break;
        }
      }
    }

    if (!sessionsDir) {
      return jsonWithCorrelation({ events: [] }, { status: 200 }, correlationId);
    }

    // Parse query parameters
    const url = request.nextUrl;
    const limitParam = url.searchParams.get("limit");
    const offsetParam = url.searchParams.get("offset");
    const typesParam = url.searchParams.get("types");

    const parsedLimit = limitParam ? parseInt(limitParam, 10) : undefined;
    const parsedOffset = offsetParam ? parseInt(offsetParam, 10) : undefined;
    // Sanitize: NaN/negative → undefined (ignored), 0 → 0 (empty result)
    const limit =
      parsedLimit !== undefined && Number.isFinite(parsedLimit) && parsedLimit >= 0
        ? parsedLimit
        : undefined;
    const offset =
      parsedOffset !== undefined && Number.isFinite(parsedOffset) && parsedOffset >= 0
        ? parsedOffset
        : undefined;
    const types = typesParam
      ? (typesParam.split(",") as SessionEventType[])
      : undefined;

    const events = readEvents(sessionsDir, id, { types, limit, offset });

    recordApiObservation({
      config,
      method: "GET",
      path: "/api/sessions/[id]/events",
      correlationId,
      startedAt,
      outcome: "success",
      statusCode: 200,
      projectId,
      sessionId: id,
      data: { eventCount: events.length },
    });

    return jsonWithCorrelation({ events }, { status: 200 }, correlationId);
  } catch (error) {
    const { config } = await getServices().catch(() => ({ config: undefined }));
    const projectId = config ? resolveProjectIdForSessionId(config, id) : undefined;
    if (config) {
      recordApiObservation({
        config,
        method: "GET",
        path: "/api/sessions/[id]/events",
        correlationId,
        startedAt,
        outcome: "failure",
        statusCode: 500,
        projectId,
        sessionId: id,
        reason: error instanceof Error ? error.message : "Failed to read events",
      });
    }
    return jsonWithCorrelation({ error: "Failed to read events" }, { status: 500 }, correlationId);
  }
}
