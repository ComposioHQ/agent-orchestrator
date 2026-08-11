import { describe, expect, it, vi } from "vitest";

import {
  CloudApiError,
  createCloudClient,
  type AgentProfile,
  type ClientEvent,
  type PullRequestSummary,
  type SessionReviewState,
} from "../src/index.js";

describe("CloudClient", () => {
  it("lists runtime-supplied agent profiles for an organization", async () => {
    const profile: AgentProfile = {
      id: "runtime-agent",
      label: "Runtime Agent",
      capabilities: ["interface.chat", "model.custom"],
      availability: {
        available: false,
        installation: "installed",
        authentication: "unauthorized",
        organizationPolicy: "denied",
        reason: "Disabled for this organization.",
      },
    };
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ agents: [profile] }),
    );
    const client = createCloudClient({
      baseUrl: "https://cloud.example.com",
      getAccessToken: () => "access-token",
      fetch: fetchMock as typeof fetch,
    });

    await expect(client.listAgents("tenant one/blue")).resolves.toEqual([
      profile,
    ]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://cloud.example.com/api/cloud/v1/orgs/tenant%20one%2Fblue/agents",
    );
  });

  it("manages organization-scoped GitHub App installations and repositories", async () => {
    const installation = {
      id: "d9916dbe-486c-43ec-91b8-379419767719",
      githubInstallationId: 12345,
      accountLogin: "acme",
      accountType: "Organization",
      status: "active",
      repositorySelection: "selected",
      syncStatus: "ready",
      createdAt: "2026-08-11T00:00:00Z",
      updatedAt: "2026-08-11T00:00:00Z",
    } as const;
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse({ installations: [installation] }))
      .mockResolvedValueOnce(
        jsonResponse({
          installationUrl: "https://github.com/apps/ao/installations/new",
          expiresAt: "2026-08-11T00:10:00Z",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [],
          page: { hasMore: false },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ installation }))
      .mockResolvedValueOnce(jsonResponse({ project: { id: "project-1" } }));
    const client = createCloudClient({
      baseUrl: "https://cloud.example.com",
      getAccessToken: () => "access-token",
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      client.listGitHubInstallations("tenant one"),
    ).resolves.toEqual([installation]);
    await client.startGitHubInstallation("tenant one");
    await client.listGitHubRepositories("tenant one", {
      cursor: "next page",
      limit: 25,
    });
    await client.syncGitHubInstallation(
      "tenant one",
      "d9916dbe-486c-43ec-91b8-379419767719",
    );
    await client.createProjectFromGitHub(
      "tenant one",
      { githubRepositoryId: 98765 },
      { idempotencyKey: "github-project-1" },
    );

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "https://cloud.example.com/api/cloud/v1/orgs/tenant%20one/github/installations",
      "https://cloud.example.com/api/cloud/v1/orgs/tenant%20one/github/installations/start",
      "https://cloud.example.com/api/cloud/v1/orgs/tenant%20one/github/repositories?cursor=next+page&limit=25",
      "https://cloud.example.com/api/cloud/v1/orgs/tenant%20one/github/installations/d9916dbe-486c-43ec-91b8-379419767719/sync",
      "https://cloud.example.com/api/cloud/v1/orgs/tenant%20one/github/projects",
    ]);
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("POST");
    expect(fetchMock.mock.calls[3]?.[1]?.method).toBe("POST");
    expect(requestHeaders(fetchMock, 4).get("Idempotency-Key")).toBe(
      "github-project-1",
    );
  });

  it("scopes and encodes organization and session URLs", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ session: {} }),
    );
    const client = createCloudClient({
      baseUrl: "https://cloud.example.com/",
      getAccessToken: () => "access-token",
      fetch: fetchMock as typeof fetch,
    });

    await client.getSession("tenant one/blue", "session one?");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://cloud.example.com/api/cloud/v1/orgs/tenant%20one%2Fblue/sessions/session%20one%3F",
    );
  });

  it("reads normalized pull requests and AO review state for a session", async () => {
    const pullRequest = {
      url: "github://o/r/pull/7",
      number: 7,
      title: "Cloud contract",
      state: "open",
      provider: "github",
      repository: "o/r",
      author: "alice",
      sourceBranch: "feat/cloud",
      targetBranch: "main",
      headSha: "current-sha",
      additions: 12,
      deletions: 3,
      changedFiles: 2,
      ci: { state: "passing", failingChecks: [] },
      review: {
        decision: "approved",
        hasUnresolvedHumanComments: false,
        unresolvedBy: [],
        reviews: [],
      },
      mergeability: {
        state: "mergeable",
        reasons: [],
        pullRequestUrl: "https://github.com/o/r/pull/7",
        conflictFiles: [],
      },
      updatedAt: "2026-08-09T12:00:00Z",
      observedAt: "2026-08-09T12:00:01Z",
      ciObservedAt: "2026-08-09T12:00:02Z",
      reviewObservedAt: "2026-08-09T12:00:03Z",
    } satisfies PullRequestSummary;
    const reviewState = {
      sessionId: "session one?",
      reviews: [
        {
          pullRequestUrl: pullRequest.url,
          pullRequestNumber: 7,
          title: pullRequest.title,
          targetSha: "current-sha",
          staleTargetSha: "stale-sha",
          status: "needs_review",
        },
      ],
      runs: [],
    } satisfies SessionReviewState;
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        jsonResponse({
          sessionId: "session one?",
          pullRequests: [pullRequest],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(reviewState));
    const client = createCloudClient({
      baseUrl: "https://cloud.example.com",
      getAccessToken: () => "access-token",
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      client.listSessionPullRequests("tenant", "session one?"),
    ).resolves.toEqual({
      sessionId: "session one?",
      pullRequests: [pullRequest],
    });
    await expect(
      client.getSessionReviewState("tenant", "session one?"),
    ).resolves.toEqual(reviewState);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "https://cloud.example.com/api/cloud/v1/orgs/tenant/sessions/session%20one%3F/pull-requests",
      "https://cloud.example.com/api/cloud/v1/orgs/tenant/sessions/session%20one%3F/reviews",
    ]);
  });

  it("injects the latest access token into every request", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ providerConnections: [] }),
    );
    const getAccessToken = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("first-token")
      .mockResolvedValueOnce("second-token");
    const client = createCloudClient({
      baseUrl: "https://cloud.example.com",
      getAccessToken,
      fetch: fetchMock as typeof fetch,
    });

    await client.listProviderConnections("tenant");
    await client.listProviderConnections("tenant");

    expect(getAccessToken).toHaveBeenCalledTimes(2);
    expect(requestHeaders(fetchMock, 0).get("Authorization")).toBe(
      "Bearer first-token",
    );
    expect(requestHeaders(fetchMock, 1).get("Authorization")).toBe(
      "Bearer second-token",
    );
  });

  it("throws a typed error with the standard error envelope", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse(
          {
            error: "Conflict",
            code: "IDEMPOTENCY_CONFLICT",
            message: "That key was used for a different command.",
            requestId: "request-123",
            details: { field: "Idempotency-Key" },
          },
          409,
        ),
    );
    const client = createCloudClient({
      baseUrl: "https://cloud.example.com",
      getAccessToken: () => "access-token",
      fetch: fetchMock as typeof fetch,
    });

    const request = client.sendMessage("tenant", "session", "Hello", {
      idempotencyKey: "message-1",
    });

    const error: unknown = await request.catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(CloudApiError);
    expect(error).toMatchObject({
      name: "CloudApiError",
      status: 409,
      code: "IDEMPOTENCY_CONFLICT",
      requestId: "request-123",
      details: { field: "Idempotency-Key" },
    });
  });

  it("passes the replay cursor and page limit", async () => {
    const event: ClientEvent = {
      sessionId: "session",
      sequence: 42,
      type: "chat.assistant_delta",
      payload: { text: "Hello" },
      createdAt: "2026-08-09T00:00:00Z",
    };
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ events: [event], hasMore: true, nextAfter: 42 }),
    );
    const client = createCloudClient({
      baseUrl: "https://cloud.example.com",
      getAccessToken: () => "access-token",
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      client.replayEvents("tenant", "session", { after: 41, limit: 25 }),
    ).resolves.toEqual({
      events: [event],
      hasMore: true,
      nextAfter: 42,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://cloud.example.com/api/cloud/v1/orgs/tenant/sessions/session/chat-events?after=41&limit=25",
    );
  });

  it("sends idempotency keys on mutating commands", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({
          event: {
            sessionId: "session",
            sequence: 1,
            type: "chat.user_message",
            payload: { text: "Ship it" },
            createdAt: "2026-08-09T00:00:00Z",
          },
        }),
    );
    const client = createCloudClient({
      baseUrl: "https://cloud.example.com",
      getAccessToken: () => "access-token",
      fetch: fetchMock as typeof fetch,
    });

    await client.sendMessage("tenant", "session", "Ship it", {
      idempotencyKey: "message-command-1",
    });

    expect(requestHeaders(fetchMock, 0).get("Idempotency-Key")).toBe(
      "message-command-1",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ text: "Ship it" }),
    });
  });

  it("streams replayed SSE events from an explicit cursor", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'id: 8\nevent: chat.assistant_delta\ndata: {"sessionId":"session","sequence":8,',
          ),
        );
        controller.enqueue(
          encoder.encode(
            '"type":"chat.assistant_delta","payload":{"text":"Hi"},"createdAt":"2026-08-09T00:00:00Z"}\n\n',
          ),
        );
        controller.close();
      },
    });
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(body, { status: 200 }),
    );
    const client = createCloudClient({
      baseUrl: "https://cloud.example.com",
      getAccessToken: () => "access-token",
      fetch: fetchMock as typeof fetch,
    });

    const events: ClientEvent[] = [];
    for await (const event of client.streamEvents("tenant", "session", {
      after: 7,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({
        sequence: 8,
        type: "chat.assistant_delta",
        payload: { text: "Hi" },
      }),
    ]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://cloud.example.com/api/cloud/v1/orgs/tenant/sessions/session/events?after=7",
    );
    expect(requestHeaders(fetchMock, 0).get("Accept")).toBe(
      "text/event-stream",
    );
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestHeaders(
  fetchMock: ReturnType<typeof vi.fn>,
  call: number,
): Headers {
  return new Headers((fetchMock.mock.calls[call]?.[1] as RequestInit).headers);
}
