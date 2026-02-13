import { NextRequest, NextResponse } from "next/server";
import { getMockSession } from "@/lib/mock-data";

/** POST /api/sessions/:id/send — Send a message to a session */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = getMockSession(id);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const body = (await request.json().catch(() => null)) as { message?: string } | null;
  if (!body?.message) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  // TODO: wire to core SessionManager.send()
  return NextResponse.json({ ok: true, sessionId: id, message: body.message });
}
