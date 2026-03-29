import { type NextRequest } from "next/server";
import { validateIdentifier } from "@/lib/validation";
import { getServices } from "@/lib/services";
import { SessionNotFoundError } from "@composio/ao-core";
import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";

/** POST /api/sessions/:id/sub-sessions/:subId/restore — recreate tmux if dead */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; subId: string }> },
) {
  const correlationId = getCorrelationId(_request);
  const { id, subId } = await params;
  const idErr = validateIdentifier(id, "id");
  if (idErr) {
    return jsonWithCorrelation({ error: idErr }, { status: 400 }, correlationId);
  }
  const subErr = validateIdentifier(subId, "subId");
  if (subErr) {
    return jsonWithCorrelation({ error: subErr }, { status: 400 }, correlationId);
  }
  try {
    const { sessionManager } = await getServices();
    const restored = await sessionManager.restoreTerminalSubSession(id, subId);
    return jsonWithCorrelation(
      {
        subSession: {
          id: restored.id,
          parentId: restored.parentId,
          type: restored.type,
          tmuxName: restored.tmuxName,
          workspacePath: restored.workspacePath,
          alive: restored.alive,
          runtimeHandle: restored.runtimeHandle,
        },
      },
      { status: 200 },
      correlationId,
    );
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      return jsonWithCorrelation({ error: err.message }, { status: 404 }, correlationId);
    }
    const msg = err instanceof Error ? err.message : "Failed to restore sub-session";
    return jsonWithCorrelation({ error: msg }, { status: 400 }, correlationId);
  }
}
