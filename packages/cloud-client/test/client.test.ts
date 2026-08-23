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

describe("CloudClient control plane", () => {
  it("keeps auth exchange unauthenticated and uncached", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ accessToken: "access", refreshToken: "refresh", expiresAt: "now" }),
    );
    const client = createCloudClient({ baseUrl, getAccessToken: () => "unused", fetch: fetchMock });

    await client.exchangeGoogleIdentity({ idToken: "google-id" });

    const request = requestOf(fetchMock);
    expect(request.url).toBe(`${baseUrl}/api/cloud/v1/auth/google`);
    expect(request.init.cache).toBe("no-store");
    expect(request.headers.has("Authorization")).toBe(false);
  });

  it("uses the exact asynchronous workspace collection and lifecycle paths", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ workspaces: [], pageInfo: { hasMore: false } }, 202),
    );
    const client = createCloudClient({ baseUrl, getAccessToken: () => "access", fetch: fetchMock });

    await client.listWorkspacePlacements("org-one", { cursor: "next page", limit: 25 });
    await client.createWorkspacePlacement(
      "org-one",
      {},
      { idempotencyKey: "create-1" },
    );
    await client.getWorkspacePlacement("org-one", "workspace/one");
    await client.deleteWorkspacePlacement("org-one", "workspace/one", { idempotencyKey: "delete-1" });
    await client.resumeWorkspacePlacement("org-one", "workspace/one", { idempotencyKey: "resume-1" });

    expect(fetchMock.mock.calls.map((_, i) => requestOf(fetchMock, i).url)).toEqual([
      `${baseUrl}/api/cloud/v1/orgs/org-one/workspaces?cursor=next+page&limit=25`,
      `${baseUrl}/api/cloud/v1/orgs/org-one/workspaces`,
      `${baseUrl}/api/cloud/v1/orgs/org-one/workspaces/workspace%2Fone`,
      `${baseUrl}/api/cloud/v1/orgs/org-one/workspaces/workspace%2Fone`,
      `${baseUrl}/api/cloud/v1/orgs/org-one/workspaces/workspace%2Fone/resume`,
    ]);
    expect(requestOf(fetchMock, 1).headers.get("Idempotency-Key")).toBe("create-1");
    expect(requestOf(fetchMock, 3).headers.get("Idempotency-Key")).toBe("delete-1");
    expect(requestOf(fetchMock, 4).headers.get("Idempotency-Key")).toBe("resume-1");
    for (let i = 0; i < fetchMock.mock.calls.length; i += 1) {
      expect(requestOf(fetchMock, i).headers.has("X-AO-Org")).toBe(false);
    }
  });

  it("uses the complete canonical GitHub administration route set", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/installations")) return jsonResponse({ installations: [] });
      if (url.includes("/repositories") || url.endsWith("/sync")) {
        return jsonResponse({ repositories: [] });
      }
      if (url.endsWith("/disconnect")) return jsonResponse(undefined, 204);
      return jsonResponse({ installUrl: "https://github.com/apps/ao/installations/new", expiresAt: "now" }, 201);
    });
    const client = createCloudClient({ baseUrl, getAccessToken: () => "access", fetch: fetchMock });

    await client.listGitHubInstallations("org-one");
    await client.startGitHubInstallation("org-one");
    await client.listGitHubRepositories("org-one", "installation-one");
    await client.setGitHubRepositoryAllowlist(
      "org-one",
      "installation-one",
      { repositories: ["ao/ao"] },
    );
    await client.syncGitHubInstallation("org-one", "installation-one", { idempotencyKey: "sync-1" });
    await client.disconnectGitHubInstallation("org-one", "installation-one");

    expect(fetchMock.mock.calls.map((_, i) => requestOf(fetchMock, i).url)).toEqual([
      `${baseUrl}/api/cloud/v1/orgs/org-one/github/installations`,
      `${baseUrl}/api/cloud/v1/orgs/org-one/github/installations/start`,
      `${baseUrl}/api/cloud/v1/orgs/org-one/github/installations/installation-one/repositories`,
      `${baseUrl}/api/cloud/v1/orgs/org-one/github/installations/installation-one/repositories`,
      `${baseUrl}/api/cloud/v1/orgs/org-one/github/installations/installation-one/sync`,
      `${baseUrl}/api/cloud/v1/orgs/org-one/github/installations/installation-one/disconnect`,
    ]);
  });

  it("keeps vault administration path-scoped and returns only redacted metadata", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "DELETE") return jsonResponse(undefined, 204);
      if (url.endsWith("/provider-connections")) return jsonResponse({ providerConnections: [] });
      return jsonResponse({ providerConnection: { provider: "codex", configured: true, updatedAt: "now" } });
    });
    const client = createCloudClient({ baseUrl, getAccessToken: () => "access", fetch: fetchMock });

    await client.listProviderConnections("org-one");
    await client.putAgentProviderConnection(
      "org-one",
      "codex",
      { credential: "admin-supplied" },
      { idempotencyKey: "vault-put" },
    );
    await client.deleteAgentProviderConnection("org-one", "codex", { idempotencyKey: "vault-delete" });

    expect(fetchMock.mock.calls.map((_, i) => requestOf(fetchMock, i).url)).toEqual([
      `${baseUrl}/api/cloud/v1/orgs/org-one/provider-connections`,
      `${baseUrl}/api/cloud/v1/orgs/org-one/provider-connections/agents/codex`,
      `${baseUrl}/api/cloud/v1/orgs/org-one/provider-connections/agents/codex`,
    ]);
  });

  it("issues one-time direct sandbox mux tickets from the org session path", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        connectionUrl: "wss://sandbox.example.com/mux",
        ticket: "ao.ticket.opaque",
        scopes: ["terminal:read"],
        expiresAt: "2026-08-23T20:00:00Z",
        protocol: "ao.mux.v1",
      }, 201),
    );
    const client = createCloudClient({ baseUrl, getAccessToken: () => "access", fetch: fetchMock });

    const ticket = await client.createTerminalTicket(
      "org-one",
      "session-one",
      { scopes: ["terminal:read"] },
      { idempotencyKey: "ticket-1" },
    );

    expect(ticket.ticket).toMatch(/^ao\.ticket\./u);
    expect(requestOf(fetchMock).url).toBe(
      `${baseUrl}/api/cloud/v1/orgs/org-one/sessions/session-one/terminal-ticket`,
    );
    expect(requestOf(fetchMock).init.cache).toBe("no-store");
  });
});

describe("WorkerClient control plane", () => {
  it("uses the exact complete worker session route set", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes("/messages?") || url.endsWith("/messages")) {
        return jsonResponse({ messages: [], pageInfo: { hasMore: false } });
      }
      if (url.endsWith("/pr")) return jsonResponse({ pullRequests: [] });
      if (url.endsWith("/reviews")) return jsonResponse({ reviews: [] });
      if (url.endsWith("/sessions?cursor=next&limit=10")) {
        return jsonResponse({ sessions: [], pageInfo: { hasMore: false } });
      }
      return jsonResponse({});
    });
    const client = createWorkerClient({ baseUrl, getCapability: () => "capability", fetch: fetchMock });

    await client.getStatus();
    await client.listSessions({ cursor: "next", limit: 10 });
    await client.createSession(
      { projectId: "project-one", role: "worker", harness: "codex" },
      { idempotencyKey: "session-create" },
    );
    await client.getSession("session/one");
    await client.deleteSession("session/one", { idempotencyKey: "session-delete" });
    await client.listMessages("session/one", { cursor: "message-next", limit: 20 });
    await client.sendMessage("session/one", { message: "continue" }, { idempotencyKey: "message-1" });
    await client.claimPullRequest(
      "session/one",
      { url: "https://github.com/ao/ao/pull/1" },
    );
    await client.listPullRequests("session/one");
    await client.listReviews("session/one");
    await client.submitReview(
      "session/one",
      { verdict: "approve", summary: "looks good" },
    );

    expect(fetchMock.mock.calls.map((_, i) => requestOf(fetchMock, i).url)).toEqual([
      `${baseUrl}/api/cloud/v1/worker/status`,
      `${baseUrl}/api/cloud/v1/worker/sessions?cursor=next&limit=10`,
      `${baseUrl}/api/cloud/v1/worker/sessions`,
      `${baseUrl}/api/cloud/v1/worker/sessions/session%2Fone`,
      `${baseUrl}/api/cloud/v1/worker/sessions/session%2Fone`,
      `${baseUrl}/api/cloud/v1/worker/sessions/session%2Fone/messages?cursor=message-next&limit=20`,
      `${baseUrl}/api/cloud/v1/worker/sessions/session%2Fone/messages`,
      `${baseUrl}/api/cloud/v1/worker/sessions/session%2Fone/pr/claim`,
      `${baseUrl}/api/cloud/v1/worker/sessions/session%2Fone/pr`,
      `${baseUrl}/api/cloud/v1/worker/sessions/session%2Fone/reviews`,
      `${baseUrl}/api/cloud/v1/worker/sessions/session%2Fone/reviews/submit`,
    ]);
  });

  it("keeps lifecycle, turn, and non-terminal transport callbacks", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/turns/claim")) return jsonResponse({ turn: null });
      if (url.endsWith("/transport/claim")) return jsonResponse({ request: null });
      return jsonResponse({ ok: true, alreadyFinished: false, requested: false });
    });
    const client = createWorkerClient({ baseUrl, getCapability: () => "capability", fetch: fetchMock });

    await client.publishEvent({ type: "worker.ready", payload: {} });
    await client.claimTurn();
    await client.getTurnCancellation("turn-one", 2);
    await client.completeTurn("turn-one", { attempt: 2 });
    await client.failTurn("turn-one", { attempt: 2, error: "failed" });
    await client.claimTransport();
    await client.completeTransport("request-one", { attempt: 1, response: {} });
    await client.failTransport("request-one", { attempt: 1, code: "FAILED", message: "failed" });

    expect(fetchMock.mock.calls.map((_, i) => requestOf(fetchMock, i).url)).toEqual([
      `${baseUrl}/api/cloud/v1/worker/events`,
      `${baseUrl}/api/cloud/v1/worker/turns/claim`,
      `${baseUrl}/api/cloud/v1/worker/turns/turn-one/cancellation?attempt=2`,
      `${baseUrl}/api/cloud/v1/worker/turns/turn-one/complete`,
      `${baseUrl}/api/cloud/v1/worker/turns/turn-one/fail`,
      `${baseUrl}/api/cloud/v1/worker/transport/claim`,
      `${baseUrl}/api/cloud/v1/worker/transport/request-one/complete`,
      `${baseUrl}/api/cloud/v1/worker/transport/request-one/fail`,
    ]);
  });

  it("redeems terminal tickets atomically with the out-of-band capability", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        sandboxId: "sandbox-one",
        workspaceId: "workspace-one",
        sessionId: "session-one",
        scopes: ["terminal:read"],
        expiresAt: "2026-08-23T20:00:00Z",
      }),
    );
    const client = createWorkerClient({ baseUrl, getCapability: () => "file-capability", fetch: fetchMock });

    await client.consumeTerminalTicket({
      ticket: "ao.ticket.opaque",
      sandboxId: "sandbox-one",
      workspaceId: "workspace-one",
      sessionId: "session-one",
    });

    const request = requestOf(fetchMock);
    expect(request.url).toBe(`${baseUrl}/api/cloud/v1/sandbox/terminal-tickets/consume`);
    expect(request.headers.get("Authorization")).toBe("Bearer file-capability");
    expect(request.init.cache).toBe("no-store");
  });

  it("never obtains a raw sandbox bearer from an API response", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    const client = createWorkerClient({ baseUrl, getCapability: () => "file-capability", fetch: fetchMock });

    await client.acknowledgeBootstrap(
      { deliveryId: "delivery-one", version: "1.0.0", capabilities: [] },
      { idempotencyKey: "bootstrap-1" },
    );
    await client.requestCheckoutGrant(
      { deliveryId: "delivery-two", repositoryId: "repo-one", operation: "clone" },
      { idempotencyKey: "checkout-1" },
    );

    expect(requestOf(fetchMock, 0).init.body).not.toContain("file-capability");
    expect(requestOf(fetchMock, 1).init.body).not.toContain("file-capability");
  });

  it("fails closed without the capability file value", async () => {
    const client = createWorkerClient({ baseUrl, getCapability: () => null, fetch: vi.fn() });
    await expect(client.getStatus()).rejects.toMatchObject({
      status: 401,
      code: "AUTH_REQUIRED",
    } satisfies Partial<CloudApiError>);
  });
});
