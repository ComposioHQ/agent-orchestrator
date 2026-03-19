import { getProposal, getProposalVotes } from "@/lib/governance-mock";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/governance/proposals/:id — Full proposal detail with votes
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const proposal = getProposal(id);
  if (!proposal) {
    return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
  }

  const votes = getProposalVotes(id);
  return NextResponse.json({ proposal, votes });
}
