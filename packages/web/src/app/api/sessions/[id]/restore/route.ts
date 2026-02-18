import { type NextRequest, NextResponse } from "next/server";
import { validateIdentifier } from "@/lib/validation";
import { getServices } from "@/lib/services";
import { sessionToDashboard } from "@/lib/serialize";
import { SessionNotRestorableError, WorkspaceMissingError } from "@composio/ao-core";

/** POST /api/sessions/:id/restore — Restore a terminated session */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const idErr = validateIdentifier(id, "id");
  if (idErr) {
    return NextResponse.json({ error: idErr }, { status: 400 });
  }

  try {
    const { sessionManager } = await getServices();
    const restored = await sessionManager.restore(id);

    return NextResponse.json({
      ok: true,
      sessionId: id,
      session: sessionToDashboard(restored),
    });
  } catch (err) {
    if (err instanceof SessionNotRestorableError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof WorkspaceMissingError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    const msg = err instanceof Error ? err.message : "Failed to restore session";
    const status = msg.includes("not found") ? 404 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
