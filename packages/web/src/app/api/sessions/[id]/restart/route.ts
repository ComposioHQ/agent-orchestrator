import { type NextRequest, NextResponse } from "next/server";
import { validateIdentifier } from "@/lib/validation";
import { getServices } from "@/lib/services";
import { sessionToDashboard } from "@/lib/serialize";

/** POST /api/sessions/:id/restart — Restart a session */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const idErr = validateIdentifier(id, "id");
  if (idErr) {
    return NextResponse.json({ error: idErr }, { status: 400 });
  }

  try {
    const { sessionManager } = await getServices();
    const restarted = await sessionManager.restart(id);

    return NextResponse.json({
      ok: true,
      sessionId: id,
      session: sessionToDashboard(restarted),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to restart session";
    const status = msg.includes("not found") ? 404 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
