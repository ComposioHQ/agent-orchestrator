import { type NextRequest, NextResponse } from "next/server";
import {
  SessionNotRestorableError,
  WorkspaceMissingError,
  isRestorable,
} from "@composio/ao-core";
import { validateIdentifier } from "@/lib/validation";
import { getServices } from "@/lib/services";
import { sessionToDashboard } from "@/lib/serialize";

/**
 * POST /api/sessions/:id/restore — Restore a terminated session
 *
 * Validates that the session is restorable using centralized state logic,
 * then calls SessionManager.restore() to revive it in-place.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const idErr = validateIdentifier(id, "id");
  if (idErr) {
    return NextResponse.json({ error: idErr }, { status: 400 });
  }

  try {
    const { sessionManager } = await getServices();

    // Pre-validate using centralized state logic
    const existingSession = await sessionManager.get(id);
    if (!existingSession) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    if (!isRestorable(existingSession)) {
      return NextResponse.json(
        { error: `Session cannot be restored (status: ${existingSession.status})` },
        { status: 400 }
      );
    }

    const session = await sessionManager.restore(id);

    return NextResponse.json({
      ok: true,
      session: sessionToDashboard(session),
    });
  } catch (error) {
    if (error instanceof SessionNotRestorableError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof WorkspaceMissingError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    const msg = error instanceof Error ? error.message : "Failed to restore session";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
