import * as crypto from "node:crypto";
import type { OrchestratorConfig } from "@composio/ao-core";
import { getCachedConfig } from "./config-cache";
import { getCorrelationId, jsonWithCorrelation, recordApiObservation } from "./observability";

type AuthContext = {
  config?: OrchestratorConfig;
  correlationId?: string;
  method?: string;
  path?: string;
  startedAt?: number;
  projectId?: string;
  sessionId?: string;
  data?: Record<string, unknown>;
};

function unauthorized(request: Request, context?: AuthContext): Response {
  const correlationId = context?.correlationId ?? getCorrelationId(request);

  if (
    context?.config &&
    context.method &&
    context.path &&
    context.startedAt !== undefined
  ) {
    recordApiObservation({
      config: context.config,
      method: context.method,
      path: context.path,
      correlationId,
      startedAt: context.startedAt,
      outcome: "failure",
      statusCode: 401,
      projectId: context.projectId,
      sessionId: context.sessionId,
      reason: "Unauthorized",
      data: context.data,
    });
  }

  return jsonWithCorrelation({ error: "Unauthorized" }, { status: 401 }, correlationId);
}

function tokensMatch(providedToken: string, expectedToken: string): boolean {
  const providedDigest = crypto.createHash("sha256").update(providedToken, "utf8").digest();
  const expectedDigest = crypto.createHash("sha256").update(expectedToken, "utf8").digest();
  return crypto.timingSafeEqual(providedDigest, expectedDigest);
}

export function checkAuth(
  request: Request,
  token: string | undefined,
  context?: AuthContext,
): Response | null {
  if (token === undefined) return null;

  const normalizedToken = token.trim();
  if (normalizedToken.length === 0) {
    return unauthorized(request, context);
  }

  const header = request.headers.get("authorization");
  if (!header) {
    return unauthorized(request, context);
  }

  const match = /^\s*Bearer\s+(.+?)\s*$/i.exec(header);
  if (!match || !tokensMatch(match[1], normalizedToken)) {
    return unauthorized(request, context);
  }

  return null;
}

export function checkConfiguredAuth(request: Request, context?: Omit<AuthContext, "config">): Response | null {
  const config = getCachedConfig();
  return checkAuth(request, config.api?.token, { ...context, config });
}
