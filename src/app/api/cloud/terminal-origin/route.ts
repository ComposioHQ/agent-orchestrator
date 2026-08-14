import { NextResponse } from "next/server";

import { cloudApiBaseUrl } from "@/lib/cloud-config";

export const dynamic = "force-dynamic";

export function GET() {
  // Dial the terminal WebSocket straight at the control-plane ALB.
  //
  // The ALB negotiates no ALPN at all, so browsers reach it over HTTP/1.1 and
  // complete a plain Upgrade handshake. Every Cloudflare-fronted hostname we
  // tried instead negotiates HTTP/2 and advertises h3, and Firefox never
  // finished a socket against those — the upgrade either failed outright or
  // landed late enough that the single-use terminal ticket was already spent,
  // which the control plane reports as 401 on every retry.
  //
  // Cross-origin is intended here: the upgrade handler sets InsecureSkipVerify
  // because the single-use ticket, not the Origin header, is the authorization
  // boundary for this endpoint.
  return NextResponse.json(
    { origin: cloudApiBaseUrl() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
