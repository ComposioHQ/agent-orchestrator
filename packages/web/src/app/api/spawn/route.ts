import { NextRequest, NextResponse } from "next/server";

/** POST /api/spawn — Spawn a new session */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { projectId?: string; issueId?: string } | null;
  if (!body?.projectId) {
    return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  }

  // TODO: wire to core SessionManager.spawn()
  const mockSession = {
    id: `session-${Date.now()}`,
    projectId: body.projectId,
    issueId: body.issueId ?? null,
    status: "spawning",
    activity: "active",
    branch: null,
    summary: `Spawning session for ${body.issueId ?? body.projectId}`,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    pr: null,
    metadata: {},
  };

  return NextResponse.json({ session: mockSession }, { status: 201 });
}
