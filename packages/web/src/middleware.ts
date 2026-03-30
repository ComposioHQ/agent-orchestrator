import { type NextRequest, NextResponse } from "next/server";

export function middleware(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;

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
  matcher: ["/", "/sessions/:path*"],
};
