import { getProposals, getForks, getTimeline } from "@/lib/governance-mock";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/governance — List governance state (proposals, forks, timeline)
 *
 * Query params:
 *   ?fork=<forkId> — filter by fork
 */
export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const forkFilter = searchParams.get("fork") ?? undefined;

  const proposals = forkFilter
    ? getProposals().filter((p) => p.forkId === forkFilter)
    : getProposals();
  const forks = forkFilter ? getForks().filter((f) => f.id === forkFilter) : getForks();
  const timeline = getTimeline(forkFilter);

  return NextResponse.json({ proposals, forks, timeline });
}
