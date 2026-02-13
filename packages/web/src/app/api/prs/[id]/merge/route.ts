import { NextRequest, NextResponse } from "next/server";
import { mockSessions } from "@/lib/mock-data";

/** POST /api/prs/:id/merge — Merge a PR */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const prNumber = parseInt(id, 10);
  const session = mockSessions.find((s) => s.pr?.number === prNumber);
  if (!session?.pr) {
    return NextResponse.json({ error: "PR not found" }, { status: 404 });
  }

  if (!session.pr.mergeability.mergeable) {
    return NextResponse.json(
      { error: "PR is not mergeable", blockers: session.pr.mergeability.blockers },
      { status: 422 },
    );
  }

  // TODO: wire to core SCM.mergePR()
  return NextResponse.json({ ok: true, prNumber, method: "squash" });
}
