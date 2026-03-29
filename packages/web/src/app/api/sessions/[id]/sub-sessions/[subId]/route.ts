import { type NextRequest } from "next/server";
import { validateIdentifier } from "@/lib/validation";
import { getServices } from "@/lib/services";
import { SessionNotFoundError } from "@composio/ao-core";
import { getCorrelationId, jsonWithCorrelation } from "@/lib/observability";

/** DELETE /api/sessions/:id/sub-sessions/:subId */
export async function DELETE(
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
    await sessionManager.killSubSession(id, subId);
    return jsonWithCorrelation({ ok: true }, { status: 200 }, correlationId);
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      return jsonWithCorrelation({ error: err.message }, { status: 404 }, correlationId);
    }
    const msg = err instanceof Error ? err.message : "Failed to kill sub-session";
    return jsonWithCorrelation({ error: msg }, { status: 400 }, correlationId);
  }
}
