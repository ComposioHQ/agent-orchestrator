import { withAuth } from "@workos-inc/authkit-nextjs";
import { NextRequest, NextResponse } from "next/server";

import {
  cloudApiBaseUrl,
  cloudWebMode,
  githubApiBaseUrl,
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
  const githubRoute = parseGitHubRoute(segments);
  let environmentAccessToken: string | undefined;
  let workosAccessToken: string | undefined;
  if (mode === "local") {
    environmentAccessToken = request.cookies.get(localAuthCookie)?.value;
    if (githubRoute) {
      const auth = await withAuth();
      workosAccessToken = auth.user ? auth.accessToken : undefined;
    }
  } else {
    const auth = await withAuth();
    environmentAccessToken = auth.user ? auth.accessToken : undefined;
    workosAccessToken = environmentAccessToken;
  }

  const isLocalEntry = mode === "local" && localEntryPaths.has(path);
  if (!isLocalEntry && !environmentAccessToken) {
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
  if (githubRoute && !workosAccessToken) {
    return NextResponse.json(
      {
        error: "GitHub authentication required",
        code: "GITHUB_AUTH_REQUIRED",
        message: "Connect your hosted AO account to manage GitHub access.",
        requestId: "",
      },
      { status: 401 },
    );
  }

  if (
    githubRoute &&
    environmentAccessToken &&
    workosAccessToken
  ) {
    return forwardGitHub(
      request,
      githubRoute,
      environmentAccessToken,
      workosAccessToken,
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
  if (environmentAccessToken) {
    headers.set("Authorization", `Bearer ${environmentAccessToken}`);
  }

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

type GitHubRoute = {
  localOrganizationId: string;
  suffix: string;
};

type AccountOrganization = {
  id: string;
  slug: string;
};

type CurrentAccountResponse = {
  organizations: AccountOrganization[];
};

type GitHubRepositoryResponse = {
  githubRepositoryId: string;
  name: string;
  htmlUrl: string;
  defaultBranch: string;
  access: "active" | "revoked";
};

function parseGitHubRoute(segments: string[]): GitHubRoute | null {
  if (
    segments.length < 4 ||
    segments[0] !== "orgs" ||
    segments[2] !== "github"
  ) {
    return null;
  }
  return {
    localOrganizationId: segments[1],
    suffix: segments.slice(3).join("/"),
  };
}

async function forwardGitHub(
  request: NextRequest,
  route: GitHubRoute,
  environmentAccessToken: string,
  workosAccessToken: string,
): Promise<Response> {
  const productionOrganization = await resolveProductionOrganization(
    request,
    route.localOrganizationId,
    environmentAccessToken,
    workosAccessToken,
  );
  if (productionOrganization instanceof Response) {
    return productionOrganization;
  }

  const productionURL = new URL(
    `/api/cloud/v1/orgs/${encodeURIComponent(productionOrganization)}/github/${route.suffix}${request.nextUrl.search}`,
    githubApiBaseUrl(),
  );
  const headers = forwardedHeaders(request, workosAccessToken);

  if (request.method === "POST" && route.suffix === "projects") {
    return createEnvironmentProjectFromGitHub(
      request,
      route.localOrganizationId,
      productionOrganization,
      environmentAccessToken,
      workosAccessToken,
    );
  }

  try {
    const upstream = await fetch(productionURL, {
      method: request.method,
      headers,
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.arrayBuffer(),
      cache: "no-store",
      signal: request.signal,
    });
    return upstreamResponse(upstream);
  } catch {
    return gatewayError("The production GitHub service is unavailable.");
  }
}

async function resolveProductionOrganization(
  request: NextRequest,
  localOrganizationId: string,
  environmentAccessToken: string,
  workosAccessToken: string,
): Promise<string | Response> {
  let productionAccountResponse: Response;
  try {
    productionAccountResponse = await fetch(
      new URL("/api/cloud/v1/me", githubApiBaseUrl()),
      {
        headers: forwardedHeaders(request, workosAccessToken),
        cache: "no-store",
        signal: request.signal,
      },
    );
  } catch {
    return gatewayError("The production GitHub service is unavailable.");
  }
  if (!productionAccountResponse.ok) {
    return upstreamResponse(productionAccountResponse);
  }
  const productionAccount =
    (await productionAccountResponse.json()) as CurrentAccountResponse;
  if (productionAccount.organizations.length === 0) {
    return NextResponse.json(
      {
        error: "GitHub organization unavailable",
        code: "GITHUB_ORGANIZATION_UNAVAILABLE",
        message:
          "Your hosted AO account has no organization available for GitHub.",
        requestId: "",
      },
      { status: 409 },
    );
  }

  if (cloudWebMode() === "local") {
    return productionAccount.organizations[0].id;
  }

  let environmentAccountResponse: Response;
  try {
    environmentAccountResponse = await fetch(
      new URL("/api/cloud/v1/me", cloudApiBaseUrl()),
      {
        headers: forwardedHeaders(request, environmentAccessToken),
        cache: "no-store",
        signal: request.signal,
      },
    );
  } catch {
    return gatewayError("The Cloud API is unavailable.");
  }
  if (!environmentAccountResponse.ok) {
    return upstreamResponse(environmentAccountResponse);
  }
  const environmentAccount =
    (await environmentAccountResponse.json()) as CurrentAccountResponse;
  const localOrganization = environmentAccount.organizations.find(
    ({ id }) => id === localOrganizationId,
  );
  if (!localOrganization) {
    return NextResponse.json(
      {
        error: "Organization not found",
        code: "NOT_FOUND",
        message: "The selected organization is unavailable.",
        requestId: "",
      },
      { status: 404 },
    );
  }
  const matchingOrganization = productionAccount.organizations.find(
    ({ slug }) => slug === localOrganization.slug,
  );
  if (matchingOrganization) {
    return matchingOrganization.id;
  }
  if (productionAccount.organizations.length === 1) {
    return productionAccount.organizations[0].id;
  }
  return NextResponse.json(
    {
      error: "GitHub organization mismatch",
      code: "GITHUB_ORGANIZATION_MISMATCH",
      message:
        "The selected organization could not be matched to your production GitHub connection.",
      requestId: "",
    },
    { status: 409 },
  );
}

async function createEnvironmentProjectFromGitHub(
  request: NextRequest,
  localOrganizationId: string,
  productionOrganizationId: string,
  environmentAccessToken: string,
  workosAccessToken: string,
): Promise<Response> {
  let input: {
    githubRepositoryId?: string;
    displayName?: string;
    config?: Record<string, unknown>;
  };
  try {
    input = (await request.json()) as typeof input;
  } catch {
    return NextResponse.json(
      {
        error: "Invalid request",
        code: "INVALID_REQUEST",
        message: "The request body is invalid.",
        requestId: "",
      },
      { status: 400 },
    );
  }
  const repositoryID = input.githubRepositoryId?.trim();
  if (!repositoryID) {
    return NextResponse.json(
      {
        error: "Validation failed",
        code: "VALIDATION_ERROR",
        message: "A GitHub repository is required.",
        requestId: "",
      },
      { status: 422 },
    );
  }

  let repositoriesResponse: Response;
  try {
    repositoriesResponse = await fetch(
      new URL(
        `/api/cloud/v1/orgs/${encodeURIComponent(productionOrganizationId)}/github/repositories?limit=100`,
        githubApiBaseUrl(),
      ),
      {
        headers: forwardedHeaders(request, workosAccessToken),
        cache: "no-store",
        signal: request.signal,
      },
    );
  } catch {
    return gatewayError("The production GitHub service is unavailable.");
  }
  if (!repositoriesResponse.ok) {
    return upstreamResponse(repositoriesResponse);
  }
  const repositoryPage = (await repositoriesResponse.json()) as {
    items: GitHubRepositoryResponse[];
  };
  const repository = repositoryPage.items.find(
    (item) =>
      item.githubRepositoryId === repositoryID && item.access === "active",
  );
  if (!repository) {
    return NextResponse.json(
      {
        error: "Repository unavailable",
        code: "GITHUB_REPOSITORY_UNAVAILABLE",
        message: "The selected repository is not actively granted to this account.",
        requestId: "",
      },
      { status: 403 },
    );
  }

  const projectURL = new URL(
    `/api/cloud/v1/orgs/${encodeURIComponent(localOrganizationId)}/projects`,
    cloudApiBaseUrl(),
  );
  let projectResponse: Response;
  try {
    projectResponse = await fetch(projectURL, {
      method: "POST",
      headers: forwardedHeaders(request, environmentAccessToken),
      body: JSON.stringify({
        displayName: input.displayName?.trim() || repository.name,
        repositoryUrl: repository.htmlUrl,
        defaultBranch: repository.defaultBranch,
        githubRepositoryId: repository.githubRepositoryId,
        config: input.config ?? {},
      }),
      cache: "no-store",
      signal: request.signal,
    });
  } catch {
    return gatewayError("The Cloud API is unavailable.");
  }
  return upstreamResponse(projectResponse);
}

function forwardedHeaders(
  request: NextRequest,
  accessToken: string,
): Headers {
  const headers = new Headers();
  headers.set("Accept", request.headers.get("accept") || "application/json");
  headers.set("Authorization", `Bearer ${accessToken}`);
  const contentType = request.headers.get("content-type");
  const idempotencyKey = request.headers.get("idempotency-key");
  if (contentType) headers.set("Content-Type", contentType);
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
  return headers;
}

function upstreamResponse(upstream: Response): Response {
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
  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

function gatewayError(message: string): Response {
  return NextResponse.json(
    {
      error: "Bad Gateway",
      code: "CLOUD_API_UNAVAILABLE",
      message,
      requestId: "",
    },
    { status: 502 },
  );
}
