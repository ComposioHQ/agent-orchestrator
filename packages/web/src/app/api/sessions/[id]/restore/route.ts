import { type NextRequest, NextResponse } from "next/server";
import { validateIdentifier } from "@/lib/validation";
import { getServices } from "@/lib/services";
import { sessionToDashboard } from "@/lib/serialize";

/** Terminal states that can be restored */
const RESTORABLE_STATUSES = new Set(["killed", "cleanup", "terminated", "done"]);
const RESTORABLE_ACTIVITIES = new Set(["exited"]);

/** Statuses that must never be restored (e.g. already merged) */
const NON_RESTORABLE_STATUSES = new Set(["merged"]);

/** POST /api/sessions/:id/restore — Restore a terminated session */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const idErr = validateIdentifier(id, "id");
  if (idErr) {
    return NextResponse.json({ error: idErr }, { status: 400 });
  }

  try {
    const { sessionManager } = await getServices();
    const session = await sessionManager.get(id);
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    if (NON_RESTORABLE_STATUSES.has(session.status)) {
      return NextResponse.json({ error: "Cannot restore a merged session" }, { status: 409 });
    }

    const isTerminal =
      RESTORABLE_STATUSES.has(session.status) || RESTORABLE_ACTIVITIES.has(session.activity);

    if (!isTerminal) {
      return NextResponse.json({ error: "Session is not in a terminal state" }, { status: 409 });
    }

    // Re-spawn with the same project and issue to create a fresh session
    const newSession = await sessionManager.spawn({
      projectId: session.projectId,
      issueId: session.issueId ?? undefined,
      branch: session.branch ?? undefined,
    });

    return NextResponse.json({ ok: true, sessionId: id, newSession: sessionToDashboard(newSession) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to restore session";
    const status = msg.includes("not found") ? 404 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
