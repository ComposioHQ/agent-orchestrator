/**
 * Next.js middleware — authentication for all API routes.
 *
 * Checks the Authorization: Bearer <token> header or token query parameter
 * against the shared auth token. Returns 401 for unauthorized requests.
 *
 * Auth is disabled when no token is configured (local dev default).
 * Page routes are not protected — the dashboard is read-only; all mutations
 * go through API routes which are protected.
 *
 * NOTE: Reads token from AO_AUTH_TOKEN env var only (not from file).
 * The `ao start` command sets this env var when launching the dashboard.
 * This avoids importing node:fs/node:os which are not available in
 * Next.js Edge Runtime (where middleware runs).
 */

import { NextResponse, type NextRequest } from "next/server";

function getToken(): string | null {
  const token = process.env["AO_AUTH_TOKEN"];
  return token && token.trim().length > 0 ? token.trim() : null;
}

export function middleware(request: NextRequest): NextResponse | undefined {
  const token = getToken();

  // No token configured — auth disabled, pass through
  if (!token) {
    return undefined;
  }

  // Check Authorization: Bearer <token> header
  const authHeader = request.headers.get("authorization");
  if (authHeader) {
    const parts = authHeader.split(" ");
    if (parts.length === 2 && parts[0].toLowerCase() === "bearer" && parts[1] === token) {
      return undefined; // Valid — proceed
    }
  }

  // Check token query parameter (for EventSource which can't set headers)
  const url = new URL(request.url);
  const queryToken = url.searchParams.get("token");
  if (queryToken === token) {
    return undefined; // Valid — proceed
  }

  return NextResponse.json(
    { error: "Unauthorized: missing or invalid auth token" },
    { status: 401 },
  );
}

/** Only protect API routes — dashboard pages are read-only */
export const config = {
  matcher: "/api/:path*",
};
