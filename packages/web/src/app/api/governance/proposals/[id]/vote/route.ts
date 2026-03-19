import { NextResponse } from "next/server";
import { getProposal } from "@/lib/governance-mock";
import type { VoteChoice } from "@/lib/governance-types";

export const dynamic = "force-dynamic";

/**
 * POST /api/governance/proposals/:id/vote — Submit a vote
 *
 * Body: { choice: "for" | "against" | "abstain", voter: string, txHash: string }
 *
 * In production, this will verify the WalletConnect signature and submit
 * the transaction on-chain. For now, it validates the request shape.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const proposal = getProposal(id);
  if (!proposal) {
    return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
  }

  if (proposal.status !== "active") {
    return NextResponse.json({ error: "Proposal is not active for voting" }, { status: 400 });
  }

  let body: { choice?: VoteChoice; voter?: string; txHash?: string };
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object") {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }
    body = parsed as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const validChoices = new Set<VoteChoice>(["for", "against", "abstain"]);
  if (!body.choice || !validChoices.has(body.choice)) {
    return NextResponse.json(
      { error: "Invalid vote choice. Must be 'for', 'against', or 'abstain'" },
      { status: 400 },
    );
  }

  if (!body.voter || !body.txHash) {
    return NextResponse.json(
      { error: "Missing voter address or transaction hash" },
      { status: 400 },
    );
  }

  // In production: verify on-chain transaction, update proposal vote tally
  // For now: return success with mock confirmation
  return NextResponse.json({
    success: true,
    vote: {
      proposalId: id,
      voter: body.voter,
      choice: body.choice,
      txHash: body.txHash,
      timestamp: new Date().toISOString(),
    },
  });
}
