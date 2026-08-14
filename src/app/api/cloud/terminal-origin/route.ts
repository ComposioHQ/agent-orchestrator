import { NextResponse } from "next/server";

import { cloudApiBaseUrl, cloudWebMode } from "@/lib/cloud-config";

export const dynamic = "force-dynamic";

export function GET() {
  // Hosted Firefox cannot complete a WebSocket handshake against the API ALB
  // or the OpenNext Worker (nodejs_compat + HTTP/3). A dedicated Worker
  // without nodejs_compat terminates the socket on ws.aoagents.dev.
  const origin =
    cloudWebMode() === "local"
      ? cloudApiBaseUrl()
      : "https://ws.aoagents.dev";
  return NextResponse.json(
    { origin },
    { headers: { "Cache-Control": "no-store" } },
  );
}
