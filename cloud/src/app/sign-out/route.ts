import { signOut } from "@workos-inc/authkit-nextjs";
import { NextRequest, NextResponse } from "next/server";

import {
  cloudApiBaseUrl,
  cloudWebMode,
  localAuthCookie,
} from "@/lib/cloud-config";

export async function GET(request: NextRequest) {
  if (cloudWebMode() !== "local") {
    await signOut({ returnTo: "/" });
    return new NextResponse(null, { status: 204 });
  }

  const token = request.cookies.get(localAuthCookie)?.value;
  if (token) {
    await fetch(`${cloudApiBaseUrl()}/api/cloud/v1/auth/local/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    }).catch(() => undefined);
  }
  const response = NextResponse.redirect(new URL("/", request.url));
  response.cookies.delete(localAuthCookie);
  return response;
}
