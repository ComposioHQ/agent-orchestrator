import { withAuth } from "@workos-inc/authkit-nextjs";
import { NextRequest, NextResponse } from "next/server";

import {
  cloudApiBaseUrl,
  cloudWebMode,
  localAuthCookie,
} from "@/lib/cloud-config";

const localEntryPaths = new Set([
  "auth/local/login",
  "auth/local/register",
]);

type RouteContext = {
  params: Promise<{ path: string[] }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  return forward(request, context);
}

export async function POST(request: NextRequest, context: RouteContext) {
  return forward(request, context);
}

async function forward(request: NextRequest, context: RouteContext) {
  const origin = request.headers.get("origin");
  if (
    request.method !== "GET" &&
    request.method !== "HEAD" &&
    origin &&
    origin !== request.nextUrl.origin
  ) {
    return NextResponse.json(
      { code: "INVALID_ORIGIN", message: "Cross-origin requests are rejected." },
      { status: 403 },
    );
  }

  const { path: segments } = await context.params;
  const path = segments.join("/");
  if (!path || segments.some((segment) => segment === "." || segment === "..")) {
    return NextResponse.json(
      { code: "INVALID_REQUEST", message: "Invalid Cloud API path." },
      { status: 400 },
    );
  }

  const mode = cloudWebMode();
  let accessToken: string | undefined;
  if (mode === "local") {
    accessToken = request.cookies.get(localAuthCookie)?.value;
  } else {
    const auth = await withAuth();
    accessToken = auth.user ? auth.accessToken : undefined;
  }

  const isLocalEntry = mode === "local" && localEntryPaths.has(path);
  if (!isLocalEntry && !accessToken) {
    return NextResponse.json(
      {
        error: "Unauthorized",
        code: "AUTH_REQUIRED",
        message: "Sign in to continue.",
        requestId: "",
      },
      { status: 401 },
    );
  }

  const upstreamUrl = new URL(
    `/api/cloud/v1/${path}${request.nextUrl.search}`,
    cloudApiBaseUrl(),
  );
  const headers = new Headers();
  headers.set("Accept", request.headers.get("accept") || "application/json");
  const contentType = request.headers.get("content-type");
  const idempotencyKey = request.headers.get("idempotency-key");
  if (contentType) headers.set("Content-Type", contentType);
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: request.method,
      headers,
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.arrayBuffer(),
      cache: "no-store",
      signal: request.signal,
    });
  } catch {
    return NextResponse.json(
      {
        error: "Bad Gateway",
        code: "CLOUD_API_UNAVAILABLE",
        message: "The Cloud API is unavailable.",
        requestId: "",
      },
      { status: 502 },
    );
  }

  if (isLocalEntry && upstream.ok) {
    const payload = (await upstream.json()) as {
      token?: string;
      expiresAt?: string;
      [key: string]: unknown;
    };
    const token = payload.token;
    delete payload.token;
    if (!token) {
      return NextResponse.json(
        {
          error: "Invalid Response",
          code: "INVALID_RESPONSE",
          message: "Local authentication returned no session token.",
          requestId: "",
        },
        { status: 502 },
      );
    }
    const response = NextResponse.json(payload, { status: upstream.status });
    response.cookies.set(localAuthCookie, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      path: "/",
      expires: payload.expiresAt
        ? new Date(payload.expiresAt)
        : new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    return response;
  }

  const responseHeaders = new Headers();
  for (const name of [
    "cache-control",
    "content-type",
    "retry-after",
    "x-request-id",
    "x-accel-buffering",
  ]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  const response = new NextResponse(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
  if (mode === "local" && path === "auth/local/logout" && upstream.ok) {
    response.cookies.delete(localAuthCookie);
  }
  return response;
}
