import { NextRequest, NextResponse } from "next/server";
import { getMockSession } from "@/lib/mock-data";

/** POST /api/sessions/:id/kill — Kill a session */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = getMockSession(id);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  // TODO: wire to core SessionManager.kill()
  return NextResponse.json({ ok: true, sessionId: id });
}
