import { getForks } from "@/lib/governance-mock";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/governance/forks — List all on-chain forks
 */
export async function GET(): Promise<Response> {
  return NextResponse.json({ forks: getForks() });
}
