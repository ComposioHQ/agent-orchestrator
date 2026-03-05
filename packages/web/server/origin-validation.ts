/**
 * Origin validation for WebSocket and HTTP servers.
 *
 * Prevents cross-origin attacks by validating the Origin header
 * against a configurable allowlist. Used by both the direct terminal
 * WebSocket server and the terminal HTTP/WebSocket server.
 */

/** Default allowed origin prefixes (localhost with any port) */
const DEFAULT_ALLOWED_PREFIXES = [
  "http://localhost",
  "https://localhost",
  "http://127.0.0.1",
  "https://127.0.0.1",
  "http://[::1]",
  "https://[::1]",
];

/**
 * Parse additional allowed origins from the AO_ALLOWED_ORIGINS env var.
 * Format: comma-separated list of origins (e.g., "https://my-app.example.com,https://other.example.com")
 */
function getConfiguredOrigins(): string[] {
  const envOrigins = process.env.AO_ALLOWED_ORIGINS;
  if (!envOrigins) return [];
  return envOrigins
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

/**
 * Check if an origin matches an allowed origin.
 *
 * For default localhost origins, we match the prefix (allowing any port).
 * For user-configured origins, we require an exact match.
 */
function matchesOrigin(origin: string, allowed: string, isPrefix: boolean): boolean {
  if (isPrefix) {
    // Match "http://localhost" against "http://localhost:3000" or "http://localhost"
    return origin === allowed || origin.startsWith(allowed + ":");
  }
  return origin === allowed;
}

/**
 * Validate an Origin header value against the allowlist.
 *
 * @param origin - The Origin header value.
 * @returns `true` if the origin is allowed, `false` otherwise.
 *
 * Rules:
 * - `undefined` (no Origin header): rejected — callers handle this case
 *   based on context (WebSocket vs HTTP)
 * - `"null"` string: always rejected (file://, data: URI, sandboxed iframe)
 * - Localhost origins (any port): allowed by default
 * - Additional origins: configured via AO_ALLOWED_ORIGINS env var
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === "null") {
    return false;
  }

  // Check against default localhost prefixes (any port)
  for (const prefix of DEFAULT_ALLOWED_PREFIXES) {
    if (matchesOrigin(origin, prefix, true)) {
      return true;
    }
  }

  // Check against user-configured origins (exact match)
  const configured = getConfiguredOrigins();
  for (const allowed of configured) {
    if (matchesOrigin(origin, allowed, false)) {
      return true;
    }
  }

  return false;
}

/**
 * Validate a WebSocket upgrade request's Origin header.
 *
 * Browsers always send Origin on WebSocket upgrades. Non-browser clients
 * (Node.js `ws` library, curl, server-to-server) typically don't.
 *
 * Policy:
 * - No Origin header (undefined): allow — non-browser client
 * - Origin present and allowed: allow
 * - Origin = "null" or not in allowlist: reject — cross-origin browser attack
 */
export function isAllowedWebSocketOrigin(origin: string | undefined): boolean {
  if (origin === undefined) {
    return true;
  }
  return isAllowedOrigin(origin);
}
