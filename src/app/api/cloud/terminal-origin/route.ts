import { NextResponse } from "next/server";

import { cloudApiBaseUrl } from "@/lib/cloud-config";

export const dynamic = "force-dynamic";

export function GET() {
  // Browser WebSockets must hit the control-plane ALB directly. Terminating
  // them on cloud.aoagents.dev fails in Firefox: that hostname is HTTP/3, and
  // Firefox will not complete a WebSocket upgrade over H3. The ALB is HTTP/1.1.
  return NextResponse.json(
    { origin: cloudApiBaseUrl() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
