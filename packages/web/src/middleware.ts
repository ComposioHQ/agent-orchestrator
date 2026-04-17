import { type NextRequest, NextResponse } from "next/server";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isAllowedOrigin(request: NextRequest): boolean {
  // Same-origin guard: reject cross-site mutating requests.
  // Next.js exposes the resolved host via request.nextUrl.host.
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  const expectedHost = request.nextUrl.host;

  // Allow requests with no origin/referer only if they come from a matching host header
  // (curl, CLI clients). Browsers always send origin on cross-site fetches.
  if (!origin && !referer) {
    const hostHeader = request.headers.get("host");
    return hostHeader === expectedHost;
  }
  const candidate = origin ?? referer;
  if (!candidate) return false;
  try {
    return new URL(candidate).host === expectedHost;
  } catch {
    return false;
  }
}

export function middleware(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;

  if (pathname.startsWith("/api/") && MUTATING_METHODS.has(request.method)) {
    if (!isAllowedOrigin(request)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  // Legacy: /?project=all → /
  // Legacy: /?project=<id> → /projects/<id>
  if (pathname === "/" && searchParams.has("project")) {
    const project = searchParams.get("project");
    if (project && project !== "all") {
      const url = request.nextUrl.clone();
      url.pathname = `/projects/${encodeURIComponent(project)}`;
      url.searchParams.delete("project");
      return NextResponse.redirect(url);
    }
    if (project === "all") {
      const url = request.nextUrl.clone();
      url.searchParams.delete("project");
      return NextResponse.redirect(url);
    }
  }

  // Legacy: /sessions/[id] → /projects/[projectId]/sessions/[id]
  // Try to resolve project from the session's projectId query param, otherwise
  // redirect to the API which will resolve it.
  const sessionMatch = pathname.match(/^\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    const sessionId = sessionMatch[1];
    const projectId = searchParams.get("project");
    if (projectId) {
      const url = request.nextUrl.clone();
      url.pathname = `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`;
      url.searchParams.delete("project");
      return NextResponse.redirect(url);
    }
    // No project context — let the old route handle it (still works)
    return NextResponse.next();
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/sessions/:path*", "/api/:path*"],
};
