/**
 * Next.js middleware for CSRF protection on API routes.
 *
 * For state-changing methods (POST, PUT, DELETE, PATCH) on /api/* routes:
 * - If Origin header is present, validate it against the allowlist
 * - If Origin header is absent, allow (non-browser clients like curl/CLI)
 * - Reject requests with disallowed or "null" Origin
 *
 * GET/HEAD/OPTIONS are always allowed (read-only, no CSRF risk).
 */

import { NextResponse, type NextRequest } from "next/server";

/** Default allowed origin prefixes (localhost with any port) */
const DEFAULT_ALLOWED_PREFIXES = [
  "http://localhost",
  "https://localhost",
  "http://127.0.0.1",
  "https://127.0.0.1",
  "http://[::1]",
  "https://[::1]",
];

function getConfiguredOrigins(): string[] {
  const envOrigins = process.env.AO_ALLOWED_ORIGINS;
  if (!envOrigins) return [];
  return envOrigins
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin || origin === "null") {
    return false;
  }

  for (const prefix of DEFAULT_ALLOWED_PREFIXES) {
    if (origin === prefix || origin.startsWith(prefix + ":")) {
      return true;
    }
  }

  const configured = getConfiguredOrigins();
  for (const allowed of configured) {
    if (origin === allowed) {
      return true;
    }
  }

  return false;
}

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

export function middleware(request: NextRequest) {
  // Only check state-changing methods
  if (!STATE_CHANGING_METHODS.has(request.method)) {
    return NextResponse.next();
  }

  const origin = request.headers.get("origin");

  // No Origin header = non-browser client (curl, CLI, server-to-server) — allow
  if (origin === null) {
    return NextResponse.next();
  }

  // Origin header present but disallowed — reject
  if (!isAllowedOrigin(origin)) {
    return NextResponse.json(
      { error: "Forbidden: origin not allowed" },
      { status: 403 },
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
