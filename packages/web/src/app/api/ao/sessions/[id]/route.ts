import type { Session, SessionManager } from "@composio/ao-core";
import { checkConfiguredAuth } from "@/app/api/ao/_auth";
import { toAODashboardSession } from "@/lib/ao-sessions";
import { getServices } from "@/lib/services";
import { validateIdentifier } from "@/lib/validation";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Internal server error";
}

type ArchivedLookupSessionManager = SessionManager & {
  get(sessionId: string, options?: { includeArchived?: boolean }): Promise<Session | null>;
};

export async function GET(
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

    const { config, sessionManager } = await getServices();
    const session = await (sessionManager as ArchivedLookupSessionManager).get(id, {
      includeArchived: true,
    });

    if (!session) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    return Response.json(toAODashboardSession(session, config));
  } catch (error) {
    return Response.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
