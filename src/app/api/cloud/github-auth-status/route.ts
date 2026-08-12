import { withAuth } from "@workos-inc/authkit-nextjs";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await withAuth();
  return NextResponse.json(
    { authenticated: Boolean(auth.user && auth.accessToken) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
