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

  // Legacy: /sessions/[id]?project=<id> → /sessions/[id]
  // Keep the canonical session route and strip the stale project context.
  const sessionMatch = pathname.match(/^\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    if (searchParams.has("project")) {
      const url = request.nextUrl.clone();
      url.searchParams.delete("project");
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/sessions/:path*"],
};
