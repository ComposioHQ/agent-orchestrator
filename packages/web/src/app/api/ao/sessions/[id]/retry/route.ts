import {
  SessionNotFoundError,
  SessionNotRestorableError,
  WorkspaceMissingError,
} from "@composio/ao-core";
import { checkConfiguredAuth } from "@/app/api/ao/_auth";
import { getServices } from "@/lib/services";
import { validateIdentifier } from "@/lib/validation";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Internal server error";
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const authError = checkConfiguredAuth(request);
    if (authError) {
      return authError;
    }

    const { id } = await params;
    const idErr = validateIdentifier(id, "id");
    if (idErr) {
      return Response.json({ error: idErr }, { status: 400 });
    }

    const { sessionManager } = await getServices();
    try {
      await sessionManager.restore(id);
      return Response.json({ ok: true });
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        return Response.json({ error: "Session not found" }, { status: 404 });
      }
      if (error instanceof SessionNotRestorableError) {
        return Response.json({ ok: false, error: error.message }, { status: 409 });
      }
      if (error instanceof WorkspaceMissingError) {
        return Response.json({ ok: false, error: error.message }, { status: 422 });
      }
      return Response.json({ ok: false, error: getErrorMessage(error) }, { status: 500 });
    }
  } catch (error) {
    return Response.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
