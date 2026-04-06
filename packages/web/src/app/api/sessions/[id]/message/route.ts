import { type NextRequest } from "next/server";
import { handleSessionMessagePost } from "@/lib/session-message";

/** POST /api/sessions/:id/message — Legacy alias for /send */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleSessionMessagePost({
    request,
    params,
    routePath: "/api/sessions/[id]/message",
  });
}
