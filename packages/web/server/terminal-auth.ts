import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { join } from "node:path";
import {
  createCorrelationId,
  createProjectObserver,
  getObservabilityBaseDir,
  getSessionsDir,
  loadConfig,
  readMetadataRaw,
  resolveOwnerIdentity,
  resolveProjectIdForSessionId,
  updateMetadata,
  type OrchestratorConfig,
  type ProjectObserver,
} from "@composio/ao-core";
import { validateSessionId } from "./tmux-utils.js";

type HeaderSource = Headers | IncomingHttpHeaders | Record<string, string | string[] | undefined>;

interface RateLimitState {
  count: number;
  resetAt: number;
}

interface TerminalActor {
  actorId: string;
  actorSource: string;
  clientIp: string;
}

interface TerminalSessionRecord {
  sessionId: string;
  projectId: string;
  ownerId: string;
  ownerSource: string;
  tmuxSessionName: string;
}

interface TerminalTokenPayload {
  v: 1;
  purpose: "terminal_access";
  sessionId: string;
  projectId: string;
  ownerId: string;
  actorId: string;
  iat: number;
  exp: number;
  nonce: string;
}

export interface TerminalAccessGrant extends TerminalSessionRecord {
  actorId: string;
  actorSource: string;
  expiresAt: string;
  token: string;
  cookieName: string;
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

const ISSUE_LIMIT = { max: 20, windowMs: 60_000 };
const ISSUE_SESSION_LIMIT = { max: 8, windowMs: 60_000 };
const CONNECT_LIMIT = { max: 30, windowMs: 60_000 };
const CONNECT_SESSION_LIMIT = { max: 15, windowMs: 60_000 };
const FAILURE_LIMIT = { max: 12, windowMs: 60_000 };
const TOKEN_TTL_MS = 60_000;
const SECRET_FILE_NAME = "terminal-auth-secret";
const COOKIE_PREFIX = "ao_terminal_";
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 60_000; // Clean expired entries every minute

const rateLimiters = new Map<string, RateLimitState>();

let cachedContext:
  | {
      config: OrchestratorConfig;
      observer: ProjectObserver;
      secret: string;
    }
  | undefined;

let cleanupInterval: NodeJS.Timeout | undefined;

function startRateLimitCleanup(): void {
  if (cleanupInterval !== undefined) {
    return; // Already running
  }

  cleanupInterval = setInterval(() => {
    const now = Date.now();
    let removed = 0;
    for (const [key, state] of rateLimiters.entries()) {
      if (state.resetAt <= now) {
        rateLimiters.delete(key);
        removed++;
      }
    }
    if (removed > 0) {
      // Silence in production; useful for debugging
    }
  }, RATE_LIMIT_CLEANUP_INTERVAL_MS);

  // Ensure cleanup doesn't prevent process exit
  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }
}

export function resetTerminalAuthStateForTests(): void {
  cachedContext = undefined;
  rateLimiters.clear();
  if (cleanupInterval !== undefined) {
    clearInterval(cleanupInterval);
    cleanupInterval = undefined;
  }
}

function getHeaderValue(headers: HeaderSource, name: string): string | undefined {
  if (headers instanceof Headers) {
    const value = headers.get(name);
    return value === null ? undefined : value;
  }

  const raw = headers[name.toLowerCase()];
  if (Array.isArray(raw)) {
    return raw[0];
  }
  return raw;
}

function getAuthContext(): { config: OrchestratorConfig; observer: ProjectObserver; secret: string } {
  if (cachedContext) {
    return cachedContext;
  }

  // Start periodic cleanup of expired rate limit entries (lazy initialization)
  startRateLimitCleanup();

  const config = loadConfig();
  const observer = createProjectObserver(config, "terminal-auth");
  const secretDir = getObservabilityBaseDir(config.configPath);
  mkdirSync(secretDir, { recursive: true });
  const secretPath = join(secretDir, SECRET_FILE_NAME);
  const readSecret = (): string | undefined => {
    try {
      const value = readFileSync(secretPath, "utf-8").trim();
      return value.length > 0 ? value : undefined;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  };

  const existingSecret = readSecret();
  if (existingSecret) {
    cachedContext = { config, observer, secret: existingSecret };
    return cachedContext;
  }

  const generatedSecret = randomBytes(32).toString("base64url");
  try {
    // Use an exclusive write to avoid cross-process TOCTOU races during initialization.
    writeFileSync(secretPath, `${generatedSecret}\n`, {
      encoding: "utf-8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") {
      throw error;
    }
  }

  const secret = readSecret();
  if (!secret) {
    throw new Error("Terminal auth secret file is empty");
  }

  cachedContext = { config, observer, secret };
  return cachedContext;
}

function resolveFallbackActor(): { actorId: string; actorSource: string } {
  const actor = resolveOwnerIdentity();
  return { actorId: actor.id, actorSource: actor.source };
}

function shouldTrustProxyHeaders(): boolean {
  return process.env["AO_TRUST_PROXY_HEADERS"]?.trim().toLowerCase() === "true";
}

function getTrustedProxyIdentity(
  headers: HeaderSource,
): { actorId: string; actorSource: string } | undefined {
  const proxyIdentityHeaders = [
    ["x-forwarded-user", "header:x-forwarded-user"],
    ["x-auth-request-user", "header:x-auth-request-user"],
    ["x-remote-user", "header:x-remote-user"],
  ] as const;

  for (const [headerName, source] of proxyIdentityHeaders) {
    const value = getHeaderValue(headers, headerName)?.trim();
    if (value) {
      return { actorId: value, actorSource: source };
    }
  }

  return undefined;
}

function resolveActor(headers: HeaderSource, remoteAddress?: string): TerminalActor {
  const trustProxyHeaders = shouldTrustProxyHeaders();
  const proxyIdentity = trustProxyHeaders ? getTrustedProxyIdentity(headers) : undefined;

  const forwardedFor = trustProxyHeaders
    ? getHeaderValue(headers, "x-forwarded-for")
        ?.split(",")[0]
        ?.trim()
    : undefined;
  const clientIp =
    forwardedFor ||
    (trustProxyHeaders ? getHeaderValue(headers, "x-real-ip")?.trim() : undefined) ||
    remoteAddress ||
    "unknown";

  if (proxyIdentity) {
    return {
      actorId: proxyIdentity.actorId,
      actorSource: proxyIdentity.actorSource,
      clientIp,
    };
  }

  const fallback = resolveFallbackActor();
  return {
    actorId: fallback.actorId,
    actorSource: fallback.actorSource,
    clientIp,
  };
}

function getTerminalCookieName(sessionId: string): string {
  return `${COOKIE_PREFIX}${sessionId}`;
}

function consumeRateLimit(
  scope: string,
  key: string,
  limit: { max: number; windowMs: number },
): void {
  const now = Date.now();
  const compositeKey = `${scope}:${key}`;
  const state = rateLimiters.get(compositeKey);

  if (!state || state.resetAt <= now) {
    rateLimiters.set(compositeKey, { count: 1, resetAt: now + limit.windowMs });
    return;
  }

  if (state.count >= limit.max) {
    throw new TerminalAuthError(
      "Terminal access rate limit exceeded",
      429,
      "rate_limited",
      Math.max(1, Math.ceil((state.resetAt - now) / 1000)),
    );
  }

  state.count += 1;
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) {
    return {};
  }

  return header.split(";").reduce<Record<string, string>>((cookies, part) => {
    const [name, ...valueParts] = part.trim().split("=");
    if (!name || valueParts.length === 0) {
      return cookies;
    }

    const rawValue = valueParts.join("=");
    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch {
      cookies[name] = rawValue;
    }
    return cookies;
  }, {});
}

function recordAuthEvent(input: {
  surface: "issue" | "attach";
  outcome: "success" | "failure";
  sessionId?: string;
  projectId?: string;
  actorId?: string;
  ownerId?: string;
  reason?: string;
  statusCode?: number;
}): void {
  let context: { config: OrchestratorConfig; observer: ProjectObserver; secret: string };
  try {
    context = getAuthContext();
  } catch {
    return;
  }

  context.observer.recordOperation({
    metric: input.surface === "issue" ? "api_request" : input.outcome === "success" ? "websocket_connect" : "websocket_error",
    operation: input.surface === "issue" ? "terminal.auth.issue" : "terminal.auth.attach",
    outcome: input.outcome,
    correlationId: createCorrelationId("terminal-auth"),
    projectId: input.projectId,
    sessionId: input.sessionId,
    reason: input.reason,
    data: {
      actorId: input.actorId,
      ownerId: input.ownerId,
      statusCode: input.statusCode,
    },
    level: input.outcome === "failure" ? "warn" : "info",
  });
}

function getLegacyOwner(): { ownerId: string; ownerSource: string } {
  const fallback = resolveFallbackActor();
  return {
    ownerId: fallback.actorId,
    ownerSource: `legacy:${fallback.actorSource}`,
  };
}

function resolveSessionRecord(sessionId: string): TerminalSessionRecord {
  let context: { config: OrchestratorConfig; observer: ProjectObserver; secret: string };
  try {
    context = getAuthContext();
  } catch (error) {
    throw new TerminalAuthError(
      error instanceof Error ? error.message : "Terminal config unavailable",
      503,
      "config_unavailable",
    );
  }

  const projectId = resolveProjectIdForSessionId(context.config, sessionId);
  if (!projectId) {
    throw new TerminalAuthError("Session not found", 404, "session_not_found");
  }

  const project = context.config.projects[projectId];
  const sessionsDir = getSessionsDir(context.config.configPath, project.path);
  const metadata = readMetadataRaw(sessionsDir, sessionId);

  if (!metadata) {
    throw new TerminalAuthError("Session not found", 404, "session_not_found");
  }

  const ownerId = metadata["ownerId"]?.trim();
  const ownerSource = metadata["ownerSource"]?.trim();
  const legacyOwner = getLegacyOwner();
  const resolvedOwnerId = ownerId || legacyOwner.ownerId;
  const resolvedOwnerSource = ownerSource || legacyOwner.ownerSource;

  if (!ownerId) {
    updateMetadata(sessionsDir, sessionId, {
      ownerId: resolvedOwnerId,
      ownerSource: resolvedOwnerSource,
    });
  }

  return {
    sessionId,
    projectId,
    ownerId: resolvedOwnerId,
    ownerSource: resolvedOwnerSource,
    tmuxSessionName: metadata["tmuxName"]?.trim() || sessionId,
  };
}

function toBase64Url(value: string): string {
  return Buffer.from(value, "utf-8").toString("base64url");
}

function fromBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf-8");
}

function signPayload(payloadBase64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadBase64).digest("base64url");
}

function encodeToken(payload: TerminalTokenPayload, secret: string): string {
  const payloadBase64 = toBase64Url(JSON.stringify(payload));
  return `${payloadBase64}.${signPayload(payloadBase64, secret)}`;
}

function assertTerminalTokenPayload(record: Record<string, unknown>): TerminalTokenPayload {
  // Validate each field; this conversion is safe because we've already checked all types above
  return {
    v: record["v"] as 1,
    purpose: record["purpose"] as "terminal_access",
    sessionId: record["sessionId"] as string,
    projectId: record["projectId"] as string,
    ownerId: record["ownerId"] as string,
    actorId: record["actorId"] as string,
    iat: record["iat"] as number,
    exp: record["exp"] as number,
    nonce: record["nonce"] as string,
  };
}

function decodeAndVerifyToken(token: string, secret: string): TerminalTokenPayload {
  const [payloadBase64, signature] = token.split(".");
  if (!payloadBase64 || !signature) {
    throw new TerminalAuthError("Invalid terminal token", 401, "token_invalid");
  }

  const expectedSignature = signPayload(payloadBase64, secret);
  const actual = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new TerminalAuthError("Invalid terminal token", 401, "token_invalid");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(payloadBase64));
  } catch {
    throw new TerminalAuthError("Invalid terminal token", 401, "token_invalid");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new TerminalAuthError("Invalid terminal token", 401, "token_invalid");
  }

  const tokenRecord = parsed as Record<string, unknown>;
  if (
    tokenRecord["v"] !== 1 ||
    tokenRecord["purpose"] !== "terminal_access" ||
    typeof tokenRecord["sessionId"] !== "string" ||
    typeof tokenRecord["projectId"] !== "string" ||
    typeof tokenRecord["ownerId"] !== "string" ||
    typeof tokenRecord["actorId"] !== "string" ||
    typeof tokenRecord["iat"] !== "number" ||
    typeof tokenRecord["exp"] !== "number" ||
    typeof tokenRecord["nonce"] !== "string"
  ) {
    throw new TerminalAuthError("Invalid terminal token", 401, "token_invalid");
  }

  const payload = assertTerminalTokenPayload(tokenRecord);
  if (payload.exp <= Date.now()) {
    throw new TerminalAuthError("Terminal token expired", 401, "token_expired");
  }

  return payload;
}

export function issueTerminalAccess(input: {
  sessionId: string;
  headers: HeaderSource;
  remoteAddress?: string;
}): TerminalAccessGrant {
  if (!validateSessionId(input.sessionId)) {
    throw new TerminalAuthError("Invalid session ID", 400, "invalid_session");
  }

  const actor = resolveActor(input.headers, input.remoteAddress);
  consumeRateLimit("issue:actor", `${actor.actorId}:${actor.clientIp}`, ISSUE_LIMIT);
  consumeRateLimit("issue:session", `${actor.actorId}:${input.sessionId}`, ISSUE_SESSION_LIMIT);

  const session = resolveSessionRecord(input.sessionId);
  if (session.ownerId !== actor.actorId) {
    recordAuthEvent({
      surface: "issue",
      outcome: "failure",
      sessionId: session.sessionId,
      projectId: session.projectId,
      actorId: actor.actorId,
      ownerId: session.ownerId,
      reason: "ownership_denied",
      statusCode: 403,
    });
    throw new TerminalAuthError("Session ownership denied", 403, "ownership_denied");
  }

  const { secret } = getAuthContext();
  const now = Date.now();
  const payload: TerminalTokenPayload = {
    v: 1,
    purpose: "terminal_access",
    sessionId: session.sessionId,
    projectId: session.projectId,
    ownerId: session.ownerId,
    actorId: actor.actorId,
    iat: now,
    exp: now + TOKEN_TTL_MS,
    nonce: randomBytes(12).toString("base64url"),
  };

  const token = encodeToken(payload, secret);
  recordAuthEvent({
    surface: "issue",
    outcome: "success",
    sessionId: session.sessionId,
    projectId: session.projectId,
    actorId: actor.actorId,
    ownerId: session.ownerId,
  });

  return {
    ...session,
    actorId: actor.actorId,
    actorSource: actor.actorSource,
    expiresAt: new Date(payload.exp).toISOString(),
    token,
    cookieName: getTerminalCookieName(session.sessionId),
  };
}

export function verifyTerminalAccess(input: {
  sessionId: string;
  headers: HeaderSource;
  remoteAddress?: string;
}): TerminalSessionRecord & { actorId: string; actorSource: string } {
  return verifyTerminalAccessInternal(input, { consumeRateLimits: true });
}

/**
 * Verify terminal access without consuming connection rate-limit tokens.
 *
 * Used for HTTP proxied requests to ttyd static assets (CSS, JS, favicon, etc.)
 * which are already authenticated via the httpOnly token cookie. Connection
 * rate limits should only apply to initial WebSocket upgrades and new connection
 * attempts, not to subsequent authenticated requests.
 *
 * Still validates the session and token, and records auth events for observability.
 */
export function verifyTerminalAccessNoRateLimit(input: {
  sessionId: string;
  headers: HeaderSource;
  remoteAddress?: string;
}): TerminalSessionRecord & { actorId: string; actorSource: string } {
  return verifyTerminalAccessInternal(input, { consumeRateLimits: false });
}

function verifyTerminalAccessInternal(
  input: {
    sessionId: string;
    headers: HeaderSource;
    remoteAddress?: string;
  },
  options: { consumeRateLimits: boolean },
): TerminalSessionRecord & { actorId: string; actorSource: string } {
  if (!validateSessionId(input.sessionId)) {
    if (options.consumeRateLimits) {
      consumeRateLimit("failure:session", input.remoteAddress ?? "unknown", FAILURE_LIMIT);
    }
    throw new TerminalAuthError("Invalid session ID", 400, "invalid_session");
  }

  const actor = resolveActor(input.headers, input.remoteAddress);
  if (options.consumeRateLimits) {
    consumeRateLimit("connect:actor", `${actor.actorId}:${actor.clientIp}`, CONNECT_LIMIT);
    consumeRateLimit("connect:session", `${actor.actorId}:${input.sessionId}`, CONNECT_SESSION_LIMIT);
  }

  const session = resolveSessionRecord(input.sessionId);
  const cookieHeader = getHeaderValue(input.headers, "cookie");
  const cookies = parseCookies(cookieHeader);
  const cookieToken = cookies[getTerminalCookieName(input.sessionId)];

  if (!cookieToken) {
    if (options.consumeRateLimits) {
      consumeRateLimit("failure:token", `${actor.clientIp}:${input.sessionId}`, FAILURE_LIMIT);
    }
    recordAuthEvent({
      surface: "attach",
      outcome: "failure",
      sessionId: session.sessionId,
      projectId: session.projectId,
      actorId: actor.actorId,
      ownerId: session.ownerId,
      reason: "auth_required",
      statusCode: 401,
    });
    throw new TerminalAuthError("Missing terminal token", 401, "auth_required");
  }

  const { secret } = getAuthContext();
  const payload = decodeAndVerifyToken(cookieToken, secret);

  if (
    payload.sessionId !== session.sessionId ||
    payload.projectId !== session.projectId ||
    payload.ownerId !== session.ownerId ||
    payload.actorId !== actor.actorId
  ) {
    if (options.consumeRateLimits) {
      consumeRateLimit("failure:mismatch", `${actor.clientIp}:${input.sessionId}`, FAILURE_LIMIT);
    }
    recordAuthEvent({
      surface: "attach",
      outcome: "failure",
      sessionId: session.sessionId,
      projectId: session.projectId,
      actorId: actor.actorId,
      ownerId: session.ownerId,
      reason: "token_invalid",
      statusCode: 401,
    });
    throw new TerminalAuthError("Invalid terminal token", 401, "token_invalid");
  }

  recordAuthEvent({
    surface: "attach",
    outcome: "success",
    sessionId: session.sessionId,
    projectId: session.projectId,
    actorId: actor.actorId,
    ownerId: session.ownerId,
  });

  return {
    ...session,
    actorId: actor.actorId,
    actorSource: actor.actorSource,
  };
}
