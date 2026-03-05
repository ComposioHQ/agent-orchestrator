/**
 * Authentication token management.
 *
 * Generates and persists a shared secret used by the web dashboard and
 * terminal servers to authenticate requests. The token is a 256-bit
 * random hex string stored at ~/.agent-orchestrator/.ao-auth-token
 * with mode 0600.
 *
 * Token lifecycle:
 *   - Generated once on first `ao start`, persisted across restarts
 *   - Can be overridden via AO_AUTH_TOKEN environment variable
 *   - If no token exists and no env var is set, auth is disabled
 */

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Auth token filename */
const AUTH_TOKEN_FILENAME = ".ao-auth-token";

/** Lazy-evaluated default data directory (avoids calling homedir() at import time) */
function getDefaultDataDir(): string {
  return join(homedir(), ".agent-orchestrator");
}

/** Get the path to the auth token file */
export function getAuthTokenPath(dataDir?: string): string {
  return join(dataDir ?? getDefaultDataDir(), AUTH_TOKEN_FILENAME);
}

/**
 * Read the auth token from the environment or token file.
 * Returns null if no token is configured (auth disabled).
 *
 * Priority:
 *   1. AO_AUTH_TOKEN environment variable
 *   2. Token file at <dataDir>/.ao-auth-token
 *   3. null (auth disabled)
 */
export function readAuthToken(dataDir?: string): string | null {
  // 1. Environment variable takes precedence
  const envToken = process.env["AO_AUTH_TOKEN"];
  if (envToken && envToken.trim().length > 0) {
    return envToken.trim();
  }

  // 2. Read from file
  const tokenPath = getAuthTokenPath(dataDir);
  if (existsSync(tokenPath)) {
    try {
      const token = readFileSync(tokenPath, "utf-8").trim();
      if (token.length > 0) {
        return token;
      }
    } catch {
      // File exists but is unreadable — treat as no token
    }
  }

  return null;
}

/**
 * Ensure an auth token exists. Reads existing token or generates a new one.
 * Returns the token string.
 *
 * @param dataDir - Data directory (defaults to ~/.agent-orchestrator)
 */
export function ensureAuthToken(dataDir?: string): string {
  // Check env var first
  const envToken = process.env["AO_AUTH_TOKEN"];
  if (envToken && envToken.trim().length > 0) {
    return envToken.trim();
  }

  const dir = dataDir ?? getDefaultDataDir();
  const tokenPath = getAuthTokenPath(dir);

  // Try to read existing token
  if (existsSync(tokenPath)) {
    try {
      const token = readFileSync(tokenPath, "utf-8").trim();
      if (token.length > 0) {
        return token;
      }
    } catch {
      // Unreadable — regenerate
    }
  }

  // Generate new token
  const token = randomBytes(32).toString("hex");

  // Ensure data directory exists
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Write with restrictive permissions (owner-only read/write)
  writeFileSync(tokenPath, token + "\n", { mode: 0o600 });

  return token;
}
