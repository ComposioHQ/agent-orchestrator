import { describe, expect, it, vi } from "vitest";

import {
  CloudApiError,
  createCloudClient,
  createWorkerClient,
} from "../src/index.js";

const baseUrl = "https://cloud.example.com";

function jsonResponse(value: unknown = {}, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestOf(fetchMock: ReturnType<typeof vi.fn>, index = 0) {
  const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit];
  return { url, init, headers: new Headers(init.headers) };
}

describe("CloudClient", () => {
  it("keeps auth exchange unauthenticated and uncached", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ accessToken: "access", refreshToken: "refresh", expiresAt: "now" }),
    );
    const client = createCloudClient({
      baseUrl,
      getAccessToken: () => "must-not-be-read",
      fetch: fetchMock,
    });

    await client.exchangeGoogleIdentity({ idToken: "google-id" });

    const request = requestOf(fetchMock);
    expect(request.url).toBe(`${baseUrl}/api/cloud/v1/auth/google`);
    expect(request.init.method).toBe("POST");
    expect(request.init.cache).toBe("no-store");
    expect(request.headers.has("Authorization")).toBe(false);
    expect(JSON.parse(request.init.body as string)).toEqual({ idToken: "google-id" });
  });

  it("uses canonical /api/v1 paths and X-AO-Org only for product requests", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ projects: [] }));
    const client = createCloudClient({
      baseUrl,
      getAccessToken: () => "access-token",
      fetch: fetchMock,
    });

    await client.listProjects(" org-one ");
    await client.startGitHubInstallation("org-one");

    const app = requestOf(fetchMock, 0);
    expect(app.url).toBe(`${baseUrl}/api/v1/projects`);
    expect(app.headers.get("Authorization")).toBe("Bearer access-token");
    expect(app.headers.get("X-AO-Org")).toBe("org-one");

    const admin = requestOf(fetchMock, 1);
    expect(admin.url).toBe(
      `${baseUrl}/api/cloud/v1/orgs/org-one/github/installations/start`,
    );
    expect(admin.headers.get("Authorization")).toBe("Bearer access-token");
    expect(admin.headers.has("X-AO-Org")).toBe(false);
  });

  it("exposes asynchronous placement acceptance and polling, not synchronous project creation", async () => {
    const operation = {
      operationId: "placement-1",
      orgId: "org-one",
      state: "pending",
      defaultBranch: "main",
      createdAt: "2026-08-23T00:00:00Z",
      updatedAt: "2026-08-23T00:00:00Z",
    } as const;
    const fetchMock = vi.fn(async () => jsonResponse(operation, 202));
    const client = createCloudClient({
      baseUrl,
      getAccessToken: () => "access-token",
      fetch: fetchMock,
    });

    await client.createWorkspacePlacement(
      "org-one",
      {
        displayName: "AO",
        repositoryUrl: "https://github.com/aoagents/ao.git",
        defaultBranch: "main",
      },
      { idempotencyKey: "create-1" },
    );
    await client.getWorkspacePlacement("org-one", "placement-1");

    const create = requestOf(fetchMock, 0);
    expect(create.url).toBe(
      `${baseUrl}/api/cloud/v1/orgs/org-one/workspaces`,
    );
    expect(create.headers.get("Idempotency-Key")).toBe("create-1");
    expect(JSON.parse(create.init.body as string).defaultBranch).toBe("main");
    expect(requestOf(fetchMock, 1).url).toBe(
      `${baseUrl}/api/cloud/v1/orgs/org-one/workspaces/placement-1`,
    );
  });

  it("sends shared session operations through their canonical paths", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    const client = createCloudClient({
      baseUrl,
      getAccessToken: () => "access-token",
      fetch: fetchMock,
    });

    await client.listSessions("tenant blue", { project: "project/one", active: true });
    await client.sendSessionMessage(
      "tenant blue",
      "session/one",
      { message: "ship it" },
      { idempotencyKey: "message-1" },
    );
    await client.listSessionPullRequests("tenant blue", "session/one");
    await client.listSessionReviews("tenant blue", "session/one");

    expect(fetchMock.mock.calls.map((_, index) => requestOf(fetchMock, index).url)).toEqual([
      `${baseUrl}/api/v1/sessions?project=project%2Fone&active=true`,
      `${baseUrl}/api/v1/sessions/session%2Fone/send`,
      `${baseUrl}/api/v1/sessions/session%2Fone/pr`,
      `${baseUrl}/api/v1/sessions/session%2Fone/reviews`,
    ]);
    expect(requestOf(fetchMock, 1).headers.get("Idempotency-Key")).toBe("message-1");
    for (let index = 0; index < fetchMock.mock.calls.length; index += 1) {
      expect(requestOf(fetchMock, index).headers.get("X-AO-Org")).toBe("tenant blue");
    }
  });

  it("returns sandbox mux connection metadata without constructing a CP terminal URL", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          connectionUrl: "wss://sandbox.example.com/mux",
          ticket: "single-use",
          expiresAt: "2026-08-23T00:01:00Z",
          protocol: "ao.mux.v1",
        },
        201,
      ),
    );
    const client = createCloudClient({
      baseUrl,
      getAccessToken: () => "access-token",
      fetch: fetchMock,
    });

    const result = await client.createTerminalConnection(
      "org-one",
      "session-one",
      { kind: "agent", after: 10 },
      { idempotencyKey: "terminal-1" },
    );

    expect(result.connectionUrl).toBe("wss://sandbox.example.com/mux");
    const request = requestOf(fetchMock);
    expect(request.url).toBe(
      `${baseUrl}/api/v1/sessions/session-one/terminal-ticket`,
    );
    expect(request.init.cache).toBe("no-store");
  });

  it("surfaces canonical error codes and request IDs", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: "Forbidden",
          code: "ORG_FORBIDDEN",
          message: "wrong tenant",
          requestId: "request-42",
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    );
    const client = createCloudClient({
      baseUrl,
      getAccessToken: () => "access-token",
      fetch: fetchMock,
    });

    await expect(client.listProjects("org-one")).rejects.toMatchObject({
      status: 403,
      code: "ORG_FORBIDDEN",
      requestId: "request-42",
    } satisfies Partial<CloudApiError>);
  });
});

describe("WorkerClient", () => {
  it("uses the out-of-band capability for the ruled worker session paths", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    const client = createWorkerClient({
      baseUrl,
      getCapability: () => "file-capability",
      fetch: fetchMock,
    });

    await client.getStatus();
    await client.sendSessionMessage(
      "session/one",
      { message: "continue" },
      { idempotencyKey: "worker-message-1" },
    );
    await client.listSessionPullRequests("session/one");
    await client.listSessionReviews("session/one");

    expect(fetchMock.mock.calls.map((_, index) => requestOf(fetchMock, index).url)).toEqual([
      `${baseUrl}/api/cloud/v1/worker/status`,
      `${baseUrl}/api/cloud/v1/worker/sessions/session%2Fone/messages`,
      `${baseUrl}/api/cloud/v1/worker/sessions/session%2Fone/pull-requests`,
      `${baseUrl}/api/cloud/v1/worker/sessions/session%2Fone/reviews`,
    ]);
    for (let index = 0; index < fetchMock.mock.calls.length; index += 1) {
      expect(requestOf(fetchMock, index).headers.get("Authorization")).toBe(
        "Bearer file-capability",
      );
    }
  });

  it("models bootstrap and checkout as one-shot delivery state without credential JSON", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    const client = createWorkerClient({
      baseUrl,
      getCapability: () => "file-capability",
      fetch: fetchMock,
    });

    await client.acknowledgeBootstrap(
      { deliveryId: "delivery-1", version: "1.0.0", capabilities: ["send"] },
      { idempotencyKey: "bootstrap-1" },
    );
    await client.requestCheckoutGrant(
      { deliveryId: "delivery-2", repositoryId: "repo-1", operation: "clone" },
      { idempotencyKey: "checkout-1" },
    );

    const bootstrap = requestOf(fetchMock, 0);
    const checkout = requestOf(fetchMock, 1);
    expect(bootstrap.url).toBe(`${baseUrl}/api/cloud/v1/worker/bootstrap`);
    expect(checkout.url).toBe(`${baseUrl}/api/cloud/v1/worker/checkout-grant`);
    expect(bootstrap.init.cache).toBe("no-store");
    expect(checkout.init.cache).toBe("no-store");
    expect(bootstrap.init.body).not.toContain("file-capability");
    expect(checkout.init.body).not.toContain("file-capability");
    expect(bootstrap.headers.get("Idempotency-Key")).toBe("bootstrap-1");
    expect(checkout.headers.get("Idempotency-Key")).toBe("checkout-1");
  });

  it("fails closed when the capability file provider has no value", async () => {
    const client = createWorkerClient({
      baseUrl,
      getCapability: () => null,
      fetch: vi.fn(),
    });

    await expect(client.getStatus()).rejects.toMatchObject({
      status: 401,
      code: "AUTH_REQUIRED",
    } satisfies Partial<CloudApiError>);
  });
});
