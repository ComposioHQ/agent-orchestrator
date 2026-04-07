import { type NextRequest, NextResponse } from "next/server";
import { TerminalAuthError, issueTerminalAccess } from "@/lib/server/terminal-auth";

export const dynamic = "force-dynamic";

function normalizePort(input: string | undefined, fallback: number): string {
  const parsed = Number.parseInt(input ?? "", 10);
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
    return String(parsed);
  }
  return String(fallback);
}

function normalizeProxyPath(input: string | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  return trimmed;
}

function getRequestProtocol(request: NextRequest): string {
  return request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.replace(":", "");
}

function buildTerminalUrl(request: NextRequest, terminalPort: string, sessionId: string): string {
  const protocol = getRequestProtocol(request);
  const hostHeader = request.headers.get("host") ?? request.nextUrl.host;
  const hostname = hostHeader.split(":")[0];
  return `${protocol}://${hostname}:${terminalPort}/terminal/${encodeURIComponent(sessionId)}/`;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const grant = issueTerminalAccess({ sessionId: id, headers: request.headers });
    const terminalPort = normalizePort(process.env.TERMINAL_PORT, 14800);
    const directTerminalPort = normalizePort(process.env.DIRECT_TERMINAL_PORT, 14801);
    const proxyWsPath = normalizeProxyPath(
      process.env.TERMINAL_WS_PATH ?? process.env.NEXT_PUBLIC_TERMINAL_WS_PATH,
    );

    const response = NextResponse.json(
      {
        sessionId: grant.sessionId,
        expiresAt: grant.expiresAt,
        terminalUrl: buildTerminalUrl(request, terminalPort, grant.sessionId),
        terminalPort,
        directTerminalPort,
        proxyWsPath,
      },
      { headers: { "Cache-Control": "no-store" } },
    );

    response.cookies.set({
      name: grant.cookieName,
      value: grant.token,
      httpOnly: true,
      sameSite: "lax",
      secure: getRequestProtocol(request) === "https",
      maxAge: 60,
      path: "/",
    });

    return response;
  } catch (error) {
    const authError =
      error instanceof TerminalAuthError
        ? error
        : new TerminalAuthError(
            error instanceof Error ? error.message : "Terminal authorization failed",
            503,
            "config_unavailable",
          );

    const response = NextResponse.json({ error: authError.message }, { status: authError.statusCode });
    if (authError.retryAfterSeconds !== undefined) {
      response.headers.set("Retry-After", String(authError.retryAfterSeconds));
    }
    return response;
  }
}
