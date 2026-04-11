import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import {
  getObservabilityBaseDir,
  getSessionsDir,
  loadConfig,
  readMetadataRaw,
  resolveProjectIdForSessionId,
} from "@composio/ao-core";

// Keep this in sync with server/tmux-utils.ts. terminal-auth is also imported
// through Next.js route bundling, where depending on the Node-targeted server
// module graph directly is awkward.
const VALID_SESSION_ID = /^[a-zA-Z0-9_-]+$/;

function validateSessionId(sessionId: string): boolean {
  return VALID_SESSION_ID.test(sessionId);
}

interface TerminalSessionRecord {
  sessionId: string;
  projectId: string;
  tmuxSessionName: string;
  ownerId: string;
}

interface TerminalTokenPayload {
  v: 1;
  purpose: "terminal_access";
  sessionId: string;
  projectId: string;
  tmuxSessionName: string;
  ownerId: string;
  iat: number;
  exp: number;
  nonce: string;
}

interface MuxConnectTokenPayload {
  v: 1;
  purpose: "mux_connect";
  iat: number;
  exp: number;
  nonce: string;
}

export interface MuxConnectGrant {
  token: string;
  expiresAt: string;
}

export interface TerminalAccessGrant extends TerminalSessionRecord {
  token: string;
  expiresAt: string;
}

export class TerminalAuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code:
      | "auth_required"
      | "invalid_session"
      | "session_not_found"
      | "ownership_denied"
      | "rate_limited"
      | "token_invalid"
      | "token_expired"
      | "config_unavailable",
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "TerminalAuthError";
  }
}

const TOKEN_TTL_MS = 60_000;
/** WebSocket /mux upgrade — long enough for reconnect backoff + idle tabs. */
const MUX_TOKEN_TTL_MS = 15 * 60_000;
const SECRET_FILE_NAME = "terminal-auth-secret";
const RATE_LIMIT_WINDOW_MS = 60_000;
const ISSUE_LIMIT = 20;
const VERIFY_LIMIT = 40;
const MUX_ISSUE_LIMIT = 120;
const RATE_LIMIT_PRUNE_THRESHOLD = 10_000;

const rateLimits = new Map<string, { count: number; resetAt: number }>();

let cachedContext:
  | {
      configPath: string;
      secret: Buffer;
      config: ReturnType<typeof loadConfig>;
    }
  | undefined;

export function resetTerminalAuthStateForTests(): void {
  cachedContext = undefined;
  rateLimits.clear();
}

function getLocalOwnerId(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env["USER"] ?? process.env["USERNAME"] ?? "unknown";
  }
}

function pruneExpiredRateLimits(now: number): void {
  if (rateLimits.size <= RATE_LIMIT_PRUNE_THRESHOLD) {
    return;
  }
  for (const [k, v] of rateLimits) {
    if (v.resetAt <= now) {
      rateLimits.delete(k);
    }
  }
}

function enforceRateLimit(key: string, limit: number): void {
  const now = Date.now();
  pruneExpiredRateLimits(now);
  const current = rateLimits.get(key);

  if (!current || current.resetAt <= now) {
    rateLimits.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return;
  }

  if (current.count >= limit) {
    throw new TerminalAuthError(
      "Too many terminal authorization attempts",
      429,
      "rate_limited",
      Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    );
  }

  current.count += 1;
}

function getContext() {
  const configPath = process.env["AO_CONFIG_PATH"];
  try {
    const config = loadConfig(configPath);
    if (cachedContext?.configPath === config.configPath) {
      return cachedContext;
    }

    const secretDir = getObservabilityBaseDir(config.configPath);
    mkdirSync(secretDir, { recursive: true, mode: 0o700 });
    const secretPath = join(secretDir, SECRET_FILE_NAME);

    let secret: Buffer;
    try {
      secret = Buffer.from(readFileSync(secretPath, "utf-8").trim(), "utf-8");
      if (secret.length === 0) throw new Error("empty secret");
      try {
        chmodSync(secretPath, 0o600);
      } catch {
        /* best-effort */
      }
    } catch {
      const generated = randomBytes(32).toString("hex");
      writeFileSync(secretPath, `${generated}\n`, { encoding: "utf-8", mode: 0o600 });
      try {
        chmodSync(secretPath, 0o600);
      } catch {
        /* best-effort */
      }
      secret = Buffer.from(generated, "utf-8");
    }

    const context = { configPath: config.configPath, secret, config };
    cachedContext = context;
    return context;
  } catch (error) {
    throw new TerminalAuthError(
      error instanceof Error ? error.message : "Terminal authorization is unavailable",
      503,
      "config_unavailable",
    );
  }
}

function getSessionRecord(sessionId: string): TerminalSessionRecord {
  if (!validateSessionId(sessionId)) {
    throw new TerminalAuthError("Invalid session ID", 400, "invalid_session");
  }

  const { config } = getContext();
  const projectId = resolveProjectIdForSessionId(config, sessionId);
  if (!projectId) {
    throw new TerminalAuthError("Session not found", 404, "session_not_found");
  }

  const project = config.projects[projectId];
  if (!project) {
    throw new TerminalAuthError("Session not found", 404, "session_not_found");
  }

  const raw = readMetadataRaw(getSessionsDir(config.configPath, project.path), sessionId);
  if (!raw) {
    throw new TerminalAuthError("Session not found", 404, "session_not_found");
  }

  const tmuxSessionName = raw["tmuxName"]?.trim() || sessionId;
  const ownerId = raw["ownerId"]?.trim() || getLocalOwnerId();

  return { sessionId, projectId, tmuxSessionName, ownerId };
}

function encodePayload(payload: TerminalTokenPayload | MuxConnectTokenPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
}

function signPayload(encodedPayload: string, secret: Buffer): string {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

/**
 * Verify HMAC and return parsed JSON. Caller validates shape and purpose.
 */
function verifySignedTokenJson(
  token: string | undefined,
  secret: Buffer,
  missingMessage: string,
  invalidTokenMessage = "Invalid terminal token",
): unknown {
  if (typeof token !== "string" || token.length === 0) {
    throw new TerminalAuthError(missingMessage, 401, "auth_required");
  }

  const [encodedPayload, providedSignature] = token.split(".");
  if (!encodedPayload || !providedSignature) {
    throw new TerminalAuthError(missingMessage, 401, "auth_required");
  }

  const expectedSignature = signPayload(encodedPayload, secret);
  const provided = Buffer.from(providedSignature, "utf-8");
  const expected = Buffer.from(expectedSignature, "utf-8");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new TerminalAuthError(invalidTokenMessage, 401, "token_invalid");
  }

  try {
    return JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf-8"));
  } catch {
    throw new TerminalAuthError(invalidTokenMessage, 401, "token_invalid");
  }
}

function decodePayload(token: string | undefined, secret: Buffer): TerminalTokenPayload {
  const parsed = verifySignedTokenJson(token, secret, "Missing terminal token");
  return parsed as TerminalTokenPayload;
}

/**
 * Issue a short-lived token required on the `/mux` WebSocket upgrade URL.
 * Proves the client reached the dashboard API before opening a raw TCP connection to the mux port.
 */
export function issueMuxConnectToken(): MuxConnectGrant {
  getContext();
  enforceRateLimit("mux_issue", MUX_ISSUE_LIMIT);

  const { secret } = getContext();
  const now = Date.now();
  const exp = now + MUX_TOKEN_TTL_MS;

  const payload: MuxConnectTokenPayload = {
    v: 1,
    purpose: "mux_connect",
    iat: now,
    exp,
    nonce: randomBytes(8).toString("hex"),
  };

  const encodedPayload = encodePayload(payload);
  const token = `${encodedPayload}.${signPayload(encodedPayload, secret)}`;

  return {
    token,
    expiresAt: new Date(exp).toISOString(),
  };
}

/**
 * Validates a mux upgrade token (query `token`). Used by the direct terminal HTTP server.
 */
export function verifyMuxConnectToken(token: string | null | undefined): void {
  const { secret } = getContext();
  const parsed = verifySignedTokenJson(
    token ?? undefined,
    secret,
    "Missing mux token",
    "Invalid mux token",
  ) as Record<string, unknown>;

  if (parsed["v"] !== 1 || parsed["purpose"] !== "mux_connect") {
    throw new TerminalAuthError("Invalid mux token", 401, "token_invalid");
  }
  const exp = parsed["exp"];
  if (typeof exp !== "number" || exp <= Date.now()) {
    throw new TerminalAuthError("Mux token expired", 401, "token_expired");
  }
}

export function issueTerminalAccess(sessionId: string): TerminalAccessGrant {
  const record = getSessionRecord(sessionId);
  enforceRateLimit(`issue:${sessionId}`, ISSUE_LIMIT);

  const { secret } = getContext();
  const now = Date.now();
  const expiresAt = new Date(now + TOKEN_TTL_MS);

  const payload: TerminalTokenPayload = {
    v: 1,
    purpose: "terminal_access",
    sessionId: record.sessionId,
    projectId: record.projectId,
    tmuxSessionName: record.tmuxSessionName,
    ownerId: record.ownerId,
    iat: now,
    exp: expiresAt.getTime(),
    nonce: randomBytes(8).toString("hex"),
  };

  const encodedPayload = encodePayload(payload);
  const token = `${encodedPayload}.${signPayload(encodedPayload, secret)}`;

  return {
    ...record,
    token,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Verify a short-lived terminal access token and return **current** session metadata.
 *
 * Re-reads metadata from disk after validating the token. Only `sessionId` and
 * `projectId` must match the signed payload — `tmuxSessionName` and `ownerId` may
 * change between issuance and verification (lifecycle updates) without revoking
 * the grant; the returned record always reflects on-disk state for attach/hooks.
 */
export function verifyTerminalAccess(sessionId: string, token: string | undefined): TerminalSessionRecord {
  const { secret } = getContext();
  const payload = decodePayload(token, secret);

  if (payload.sessionId !== sessionId) {
    throw new TerminalAuthError("Terminal token does not match this session", 403, "ownership_denied");
  }

  const record = getSessionRecord(sessionId);
  enforceRateLimit(`verify:${sessionId}`, VERIFY_LIMIT);

  if (payload.purpose !== "terminal_access" || payload.v !== 1) {
    throw new TerminalAuthError("Invalid terminal token", 401, "token_invalid");
  }
  if (payload.exp <= Date.now()) {
    throw new TerminalAuthError("Terminal token expired", 401, "token_expired");
  }
  if (payload.sessionId !== sessionId || payload.sessionId !== record.sessionId) {
    throw new TerminalAuthError("Terminal token does not match this session", 403, "ownership_denied");
  }
  if (payload.projectId !== record.projectId) {
    throw new TerminalAuthError("Terminal access denied", 403, "ownership_denied");
  }

  return record;
}
