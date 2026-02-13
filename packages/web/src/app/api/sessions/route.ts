import { NextResponse } from "next/server";
import { mockSessions, getMockStats } from "@/lib/mock-data";

/** GET /api/sessions — List all sessions with full state */
export async function GET() {
  return NextResponse.json({
    sessions: mockSessions,
    stats: getMockStats(),
  });
}
