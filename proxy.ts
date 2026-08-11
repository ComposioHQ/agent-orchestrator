import { authkitProxy } from "@workos-inc/authkit-nextjs";
import type { NextFetchEvent, NextRequest } from "next/server";
import { NextResponse } from "next/server";

const stagingProxy = authkitProxy({
  middlewareAuth: {
    enabled: true,
    unauthenticatedPaths: ["/", "/sign-in", "/callback"],
  },
});

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  if ((process.env.AO_CLOUD_WEB_MODE?.trim() || "local") === "local") {
    return NextResponse.next();
  }
  return stagingProxy(request, event);
}

export const config = {
  matcher: [
    "/",
    "/app/:path*",
    "/api/cloud/v1/:path*",
    "/sign-in",
    "/sign-out",
    "/callback",
  ],
};
