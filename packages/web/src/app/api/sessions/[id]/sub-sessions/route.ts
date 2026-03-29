import { type NextRequest } from "next/server";
import { validateIdentifier } from "@/lib/validation";
import { getServices } from "@/lib/services";
import { SessionNotFoundError } from "@composio/ao-core";
import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";

function subSessionToJson(s: {
  id: string;
  parentId: string;
  type: string;
  tmuxName: string;
  workspacePath: string;
  alive: boolean;
  runtimeHandle: unknown;
}) {
  return {
    id: s.id,
    parentId: s.parentId,
    type: s.type,
    tmuxName: s.tmuxName,
    workspacePath: s.workspacePath,
    alive: s.alive,
    runtimeHandle: s.runtimeHandle,
  };
}

/** GET /api/sessions/:id/sub-sessions */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = getCorrelationId(_request);
  const { id } = await params;
  const idErr = validateIdentifier(id, "id");
  if (idErr) {
    return jsonWithCorrelation({ error: idErr }, { status: 400 }, correlationId);
  }
  try {
    const { sessionManager } = await getServices();
    const subs = await sessionManager.listSubSessions(id);
    return jsonWithCorrelation(
      { subSessions: subs.map(subSessionToJson) },
      { status: 200 },
      correlationId,
    );
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      return jsonWithCorrelation({ error: err.message }, { status: 404 }, correlationId);
    }
    const msg = err instanceof Error ? err.message : "Failed to list sub-sessions";
    return jsonWithCorrelation({ error: msg }, { status: 400 }, correlationId);
  }
}

/** POST /api/sessions/:id/sub-sessions — create terminal sub-session */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const correlationId = getCorrelationId(_request);
  const { id } = await params;
  const idErr = validateIdentifier(id, "id");
  if (idErr) {
    return jsonWithCorrelation({ error: idErr }, { status: 400 }, correlationId);
  }
  try {
    const { sessionManager } = await getServices();
    const created = await sessionManager.createSubSession(id);
    return jsonWithCorrelation(
      { subSession: subSessionToJson(created) },
      { status: 201 },
      correlationId,
    );
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      return jsonWithCorrelation({ error: err.message }, { status: 404 }, correlationId);
    }
    const msg = err instanceof Error ? err.message : "Failed to create sub-session";
    return jsonWithCorrelation({ error: msg }, { status: 400 }, correlationId);
  }
}
