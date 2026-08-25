import { authkitProxy } from "@workos-inc/authkit-nextjs";
import type { NextFetchEvent, NextRequest } from "next/server";

export default function middleware(request: NextRequest, event: NextFetchEvent) {
  const redirectUri = process.env.WORKOS_REDIRECT_URI?.trim();
  if ((process.env.AO_CLOUD_WEB_MODE?.trim() || "local") === "local") {
    return authkitProxy({ redirectUri })(request, event);
  }
  return authkitProxy({
    redirectUri,
    middlewareAuth: {
      enabled: true,
      unauthenticatedPaths: ["/", "/sign-in", "/callback", "/share/:path*"],
    },
  })(request, event);
}

export const config = {
  matcher: [
    "/",
    "/app/:path*",
    "/api/cloud/github-auth-status",
    "/api/cloud/v1/:path*",
    "/sign-in",
    "/github-sign-in",
    "/share/:path*",
    "/sign-out",
    "/callback",
  ],
};
