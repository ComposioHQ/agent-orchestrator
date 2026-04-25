import { NextResponse, type NextRequest } from "next/server";
import { issueTerminalAccess, TerminalAuthError } from "@/lib/server/terminal-auth";
import { normalizePort } from "@/lib/terminal-config";

export const dynamic = "force-dynamic";

function getRequestProtocol(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded === "https" || forwarded === "http") {
    return forwarded;
  }
  return request.nextUrl.protocol.replace(/:$/, "") || "http";
}

function getRequestHostname(request: NextRequest): string {
  const forwardedHost = request.headers.get("x-forwarded-host");
  const host = forwardedHost ?? request.headers.get("host") ?? request.nextUrl.host;
  return host.replace(/:\d+$/, "");
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  try {
    const grant = issueTerminalAccess(id);
    const terminalPort = normalizePort(process.env.TERMINAL_PORT, 14800);
    const protocol = getRequestProtocol(request);
    const hostname = getRequestHostname(request);
    // Return the ttyd URL with the session identifier in the query string. The access
    // token is returned separately in this JSON payload and is not embedded in `url`.
    const url =
      `${protocol}://${hostname}:${terminalPort}/terminal` +
      `?session=${encodeURIComponent(grant.sessionId)}`;

    return NextResponse.json(
      {
        sessionId: grant.sessionId,
        projectId: grant.projectId,
        token: grant.token,
        expiresAt: grant.expiresAt,
        url,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof TerminalAuthError) {
      const headers: Record<string, string> = { "Cache-Control": "no-store" };
      if (error.retryAfterSeconds !== undefined) {
        headers["Retry-After"] = String(error.retryAfterSeconds);
      }
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.statusCode, headers },
      );
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to authorize terminal access" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
