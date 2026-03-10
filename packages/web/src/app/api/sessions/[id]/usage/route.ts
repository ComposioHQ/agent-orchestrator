import { NextResponse, type NextRequest } from "next/server";
import { getServices } from "@/lib/services";
import { getSessionUsage } from "@/lib/usage";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { config, registry, sessionManager } = await getServices();

    const session = await sessionManager.get(id);
    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const usage = await getSessionUsage(session, config, registry);
    return NextResponse.json(usage);
  } catch (error) {
    console.error("Failed to fetch session usage:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
