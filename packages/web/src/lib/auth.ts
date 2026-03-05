/**
 * Authentication helpers for the web dashboard.
 *
 * Validates incoming requests against the shared auth token.
 * The token is read from:
 *   1. AO_AUTH_TOKEN environment variable
 *   2. ~/.agent-orchestrator/.ao-auth-token file
 *
 * If no token is configured, auth is disabled (all requests pass).
 */

import { NextResponse, type NextRequest } from "next/server";
import { readAuthToken } from "@composio/ao-core";

/** Cached auth token — read once on first request */
let cachedToken: string | null | undefined;

/** Get the auth token (cached after first read) */
export function getAuthToken(): string | null {
  if (cachedToken === undefined) {
    cachedToken = readAuthToken();
  }
  return cachedToken;
}

/**
 * Validate an incoming Next.js request.
 *
 * Returns null if the request is authorized (caller should proceed).
 * Returns a 401 NextResponse if the request is unauthorized.
 *
 * Auth is disabled (all requests pass) when no token is configured.
 */
export function validateRequest(request: NextRequest): NextResponse | null {
  const token = getAuthToken();

  // No token configured — auth disabled
  if (!token) {
    return null;
  }

  // Check Authorization: Bearer <token> header
  const authHeader = request.headers.get("authorization");
  if (authHeader) {
    const parts = authHeader.split(" ");
    if (parts.length === 2 && parts[0].toLowerCase() === "bearer" && parts[1] === token) {
      return null; // Valid
    }
  }

  // Check token query parameter (for EventSource/WebSocket which can't set headers)
  const url = new URL(request.url);
  const queryToken = url.searchParams.get("token");
  if (queryToken === token) {
    return null; // Valid
  }

  return NextResponse.json(
    { error: "Unauthorized: missing or invalid auth token" },
    { status: 401 },
  );
}

/**
 * Validate a raw HTTP request (for standalone servers outside Next.js).
 *
 * Checks Authorization header and token query parameter.
 * Returns true if the request is authorized, false otherwise.
 */
export function validateRawRequest(
  headers: { authorization?: string; [key: string]: string | string[] | undefined },
  url: string,
  token: string | null,
): boolean {
  // No token configured — auth disabled
  if (!token) {
    return true;
  }

  // Check Authorization: Bearer <token> header
  const authHeader =
    typeof headers.authorization === "string" ? headers.authorization : undefined;
  if (authHeader) {
    const parts = authHeader.split(" ");
    if (parts.length === 2 && parts[0].toLowerCase() === "bearer" && parts[1] === token) {
      return true;
    }
  }

  // Check token query parameter
  try {
    const parsed = new URL(url, "http://localhost");
    const queryToken = parsed.searchParams.get("token");
    if (queryToken === token) {
      return true;
    }
  } catch {
    // Invalid URL — deny
  }

  return false;
}
