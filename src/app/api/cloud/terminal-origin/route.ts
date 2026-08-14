import { NextResponse } from "next/server";

import { cloudApiBaseUrl, cloudWebMode } from "@/lib/cloud-config";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  // Terminate the browser WebSocket on the page's own origin and let the
  // Worker (open-next.wrapper.js) proxy the upgrade to the control-plane ALB.
  //
  // Every cross-origin variant we tried failed the same way: a cold hostname
  // costs a fresh TLS session and Firefox first probes HTTP/3, which cannot
  // carry a WebSocket, so the upgrade landed ~30s late and the terminal ticket
  // had already expired — the control plane answered 401 on every attempt.
  // Same-origin reuses the connection the page is already on, so the handshake
  // completes immediately. This is the only variant observed succeeding in
  // production (28 upgrades in one minute versus zero for the alternatives).
  const origin =
    cloudWebMode() === "local"
      ? cloudApiBaseUrl()
      : new URL(request.url).origin;
  return NextResponse.json(
    { origin },
    { headers: { "Cache-Control": "no-store" } },
  );
}
