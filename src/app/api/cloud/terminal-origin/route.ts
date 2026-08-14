import { NextResponse } from "next/server";

import { cloudApiBaseUrl, cloudWebMode } from "@/lib/cloud-config";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  // Hosted UI terminates the browser WebSocket on this origin. The Worker
  // proxies the upgrade to the control-plane ALB over HTTP/1.1. Pointing the
  // browser at api.aoagents.dev directly fails in Firefox because that ALB
  // negotiates HTTP/2 and does not complete the WebSocket handshake.
  const origin =
    cloudWebMode() === "local"
      ? cloudApiBaseUrl()
      : new URL(request.url).origin;
  return NextResponse.json(
    { origin },
    { headers: { "Cache-Control": "no-store" } },
  );
}
