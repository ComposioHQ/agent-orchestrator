import { NextResponse } from "next/server";

import { cloudApiBaseUrl } from "@/lib/cloud-config";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(
    { origin: cloudApiBaseUrl() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
