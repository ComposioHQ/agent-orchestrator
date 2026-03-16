import { NextResponse } from "next/server";
import { getBacklogIssues, startBacklogPoller } from "@/lib/services";

export const dynamic = "force-dynamic";

/**
 * GET /api/backlog — List backlog issues (labeled agent:backlog)
 * Also starts the backlog auto-claim poller on first call.
 */
export async function GET() {
  // Start the backlog poller (idempotent)
  startBacklogPoller();

  try {
    const issues = await getBacklogIssues();
    return NextResponse.json({ issues });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch backlog" },
      { status: 500 },
    );
  }
}
