import { authkitProxy } from "@workos-inc/authkit-nextjs";
import type { NextFetchEvent, NextRequest } from "next/server";

const stagingProxy = authkitProxy({
  redirectUri: process.env.WORKOS_REDIRECT_URI?.trim(),
  middlewareAuth: {
    enabled: true,
    unauthenticatedPaths: ["/", "/sign-in", "/callback"],
  },
});
const optionalAuthProxy = authkitProxy({
  redirectUri: process.env.WORKOS_REDIRECT_URI?.trim(),
});

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  if ((process.env.AO_CLOUD_WEB_MODE?.trim() || "local") === "local") {
    return optionalAuthProxy(request, event);
  }
  return stagingProxy(request, event);
}

export const config = {
  matcher: [
    "/",
    "/app/:path*",
    "/api/cloud/github-auth-status",
    "/api/cloud/v1/:path*",
    "/sign-in",
    "/github-sign-in",
    "/sign-out",
    "/callback",
  ],
};
