import { getForkPolicy } from "@/lib/governance-mock";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/governance/forks/:id/policy — Get governance policy for a fork
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const policy = getForkPolicy(id);
  if (!policy) {
    return NextResponse.json({ error: "Fork not found" }, { status: 404 });
  }
  return NextResponse.json({ policy });
}
