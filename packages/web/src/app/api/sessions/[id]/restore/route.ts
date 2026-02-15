import { type NextRequest, NextResponse } from "next/server";
import { SessionNotRestorableError, WorkspaceMissingError } from "@composio/ao-core";
import { validateIdentifier } from "@/lib/validation";
import { getServices } from "@/lib/services";
import { sessionToDashboard } from "@/lib/serialize";

/**
 * POST /api/sessions/:id/restore — Restore a terminated session
 *
 * Calls SessionManager.restore() which validates state internally.
 * Returns 404 if session not found, 409 if state conflicts (already working/merged).
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const idErr = validateIdentifier(id, "id");
  if (idErr) {
    return NextResponse.json({ error: idErr }, { status: 400 });
  }

  try {
    const { sessionManager } = await getServices();
    const session = await sessionManager.restore(id);

    return NextResponse.json({
      ok: true,
      session: sessionToDashboard(session),
    });
  } catch (error) {
    if (error instanceof SessionNotRestorableError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof WorkspaceMissingError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    // Check for "not found" errors from restore()
    if (error instanceof Error && error.message.includes("not found")) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    const msg = error instanceof Error ? error.message : "Failed to restore session";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
