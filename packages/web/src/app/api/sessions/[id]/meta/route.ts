import { NextResponse, type NextRequest } from "next/server";
import { getServices } from "@/lib/services";
import { sessionToDashboard } from "@/lib/serialize";

/**
 * GET /api/sessions/[id]/meta — lightweight session metadata endpoint.
 *
 * Returns local metadata only (no SCM enrichment, no GitHub API calls).
 * Responds in <50ms, suitable for instant tab title population.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { sessionManager } = await getServices();

    const coreSession = await sessionManager.get(id);
    if (!coreSession) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Convert to dashboard format without any enrichment
    const dashboardSession = sessionToDashboard(coreSession);

    return NextResponse.json(dashboardSession);
  } catch (error) {
    console.error("Failed to fetch session meta:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
